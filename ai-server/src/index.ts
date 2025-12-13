import express from "express";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import axios from "axios";
import config from "./config";
import outboundCallRouter from "./routes/outbound-call";
import { downsample24kHzTo8kHz, pcmToMulaw, chunkAudio, normalizePcm, boostBeforeMulaw } from "./pipeline/audio";
import { createDeepgramClient } from "./pipeline/stt";
import { generateAssistantReply, type CallContext, maybeUpdateSummaryForCall, detectPartyType, classifyReceiver } from "./pipeline/llm";
import * as humanDetection from "./pipeline/humanDetection";
import { synthesizeSpeech, stopSpeaking, hangupCall, sendDtmf } from "./pipeline/tts";
import * as contextMgr from "./callContextManager";
import { upsertCall, safeUpdateStatus, updateCall, isSupabaseConfigured, insertTranscriptSegment, uploadCustomCallRecording } from "./utils/supabase";
import * as sharedState from "./sharedState";
import {
  createMulawStereoWav,
  concatTrack,
  getBufferedSize,
  isCustomRecordingEnabled,
  getCustomRecordingMaxBytes,
} from "./pipeline/recording";
import * as ivrUtils from "./pipeline/ivr";
import * as observer from "./routes/observe";
import { smoothAudio, clearSmootherState } from "./pipeline/audio-smoother";

// Call control settings are now in config.callControl
// TTS_DEBOUNCE_MS, BARGE_IN_COOLDOWN_MS, CALLER_UTTERANCE_FLUSH_MS, HANGUP_DELAY_MS

// -----------------------------------------------------------------------------
// CLIENTS
// -----------------------------------------------------------------------------
const deepgram = createDeepgramClient();

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

/**
 * Result of parsing an LLM response for speech and behavior.
 */
interface ParsedLlmResponse {
  /** Text to be spoken via TTS (null if behavior is wait/noop/hold/dtmf) */
  speakText: string | null;
  /** Behavior directive: "speak" | "wait" | "end" | "noop" | "hold" | "dtmf" */
  behavior: "speak" | "wait" | "end" | "noop" | "hold" | "dtmf";
  /** Internal notes (for logging/debugging) */
  internal?: string;
  /** DTMF digits to send (only used when behavior is "dtmf") */
  dtmf?: string;
}

/**
 * Try to fix common JSON malformations from LLM responses.
 * LLMs sometimes return incomplete or malformed JSON.
 */
function tryFixMalformedJson(text: string): string | null {
  let fixed = text.trim();

  // Count opening and closing braces
  const openBraces = (fixed.match(/\{/g) || []).length;
  const closeBraces = (fixed.match(/\}/g) || []).length;

  // Add missing closing braces
  if (openBraces > closeBraces) {
    const missing = openBraces - closeBraces;
    fixed = fixed + "}".repeat(missing);
    console.log(`[LLM] Fixed JSON: added ${missing} missing closing brace(s)`);
  }

  // Try to parse
  try {
    JSON.parse(fixed);
    return fixed;
  } catch {
    return null;
  }
}

/**
 * Extract JSON fields using regex as a fallback when JSON.parse fails.
 * This handles cases where the LLM returns partial/malformed JSON.
 */
function extractFieldsViaRegex(text: string): { speak?: string; behavior?: string; internal?: string } | null {
  const result: { speak?: string; behavior?: string; internal?: string } = {};

  // Extract "speak" field value
  const speakMatch = text.match(/"speak"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (speakMatch) {
    // Unescape the string
    result.speak = speakMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }

  // Extract "behavior" field value
  const behaviorMatch = text.match(/"behavior"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (behaviorMatch) {
    result.behavior = behaviorMatch[1];
  }

  // Extract "internal" field value
  const internalMatch = text.match(/"internal"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (internalMatch) {
    result.internal = internalMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }

  // Return null if we couldn't extract any useful fields
  if (!result.speak && !result.behavior) {
    return null;
  }

  return result;
}

/**
 * Extract the speech text and behavior from an LLM response.
 * Handles two response formats:
 * 1. JSON object with "speak" field: {"speak": "text to speak", "behavior": "...", "internal": "..."}
 * 2. Plain text string (returned as-is with behavior="speak")
 *
 * @param llmResponse - The raw response from the LLM
 * @returns Parsed response with speakText, behavior, and optional internal notes
 */
function extractSpeechAndBehavior(llmResponse: string): ParsedLlmResponse {
  const trimmed = llmResponse.trim();

  // Check if response looks like JSON (starts with {)
  if (trimmed.startsWith("{")) {
    let parsed: any = null;

    // Try 1: Direct JSON.parse
    try {
      parsed = JSON.parse(trimmed);
    } catch (parseError) {
      console.log("[LLM] Initial JSON parse failed:", parseError instanceof Error ? parseError.message : parseError);

      // Try 2: Fix malformed JSON (missing closing braces)
      const fixed = tryFixMalformedJson(trimmed);
      if (fixed) {
        try {
          parsed = JSON.parse(fixed);
          console.log("[LLM] Successfully parsed after fixing malformed JSON");
        } catch {
          // Continue to regex fallback
        }
      }

      // Try 3: Extract fields via regex
      if (!parsed) {
        console.log("[LLM] Attempting regex extraction of JSON fields");
        const extracted = extractFieldsViaRegex(trimmed);
        if (extracted && extracted.speak) {
          console.log("[LLM] Successfully extracted fields via regex");
          parsed = extracted;
        }
      }
    }

    // If we successfully parsed or extracted the JSON
    if (parsed) {
      // Extract behavior (default to "speak" if not provided)
      const behavior = parsed.behavior || "speak";
      const internal = parsed.internal;

      // Log internal notes if present
      if (internal) {
        console.log("[LLM] Internal notes:", internal);
      }

      // If behavior is "wait", "noop", or "hold", don't speak anything immediately
      // (For "hold", the caller will handle periodic check-ins separately)
      if (behavior === "wait" || behavior === "noop" || behavior === "hold") {
        console.log(`[LLM] Behavior='${behavior}' - skipping TTS (silent response)`);
        return { speakText: null, behavior, internal };
      }

      // Handle "dtmf" behavior - send DTMF tones instead of speaking
      if (behavior === "dtmf") {
        // Extract DTMF digits from the response
        let dtmfDigits = parsed.dtmf || parsed.digits || parsed.digit;

        // If no explicit dtmf field, try to extract from speak field
        if (!dtmfDigits && typeof parsed.speak === "string") {
          dtmfDigits = ivrUtils.extractDtmfDigits(parsed.speak) || ivrUtils.parseNaturalDtmf(parsed.speak);
        }

        if (dtmfDigits) {
          const cleanDigits = ivrUtils.extractDtmfDigits(String(dtmfDigits));
          console.log(`[LLM] Behavior='dtmf' - will send DTMF: ${cleanDigits}`);
          return { speakText: null, behavior: "dtmf", internal, dtmf: cleanDigits || undefined };
        } else {
          console.warn("[LLM] Behavior='dtmf' but no valid digits found, treating as noop");
          return { speakText: null, behavior: "noop", internal };
        }
      }

      // If it has a "speak" field, use that
      if (typeof parsed.speak === "string") {
        console.log(`[LLM] Parsed JSON response, behavior='${behavior}', extracting 'speak' field`);
        return { speakText: parsed.speak, behavior, internal };
      }
      // If speak is null, treat as silent
      if (parsed.speak === null) {
        console.log(`[LLM] speak=null, behavior='${behavior}' - skipping TTS`);
        return { speakText: null, behavior, internal };
      }
      // If no speak field but has text field, try that
      if (typeof parsed.text === "string") {
        console.log(`[LLM] Parsed JSON response, behavior='${behavior}', extracting 'text' field`);
        return { speakText: parsed.text, behavior, internal };
      }
      // If no recognized field, log warning and return original
      console.warn("[LLM] JSON response has no 'speak' or 'text' field, using raw response");
      return { speakText: llmResponse, behavior: "speak" };
    }

    // All parsing attempts failed - this is a critical error
    // Do NOT use raw JSON as speech text!
    console.error("[LLM] ❌ CRITICAL: Failed to parse JSON response after all attempts. Raw response starts with '{' - will NOT speak raw JSON.");
    console.error("[LLM] Raw response (first 500 chars):", trimmed.substring(0, 500));
    // Return null speech to avoid speaking JSON
    return { speakText: null, behavior: "speak" };
  }

  // Plain text response, return as-is with default behavior
  return { speakText: llmResponse, behavior: "speak" };
}

/**
 * Estimate what portion of text was actually spoken based on playback duration.
 * Uses average speaking rate of ~150 words per minute (2.5 words/second).
 * @param fullText - The complete text that was sent to TTS
 * @param durationMs - How long the TTS actually played before stopping (in milliseconds)
 * @returns Estimated text that was actually spoken
 */
function estimateSpokenText(fullText: string, durationMs: number): string {
  // Average speaking rate: ~150 words per minute = 2.5 words per second
  const WORDS_PER_SECOND = 2.5;

  const words = fullText.split(/\s+/);
  const totalWords = words.length;
  const durationSeconds = durationMs / 1000;

  // Estimate how many words were spoken
  const estimatedWordsSpoken = Math.floor(durationSeconds * WORDS_PER_SECOND);

  // If we estimate more words than exist, return full text
  if (estimatedWordsSpoken >= totalWords) {
    return fullText;
  }

  // If duration is very short (< 0.5s), likely didn't speak anything meaningful
  if (durationSeconds < 0.5) {
    return "";
  }

  // Return estimated portion
  const spokenWords = words.slice(0, estimatedWordsSpoken);
  return spokenWords.join(" ");
}

/**
 * Cancel any active hold mode for a call.
 * Called when the callee speaks (ending hold) or when the call ends.
 */
function cancelHoldMode(callContext: CallContext): void {
  if (callContext.isOnHold) {
    console.log(`[HOLD] 📞 Exiting hold mode (was on hold for ${callContext.holdCheckInCount || 0} check-ins)`);
  }
  callContext.isOnHold = false;
  callContext.holdStartedAt = undefined;
  callContext.holdCheckInCount = undefined;
  if (callContext.holdCheckInTimer) {
    clearTimeout(callContext.holdCheckInTimer);
    callContext.holdCheckInTimer = undefined;
  }
}

/**
 * Perform a hold check-in. This is called periodically while on hold.
 * Sends a prompt to the LLM to generate a check-in message, then speaks it via TTS.
 * After speaking, schedules the next check-in if within limits.
 */
async function performHoldCheckIn(
  callContext: CallContext,
  ws: WebSocket
): Promise<void> {
  if (!callContext.isOnHold || !callContext.isCallActive) {
    console.log("[HOLD] Check-in aborted - no longer on hold or call inactive");
    return;
  }

  const checkInCount = (callContext.holdCheckInCount || 0) + 1;
  callContext.holdCheckInCount = checkInCount;

  // Use per-call setting if provided, otherwise use config default
  const maxCheckIns = callContext.holdMaxCheckIns || config.callControl.holdMaxCheckIns;
  const holdDurationSec = callContext.holdStartedAt
    ? Math.round((Date.now() - callContext.holdStartedAt) / 1000)
    : 0;

  console.log(`[HOLD] ⏰ Check-in #${checkInCount}/${maxCheckIns} (on hold for ${holdDurationSec}s)`);

  // Check if we've exceeded max check-ins
  if (checkInCount >= maxCheckIns) {
    console.log(`[HOLD] 🛑 Max check-ins (${maxCheckIns}) reached - ending call`);

    // Generate a polite hang-up message
    const hangupMessage = `I've been on hold for a while now, and I need to go. I'll try calling back later. Goodbye.`;

    // Speak the hang-up message and end the call
    callContext.pendingHangupAfterTts = true;
    if (callContext.callControlId) {
      await sharedState.setPendingHangup(callContext.callControlId, true);
    }

    // Append to conversation turns
    if (callContext.callId) {
      contextMgr.appendTurn(callContext.callId, {
        speaker: "assistant",
        text: hangupMessage,
        timestamp: new Date().toISOString(),
      });
    }

    cancelHoldMode(callContext);

    // Increment turn sequence and send TTS
    callContext.turnSeq = (callContext.turnSeq || 0) + 1;
    await sendTtsResponse(callContext, ws, hangupMessage, callContext.turnSeq);
    return;
  }

  // Generate a check-in message via LLM
  // We send a special prompt that tells the LLM we're still on hold and need a brief check-in
  try {
    const checkInPrompt = `[SYSTEM: You are currently on hold (check-in #${checkInCount}/${maxCheckIns}, ${holdDurationSec}s elapsed). Generate a brief, polite check-in phrase to let the other party know you're still waiting. Keep it very short (5-10 words max). Examples: "Still here, thank you", "I'm still waiting, no rush", "Take your time, I'll hold". Respond with ONLY the check-in phrase, no JSON.]`;

    const checkInResponse = await generateAssistantReply(checkInPrompt, callContext);

    // Clean up the response (remove any JSON formatting if present)
    let checkInText = checkInResponse.trim();
    if (checkInText.startsWith("{")) {
      // Try to extract speak field from JSON response
      try {
        const parsed = JSON.parse(checkInText);
        checkInText = parsed.speak || "Still here, thank you.";
      } catch {
        checkInText = "Still here, thank you.";
      }
    }

    // Ensure it's not too long
    if (checkInText.length > 100) {
      checkInText = checkInText.substring(0, 100);
    }

    console.log(`[HOLD] 📢 Check-in message: "${checkInText}"`);

    // Append to conversation turns
    if (callContext.callId) {
      contextMgr.appendTurn(callContext.callId, {
        speaker: "assistant",
        text: checkInText,
        timestamp: new Date().toISOString(),
      });
    }

    // Speak the check-in message
    callContext.turnSeq = (callContext.turnSeq || 0) + 1;
    await sendTtsResponse(callContext, ws, checkInText, callContext.turnSeq);

    // Schedule next check-in if still on hold
    if (callContext.isOnHold && callContext.isCallActive) {
      scheduleHoldCheckIn(callContext, ws);
    }
  } catch (error) {
    console.error("[HOLD] ❌ Error generating check-in:", error instanceof Error ? error.message : error);
    // Even on error, schedule next check-in to avoid getting stuck
    if (callContext.isOnHold && callContext.isCallActive) {
      scheduleHoldCheckIn(callContext, ws);
    }
  }
}

/**
 * Schedule the next hold check-in timer.
 */
function scheduleHoldCheckIn(callContext: CallContext, ws: WebSocket): void {
  // Clear any existing timer
  if (callContext.holdCheckInTimer) {
    clearTimeout(callContext.holdCheckInTimer);
  }

  // Use per-call setting if provided, otherwise use config default
  const intervalMs = callContext.holdCheckInIntervalMs || config.callControl.holdCheckInIntervalMs;
  console.log(`[HOLD] ⏲️ Scheduling next check-in in ${intervalMs}ms`);

  callContext.holdCheckInTimer = setTimeout(() => {
    performHoldCheckIn(callContext, ws);
  }, intervalMs);
}

/**
 * Start hold mode for a call.
 * Called when the LLM returns behavior="hold".
 */
function startHoldMode(callContext: CallContext, ws: WebSocket): void {
  // If already on hold, just log and continue
  if (callContext.isOnHold) {
    console.log("[HOLD] Already on hold, continuing...");
    return;
  }

  console.log("[HOLD] 📞 Entering hold mode");
  callContext.isOnHold = true;
  callContext.holdStartedAt = Date.now();
  callContext.holdCheckInCount = 0;

  // Schedule the first check-in
  scheduleHoldCheckIn(callContext, ws);
}

/**
 * Queue a user transcript fragment for potential LLM + TTS processing.
 * Resets the debounce timer on each transcript update.
 * Increments turnSeq to invalidate any in-flight responses from previous turns.
 * @param callContext - The call context
 * @param transcript - The user transcript
 * @param ws - The WebSocket connection
 */
function queueUserTranscript(
  callContext: CallContext,
  transcript: string,
  ws: WebSocket
): void {
  // Initialize accumulated turn text if needed
  if (!callContext.accumulatedTurnText) {
    callContext.accumulatedTurnText = [];
  }

  // ACCUMULATE utterances instead of replacing
  // This ensures the full callee turn is captured across multiple speech_final events
  callContext.accumulatedTurnText.push(transcript);
  console.log(`[TRANSCRIPT] Accumulated turn text (${callContext.accumulatedTurnText.length} segments): "${callContext.accumulatedTurnText.join(' | ')}"`);

  // Update lastUserTranscript with the FULL accumulated turn
  const fullTurnText = callContext.accumulatedTurnText.join(" ");
  callContext.lastUserTranscript = fullTurnText;
  callContext.lastTranscriptAt = Date.now();

  // Increment turn sequence (invalidates in-flight work from previous turns)
  callContext.turnSeq = (callContext.turnSeq || 0) + 1;
  const currentSeq = callContext.turnSeq;

  // Clear any existing debounce timer
  if (callContext.ttsDebounceTimer) {
    clearTimeout(callContext.ttsDebounceTimer);
  }

  // Use IVR-optimized timing if in IVR mode (faster response to automated systems)
  // Otherwise use per-call ttsDebounceMs if set, or config default
  const debounceMs = ivrUtils.getDebounceMs(callContext);
  if (callContext.isIvrMode) {
    console.log(`[IVR] ⚡ Using fast debounce: ${debounceMs}ms (IVR mode)`);
  } else {
    console.log(`[DEBOUNCE] ⏱️ Setting TTS debounce: ${debounceMs}ms (per-call: ${callContext.ttsDebounceMs ?? 'default'})`);
  }

  // Schedule a new TTS response timer (uses configurable debounce)
  callContext.ttsDebounceTimer = setTimeout(() => {
    scheduleTtsResponse(callContext, ws, currentSeq);
  }, debounceMs);
}

/**
 * Check if the call is still active and ready for TTS.
 */
function canSpeak(callContext: CallContext, ws: WebSocket): boolean {
  return callContext.isCallActive === true && ws.readyState === WebSocket.OPEN;
}

/**
 * When the debounce timer fires, process the accumulated transcript.
 * Checks turnSeq to ensure this response is still valid (not stale from barge-in).
 * @param callContext - The call context
 * @param ws - The WebSocket connection
 * @param expectedSeq - The turn sequence number when this response was scheduled
 */
async function scheduleTtsResponse(
  callContext: CallContext,
  ws: WebSocket,
  expectedSeq: number
): Promise<void> {
  try {
    // GUARD: Check if this response is stale (turnSeq changed due to barge-in or new speech)
    if (callContext.turnSeq !== expectedSeq) {
      console.log(
        `[TURN] ⏭️ Dropping stale response (expected seq ${expectedSeq}, current ${callContext.turnSeq})`
      );
      return;
    }

    // Guard: Check if we can still speak
    if (!canSpeak(callContext, ws)) {
      console.log("⚠️ Call ended or WebSocket closed, skipping TTS response");
      return;
    }

    const userText = callContext.lastUserTranscript?.trim() || "";
    if (!userText) {
      console.log("⚠️ No transcript to process");
      return;
    }

    console.log("🎯 Processing accumulated transcript:", userText);

    // ============================================================================
    // IVR DETECTION: Analyze transcript for automated system patterns
    // ============================================================================
    const ivrAnalysis = ivrUtils.analyzeForIvr(userText);
    if (ivrAnalysis.confidence > 0.3) {
      console.log(`[IVR] 📊 Analysis: confidence=${(ivrAnalysis.confidence * 100).toFixed(1)}%, ` +
        `isMenu=${ivrAnalysis.isMenu}, expectsInput=${ivrAnalysis.expectsInput}, ` +
        `inputType=${ivrAnalysis.expectedInputType}`);
    }
    ivrUtils.updateIvrState(callContext, ivrAnalysis);

    // ============================================================================
    // HOLD DETECTION: Check for hold patterns and update human detection state
    // ============================================================================
    if (callContext.humanDetection) {
      // Check if this looks like a hold message
      const holdIndicators = humanDetection.detectHoldIndicators(userText);
      if (holdIndicators.hasHoldMessage || ivrAnalysis.isHoldMessage) {
        console.log(`[HUMAN-DETECT] 📞 Hold pattern detected in transcript`);
        humanDetection.enterHold(callContext.humanDetection, "hold message detected");
        callContext.receiverState = callContext.humanDetection.receiverState;
      }

      // Check if extended silence suggests hold
      if (humanDetection.isLikelyOnHold(callContext.humanDetection, userText, callContext)) {
        if (callContext.receiverState !== "HOLD") {
          console.log(`[HUMAN-DETECT] 📞 Entering hold state (extended silence or hold indicators)`);
          humanDetection.enterHold(callContext.humanDetection, "extended silence or hold patterns");
          callContext.receiverState = callContext.humanDetection.receiverState;
        }
      }
    }

    // Append user turn to the call context if callId is available
    if (callContext.callId) {
      contextMgr.appendTurn(callContext.callId, {
        speaker: "caller",
        text: userText,
        timestamp: new Date().toISOString(),
      });

      // NOTE: User transcript logging is now handled in Deepgram Transcript handler
      // Only final recognized speech (is_final=true) is logged via insertTranscriptSegment()
    }

    // ============================================================================
    // HOLD STATE: Skip LLM processing when on hold (don't interrupt)
    // ============================================================================
    if (callContext.receiverState === "HOLD") {
      console.log(`[HUMAN-DETECT] 📞 On HOLD - skipping LLM processing (not interrupting)`);
      // Don't clear transcript - we may need to re-check after hold ends
      return;
    }

    // ============================================================================
    // HUMAN DETECTION: Check if we should stay silent based on state
    // ============================================================================
    if (callContext.humanDetection && humanDetection.shouldStaySilent(callContext.humanDetection)) {
      console.log(`[HUMAN-DETECT] 🤫 Staying silent (state: ${callContext.receiverState}) - waiting for more data`);
      return;
    }

    // Send to LLM
    let aiText: string;
    try {
      aiText = await generateAssistantReply(userText, callContext);
    } catch (groqError) {
      console.error(
        "❌ Groq API error:",
        groqError instanceof Error ? groqError.message : groqError
      );
      if (canSpeak(callContext, ws)) {
        ws.send(
          JSON.stringify({
            event: "error",
            payload: { message: "Failed to process request with AI model" },
          })
        );
      }
      return;
    }

    // GUARD: Check again after LLM call (which may take time)
    if (callContext.turnSeq !== expectedSeq) {
      console.log(
        `[TURN] ⏭️ Dropping stale LLM response (expected seq ${expectedSeq}, current ${callContext.turnSeq})`
      );
      return;
    }

    if (!aiText) {
      console.warn("⚠️ Groq returned empty response");
      if (canSpeak(callContext, ws)) {
        ws.send(
          JSON.stringify({
            event: "error",
            payload: { message: "AI model returned empty response" },
          })
        );
      }
      return;
    }

    // Extract speech text and behavior from LLM response (handles JSON format)
    const { speakText, behavior, dtmf } = extractSpeechAndBehavior(aiText);

    // Log both raw and extracted for debugging
    if (speakText !== aiText) {
      console.log("🤖 AI raw response:", aiText.substring(0, 200) + (aiText.length > 200 ? "..." : ""));
      console.log(`🤖 AI speech text: ${speakText ?? "(silent)"}, behavior: ${behavior}`);
    }

    // Handle "wait" or "noop" behavior - skip TTS entirely (no sound)
    if (behavior === "wait" || behavior === "noop") {
      console.log(`🤫 Behavior='${behavior}' - staying silent, no TTS triggered`);
      // If we were on hold, exit hold mode since callee is now responding
      if (callContext.isOnHold) {
        cancelHoldMode(callContext);
      }
      // Still clear transcript to avoid reprocessing
      callContext.lastUserTranscript = "";
      return;
    }

    // Handle "hold" behavior - enter hold mode with periodic check-ins
    if (behavior === "hold") {
      console.log(`⏳ Behavior='hold' - entering hold mode with periodic check-ins`);
      startHoldMode(callContext, ws);
      // Clear transcript to avoid reprocessing
      callContext.lastUserTranscript = "";
      return;
    }

    // Handle "dtmf" behavior - send DTMF tones for IVR navigation
    if (behavior === "dtmf" && dtmf) {
      console.log(`📱 Behavior='dtmf' - sending DTMF tones: ${dtmf}`);

      // Exit hold mode if we were on hold (we're now actively navigating)
      if (callContext.isOnHold) {
        cancelHoldMode(callContext);
      }

      // Check DTMF pacing (prevent rapid-fire tones)
      if (!ivrUtils.canSendDtmf(callContext)) {
        // Use per-call setting if provided, otherwise fall back to config default
        const dtmfMinPause = callContext.ivrDtmfMinPauseMs ?? config.ivr.dtmfMinPauseMs;
        const waitTime = dtmfMinPause - (Date.now() - (callContext.lastDtmfSentAt || 0));
        console.log(`[DTMF] ⏳ Waiting ${waitTime}ms before sending (pacing)`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      // Send DTMF via Telnyx
      if (callContext.callControlId) {
        try {
          // Use per-call setting if provided, otherwise fall back to config default
          const dtmfDuration = callContext.ivrDtmfDurationMs ?? config.ivr.dtmfDurationMs;
          await sendDtmf(callContext.callControlId, dtmf, dtmfDuration);
          ivrUtils.recordDtmfSent(callContext, dtmf);

          // Append to conversation turns for context
          if (callContext.callId) {
            contextMgr.appendTurn(callContext.callId, {
              speaker: "assistant",
              text: `[DTMF: ${dtmf}]`,
              timestamp: new Date().toISOString(),
            });
          }

          // Log DTMF to transcript
          if (isSupabaseConfigured()) {
            insertTranscriptSegment({
              call_id: callContext.callControlId,
              speaker: "assistant",
              track: "outbound",
              text: `[DTMF: ${dtmf}]`,
              created_at: new Date().toISOString(),
            }).catch(err => console.error("[TRANSCRIPT] Error logging DTMF:", err));
          }
        } catch (dtmfError) {
          console.error("❌ DTMF send failed:", dtmfError instanceof Error ? dtmfError.message : dtmfError);
        }
      }

      // Clear transcript to avoid reprocessing
      callContext.lastUserTranscript = "";
      return;
    }

    // If we reach here with a "speak" or "end" behavior, we're no longer on hold
    if (callContext.isOnHold) {
      cancelHoldMode(callContext);
    }

    // Handle "end" behavior - will hang up after TTS completes
    if (behavior === "end") {
      console.log("👋 Behavior='end' - will hang up after TTS completes");
      callContext.pendingHangupAfterTts = true;
      // Sync to Redis for multi-instance support
      if (callContext.callControlId) {
        await sharedState.setPendingHangup(callContext.callControlId, true);
      }
    }

    // Check if we have text to speak
    if (!speakText) {
      console.warn("⚠️ No speech text extracted from LLM response");
      // If behavior is "end" with no text, hang up immediately
      if (behavior === "end" && callContext.callControlId) {
        console.log("📞 Ending call (no speech text, behavior='end')");
        try {
          await hangupCall(callContext.callControlId);
        } catch (hangupError) {
          console.error("❌ Hangup failed:", hangupError);
        }
      }
      return;
    }

    // Append assistant turn to the call context if callId is available
    // Store only the speech text (what will actually be spoken)
    if (callContext.callId) {
      contextMgr.appendTurn(callContext.callId, {
        speaker: "assistant",
        text: speakText,
        timestamp: new Date().toISOString(),
      });

      // TODO: Assistant transcript logging requires outbound-track STT or confirmed playback text.
      // Currently, we don't log assistant text because it may not be spoken if barge-in occurs.
      // To enable assistant logging: implement outbound Deepgram stream + insertTranscriptSegment() with speaker='assistant'.
      // Feature flag: ENABLE_OUTBOUND_STT (optional scaffolding only at this time).

      // Check if we should update the rolling summary
      try {
        await maybeUpdateSummaryForCall(callContext.callId);
      } catch (summaryError) {
        console.warn(
          "⚠️ Failed to update rolling summary:",
          summaryError instanceof Error ? summaryError.message : summaryError
        );
        // Continue even if summary update fails
      }
    }

    // Send to TTS only if we can still speak and seq is still valid
    // Use extracted speakText (not raw aiText) to send only speakable text to TTS
    await sendTtsResponse(callContext, ws, speakText, expectedSeq);

    // Clear transcript after processing
    callContext.lastUserTranscript = "";
  } catch (error) {
    console.error(
      "❌ Unexpected error in TTS response handler:",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Send the AI response as speech via Telnyx TTS.
 * Sets ttsState to 'speaking' before TTS call.
 * Actual playback end is tracked via Telnyx webhooks (call.speak.ended).
 * @param callContext - The call context
 * @param ws - The WebSocket connection
 * @param aiText - The text to speak
 * @param expectedSeq - The turn sequence number to validate
 */
async function sendTtsResponse(
  callContext: CallContext,
  ws: WebSocket,
  aiText: string,
  expectedSeq: number
): Promise<void> {
  const pipelineStartTime = Date.now();
  console.log("");
  console.log("🎵 ========================================");
  console.log("🎵 STARTING TTS SPEAK ACTION");
  console.log("🎵 ========================================");

  // GUARD: Final check - is this response still valid?
  if (callContext.turnSeq !== expectedSeq) {
    console.log(
      `[TURN] ⏭️ Dropping stale TTS request (expected seq ${expectedSeq}, current ${callContext.turnSeq})`
    );
    return;
  }

  // Double-check we can still speak before calling TTS API
  if (!canSpeak(callContext, ws)) {
    console.log("⚠️ Call ended or WebSocket closed, skipping TTS API call");
    return;
  }

  // Call Telnyx Speak API to synthesize and play audio
  if (!callContext.callControlId) {
    console.error("❌ Cannot synthesize speech: callControlId is not set");
    if (canSpeak(callContext, ws)) {
      ws.send(
        JSON.stringify({
          event: "error",
          payload: { message: "Call control ID not initialized" },
        })
      );
    }
    return;
  }

  // Check if this response contains "Chow" (end of call signal)
  // Set pendingHangupAfterTts flag so we hang up AFTER TTS completes (via call.speak.ended webhook)
  const shouldHangup = /\bchow\b/i.test(aiText);
  if (shouldHangup) {
    console.log("👋 Detected 'Chow' in AI response - will hangup after TTS completes");
    callContext.pendingHangupAfterTts = true;
    // Sync to Redis for multi-instance support
    await sharedState.setPendingHangup(callContext.callControlId, true);
  }

  try {
    // IMPORTANT: Set ttsState to 'speaking' BEFORE calling synthesizeSpeech
    // This enables barge-in detection while audio is being queued/played
    callContext.ttsState = "speaking";
    callContext.speakWasInterrupted = false; // Reset interruption flag
    callContext.currentSpeakText = aiText; // Store text for logging on completion
    console.log(`[TTS] Setting ttsState='speaking' (callControlId: ${callContext.callControlId})`);

    // CLEAR accumulated turn text - AI is responding, so next callee speech starts a new turn
    // This ensures we don't carry over old segments from the previous turn
    if (callContext.accumulatedTurnText && callContext.accumulatedTurnText.length > 0) {
      console.log(`[TRANSCRIPT] Clearing accumulated turn text (${callContext.accumulatedTurnText.length} segments) - AI is responding`);
      callContext.accumulatedTurnText = [];
    }

    // Sync TTS state to Redis for multi-instance support
    await sharedState.markTtsSpeaking(callContext.callControlId, aiText);

    await synthesizeSpeech(aiText, callContext.callControlId);

    // Log what TTS will actually speak (only logged after successful TTS API call)
    console.log("🤖 AI (speaking):", aiText);

    // Broadcast assistant speech to live observers
    if (callContext.callControlId) {
      observer.broadcastTranscript(callContext.callControlId, 'assistant', aiText, true);
    }

    // NOTE: Do NOT set ttsState='idle' here!
    // The HTTP response returns BEFORE audio finishes playing.
    // Telnyx webhooks (call.speak.ended) will set ttsState='idle' when playback truly ends.
    // If pendingHangupAfterTts is set, the call.speak.ended handler will perform the hangup.
  } catch (ttsError) {
    console.error(
      "❌ Telnyx TTS error:",
      ttsError instanceof Error ? ttsError.message : ttsError
    );
    // On error, reset ttsState to idle and clear tracking variables
    callContext.ttsState = "idle";
    callContext.currentSpeakText = undefined;
    callContext.speakStartedAt = undefined;
    callContext.speakWasInterrupted = undefined;
    if (canSpeak(callContext, ws)) {
      ws.send(
        JSON.stringify({
          event: "error",
          payload: { message: "TTS synthesis failed" },
        })
      );
    }
    return;
  }

  console.log("⏱️ Total TTS response time:", Date.now() - pipelineStartTime, "ms");
  console.log("==========================================");
  console.log("");
}

/**
 * Finalize and upload custom call recording to Supabase Storage.
 * Creates a stereo WAV file from the buffered audio and uploads it.
 * Updates the calls table with recording_url.
 *
 * This function is designed to never throw - all errors are caught and logged.
 *
 * @param callContext - The call context with recording buffers
 */
async function finalizeCustomRecording(callContext: CallContext): Promise<void> {
  // Skip if custom recording is disabled or no call control ID
  if (!isCustomRecordingEnabled()) {
    return;
  }

  const callControlId = callContext.callControlId;
  if (!callControlId) {
    console.log("[CustomRecording] No callControlId, skipping finalization");
    return;
  }

  // Skip if recording was disabled due to size limit
  if (callContext.customRecordingDisabledDueToSize) {
    console.log("[CustomRecording] Recording was disabled due to size limit, skipping finalization");
    return;
  }

  // Skip if no recording buffers
  const buffers = callContext.recordingBuffers;
  if (!buffers) {
    console.log("[CustomRecording] No recording buffers, skipping finalization");
    return;
  }

  // Skip if no audio data captured
  if (buffers.inbound.length === 0 && buffers.outbound.length === 0) {
    console.log("[CustomRecording] No audio data captured, skipping finalization");
    return;
  }

  try {
    console.log(
      `[CustomRecording] Finalizing recording for ${callControlId} (inbound chunks: ${buffers.inbound.length}, outbound chunks: ${buffers.outbound.length})`
    );

    // Concatenate all chunks for each track
    const inboundAudio = concatTrack(buffers.inbound);
    const outboundAudio = concatTrack(buffers.outbound);

    console.log(
      `[CustomRecording] Track sizes: inbound=${inboundAudio.length}B, outbound=${outboundAudio.length}B`
    );

    // Create stereo WAV file
    const wavFile = createMulawStereoWav(inboundAudio, outboundAudio);

    // Upload to Supabase Storage
    const result = await uploadCustomCallRecording(callControlId, wavFile);

    if (result.ok && result.url) {
      // Update the call record with recording_url (custom recording is now the primary source)
      if (isSupabaseConfigured()) {
        await updateCall(callControlId, {
          recording_url: result.url,
        });
        console.log(`[CustomRecording] Updated call ${callControlId} with recording_url`);
      }
    } else {
      console.error(`[CustomRecording] Upload failed for ${callControlId}:`, result.error);
    }
  } catch (error) {
    // Never throw from finalization - just log and continue
    console.error(
      "[CustomRecording] Error during finalization:",
      error instanceof Error ? error.message : error
    );
  } finally {
    // Clear buffers to free memory regardless of success/failure
    if (buffers) {
      buffers.inbound = [];
      buffers.outbound = [];
    }
  }
}

/**
 * Cleanup call state (clear timers, mark as inactive, close Deepgram connection).
 * Also clears the CallContext from the context manager.
 */
function cleanupCallState(callContext: CallContext): void {
  console.log("🧹 Cleaning up call state");

  // Notify observers that call has ended
  if (callContext.callControlId) {
    observer.broadcastCallState(callContext.callControlId, 'ended', {
      reason: 'Call cleanup',
    });
  }

  // Flush any pending caller utterance before cleanup
  if (callContext.callerFinalBuf && callContext.callerFinalBuf.length > 0) {
    console.log("[TRANSCRIPT] Flushing pending caller utterance on cleanup");
    flushCallerUtterance(callContext).catch((err) => {
      console.error("[TRANSCRIPT] Error flushing utterance on cleanup:", err);
    });
  }

  // Finalize and upload custom recording (async, fire-and-forget with error handling)
  finalizeCustomRecording(callContext).catch((err) => {
    console.error("[CustomRecording] Error in cleanup finalization:", err);
  });

  // Mark transcript as completed in Supabase
  if (callContext.callControlId && isSupabaseConfigured()) {
    updateCall(callContext.callControlId, {
      transcript_status: "completed",
    }).catch((err) => console.error("[Supabase] Error marking transcript complete:", err));
  }

  callContext.isCallActive = false;
  callContext.ttsState = "idle";
  if (callContext.ttsDebounceTimer) {
    clearTimeout(callContext.ttsDebounceTimer);
    callContext.ttsDebounceTimer = undefined;
  }

  // Clear hold mode state and timer
  cancelHoldMode(callContext);

  // Clear transcript logging timers and buffers
  if (callContext.callerFinalFlushTimer) {
    clearTimeout(callContext.callerFinalFlushTimer);
    callContext.callerFinalFlushTimer = undefined;
  }
  if (callContext.assistantFinalFlushTimer) {
    clearTimeout(callContext.assistantFinalFlushTimer);
    callContext.assistantFinalFlushTimer = undefined;
  }
  callContext.callerFinalBuf = [];
  callContext.assistantFinalBuf = [];
  callContext.lastUserTranscript = "";

  // Close the Deepgram WebSocket if it exists and is open
  if (callContext.deepgramSocket) {
    try {
      // Try to send CloseStream if the SDK requires it
      if (typeof callContext.deepgramSocket.finish === "function") {
        callContext.deepgramSocket.finish();
      }
      // Close the underlying WebSocket
      if (typeof callContext.deepgramSocket.close === "function") {
        callContext.deepgramSocket.close(1000, "Call ended");
      }
      console.log("✅ Deepgram connection closed");
    } catch (error) {
      console.warn(
        "⚠️ Error closing Deepgram connection:",
        error instanceof Error ? error.message : error
      );
    }
    callContext.deepgramSocket = undefined;
  }

  // Clean up the CallContext from the context manager
  if (callContext.callId) {
    console.log(`📋 Clearing CallContext for call ${callContext.callId}`);
    contextMgr.clearContext(callContext.callId);
  }

  // Clean up Redis state for multi-instance support
  if (callContext.callControlId) {
    sharedState.clearTtsState(callContext.callControlId).catch((err) => {
      console.error("[SharedState] Error clearing Redis state:", err);
    });
    sharedState.clearCallMachine(callContext.callControlId).catch((err) => {
      console.error("[SharedState] Error clearing call machine mapping:", err);
    });
    // Clear audio smoother state
    clearSmootherState(callContext.callControlId);
  }
}

// -----------------------------------------------------------------------------
// APP + SERVER
// -----------------------------------------------------------------------------
const app = express();
const server = createServer(app);

// Use noServer mode to manually handle WebSocket upgrades
// This allows us to route to different WebSocket servers based on path
const wss = new WebSocketServer({ noServer: true });

app.use(express.json());

// HELPER: Generate a WAV file header for 8kHz mono 16-bit PCM
function generateWavHeader(pcmDataLength: number, sampleRate: number = 8000): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  // Total file size: 36 + pcm data length
  const fileSize = 36 + pcmDataLength;

  const header = Buffer.alloc(44);
  let offset = 0;

  // RIFF header
  header.write("RIFF", offset);
  offset += 4;
  header.writeUInt32LE(fileSize, offset);
  offset += 4;
  header.write("WAVE", offset);
  offset += 4;

  // fmt subchunk
  header.write("fmt ", offset);
  offset += 4;
  header.writeUInt32LE(16, offset); // Subchunk1Size (16 for PCM)
  offset += 4;
  header.writeUInt16LE(1, offset); // AudioFormat (1 = PCM)
  offset += 2;
  header.writeUInt16LE(channels, offset);
  offset += 2;
  header.writeUInt32LE(sampleRate, offset);
  offset += 4;
  header.writeUInt32LE(byteRate, offset);
  offset += 4;
  header.writeUInt16LE(blockAlign, offset);
  offset += 2;
  header.writeUInt16LE(bitsPerSample, offset);
  offset += 2;

  // data subchunk
  header.write("data", offset);
  offset += 4;
  header.writeUInt32LE(pcmDataLength, offset);

  return header;
}

// DEBUG ENDPOINTS REMOVED: These were specific to OpenAI TTS pipeline with manual audio processing.
// With Telnyx TTS, audio synthesis and playback are handled directly by Telnyx on the call.

/**
 * ITU-T G.711 μ-law decoder.
 * Converts 8-bit μ-law to 16-bit linear PCM.
 */
function decodeMulawG711(mulaw: number): number {
  // Invert the bits (μ-law uses inverted encoding)
  mulaw = ~mulaw & 0xFF;
  
  // Extract sign, exponent, and mantissa
  const sign = (mulaw & 0x80) ? -1 : 1;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0F;
  
  // Reconstruct the sample
  // The formula: sample = (mantissa << (exponent + 3)) + (1 << (exponent + 3)) - 132
  let sample: number;
  if (exponent === 0) {
    sample = (mantissa << 3) + 132;
  } else {
    sample = ((mantissa << 3) + 132) << exponent;
  }
  
  // Remove the bias
  sample -= 132;
  
  return sign * sample;
}


// OUTBOUND CALL ENDPOINT
app.use("/api/outbound-call", outboundCallRouter);

// Helper to decode client_state from Telnyx webhooks (matching Cloudflare pattern)
function decodeClientState(encodedState: string | undefined): Record<string, any> {
  if (!encodedState) return {};
  try {
    if (typeof encodedState === "string") {
      if (encodedState.trim().startsWith("{")) {
        return JSON.parse(encodedState);
      }
      return JSON.parse(Buffer.from(encodedState, "base64").toString("utf8"));
    }
    return encodedState as Record<string, any>;
  } catch (error) {
    console.error("Failed to decode client_state:", error);
    return {};
  }
}

// TELNYX WEBHOOKS (Call start/stop and TTS playback lifecycle)
app.post("/webhooks/telnyx", async (req, res) => {
  const eventType = req.body?.data?.event_type;
  const callControlId = req.body?.data?.payload?.call_control_id;
  const callSessionId = req.body?.data?.payload?.call_session_id;
  const payload = req.body?.data?.payload || {};

  // Decode client_state to get user_id and goal
  const clientStateData = decodeClientState(payload.client_state);
  const userId = clientStateData.userId || clientStateData.user_id || null;
  const goal = clientStateData.goal || null;

  console.log(`📞 Telnyx webhook event: ${eventType} (callControlId: ${callControlId || 'N/A'})`);

  // Handle call.initiated - create call record if it doesn't exist
  if (eventType === "call.initiated" || eventType === "call.ringing") {
    if (callControlId && isSupabaseConfigured() && userId) {
      const fromNumber = payload.from || payload.from_number;
      const toNumber = payload.to || payload.to_number;
      const timestamp = payload.start_time || new Date().toISOString();

      upsertCall({
        id: callControlId,
        user_id: userId,
        direction: payload.direction === "inbound" ? "inbound" : "outbound",
        from_e164: fromNumber,
        to_e164: toNumber,
        status: eventType === "call.initiated" ? "initiated" : "ringing",
        goal: goal,
        started_at: timestamp,
        metadata: {
          call_session_id: callSessionId,
          initiated_by: "webhook",
        },
      }).then((result) => {
        if (result.success) {
          console.log(`📊 Call ${eventType} logged to Supabase:`, callControlId);
        } else {
          console.error(`❌ Failed to log ${eventType}:`, result.error);
        }
      }).catch((err) => console.error(`[Supabase] Error logging ${eventType}:`, err));
    }
  } else if (eventType === "call.answered") {
    console.log(
      "📦 Telnyx call.answered payload:",
      JSON.stringify(req.body, null, 2)
    );
    if (!callControlId) {
      console.warn("⚠️ call.answered webhook missing payload.call_control_id");
    }
    if (callControlId) {
      // Log answered status to Supabase
      if (isSupabaseConfigured()) {
        safeUpdateStatus(callControlId, "answered", {
          answered_at: new Date().toISOString(),
        }).catch((err) => console.error("[Supabase] Error logging answered:", err));
      }

      try {
        // Start streaming (Telnyx recording disabled - using custom recording pipeline)
        await axios.post(
          `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`,
          {
            stream_url: config.telnyx.streamUrl,
            stream_track: "both_tracks",
            stream_bidirectional_mode: "rtp",
          },
          {
            headers: {
              "Authorization": `Bearer ${config.telnyx.apiKey}`,
              "Content-Type": "application/json",
            },
          }
        );
        console.log("✅ Streaming started for call:", callControlId);
      } catch (error) {
        console.error("❌ Failed to start streaming:", error instanceof Error ? error.message : error);
        if (error instanceof Error && "response" in error) {
          const err = error as any;
          console.error("📋 Telnyx API Error Details:", {
            status: err.response?.status,
            statusText: err.response?.statusText,
            data: err.response?.data,
          });
        }
      }
    }
  } else if (eventType === "call.speak.started") {
    // TTS playback has started
    // IMPORTANT: Always update Redis even if local context doesn't exist
    // This handles multi-instance deployments where webhook hits different instance than WebSocket
    if (callControlId) {
      const now = Date.now();

      // Update local context if it exists on this instance
      const ctx = contextMgr.getContext(callControlId);
      if (ctx) {
        ctx.ttsState = "speaking";
        ctx.speakStartedAt = now;
        console.log(`[TTS] 🔊 call.speak.started - ttsState='speaking' (callControlId: ${callControlId})`);
      } else {
        console.log(`[TTS] 🔊 call.speak.started - local context not found, updating Redis only (callControlId: ${callControlId})`);
      }

      // ALWAYS update Redis for multi-instance sync
      await sharedState.markTtsSpeaking(callControlId);
    }
  } else if (eventType === "call.speak.ended") {
    // TTS playback has ended
    // IMPORTANT: Always update Redis even if local context doesn't exist
    if (callControlId) {
      // ALWAYS update Redis first for multi-instance sync
      await sharedState.markTtsIdle(callControlId);

      const ctx = contextMgr.getContext(callControlId);
      if (ctx) {
        ctx.ttsState = "idle";
        console.log(`[TTS] ✅ call.speak.ended - ttsState='idle' (callControlId: ${callControlId})`);

        // Log assistant transcript - estimate actual spoken portion if interrupted
        if (ctx.currentSpeakText && ctx.speakStartedAt) {
          const playbackDurationMs = Date.now() - ctx.speakStartedAt;
          let textToLog = ctx.currentSpeakText;
          let logMessage = "";

          if (ctx.speakWasInterrupted) {
            // Estimate what portion was actually spoken based on duration
            textToLog = estimateSpokenText(ctx.currentSpeakText, playbackDurationMs);
            logMessage = `[TRANSCRIPT] Logging assistant speech (interrupted after ${playbackDurationMs}ms, estimated ${textToLog.split(/\s+/).length}/${ctx.currentSpeakText.split(/\s+/).length} words spoken): "${textToLog}"`;
          } else {
            // Completed naturally
            logMessage = `[TRANSCRIPT] Logging assistant speech (completed naturally, ${playbackDurationMs}ms): "${textToLog}"`;
          }

          console.log(logMessage);

          // Log to database if we have text and Supabase is configured
          if (textToLog && isSupabaseConfigured()) {
            try {
              await insertTranscriptSegment({
                call_id: callControlId,
                speaker: "assistant",
                track: "outbound",
                text: textToLog,
                created_at: new Date().toISOString(),
              });
            } catch (error) {
              console.error("[TRANSCRIPT] ❌ Failed to log assistant transcript:", error instanceof Error ? error.message : error);
            }
          }

          // Clear the stored text and flags after logging
          ctx.currentSpeakText = undefined;
          ctx.speakStartedAt = undefined;
          ctx.speakWasInterrupted = undefined;
        }

        // Check if we should hang up after TTS completed (triggered by "end" behavior or "Chow" signal)
        // Check local context first, then fall back to Redis
        if (ctx.pendingHangupAfterTts) {
          console.log("📞 TTS completed - executing pending hangup (behavior='end' or 'Chow' detected)");
          ctx.pendingHangupAfterTts = false; // Clear local flag
          await sharedState.setPendingHangup(callControlId, false); // Clear Redis flag
          try {
            await hangupCall(callControlId);
            console.log("✅ Call ended successfully after TTS completion");
          } catch (hangupError) {
            console.error("❌ Hangup after TTS failed:", hangupError);
          }
        }
      } else {
        console.log(`[TTS] ✅ call.speak.ended - local context not found, checking Redis (callControlId: ${callControlId})`);

        // Check Redis for pending hangup (multi-instance case: webhook hit different instance than WebSocket)
        const pendingHangup = await sharedState.getPendingHangup(callControlId);
        if (pendingHangup) {
          console.log("📞 TTS completed - executing pending hangup from Redis (behavior='end' or 'Chow' detected)");
          await sharedState.setPendingHangup(callControlId, false); // Clear Redis flag
          try {
            await hangupCall(callControlId);
            console.log("✅ Call ended successfully after TTS completion (via Redis)");
          } catch (hangupError) {
            console.error("❌ Hangup after TTS failed:", hangupError);
          }
        }
      }
    }
  } else if (eventType === "call.playback.ended") {
    // Belt-and-suspenders: Also handle generic playback.ended
    if (callControlId) {
      // ALWAYS update Redis first for multi-instance sync
      await sharedState.markTtsIdle(callControlId);

      const ctx = contextMgr.getContext(callControlId);
      if (ctx) {
        ctx.ttsState = "idle";
        console.log(`[TTS] ✅ call.playback.ended - ttsState='idle' (callControlId: ${callControlId})`);
      } else {
        console.log(`[TTS] ✅ call.playback.ended - local context not found, Redis updated (callControlId: ${callControlId})`);
      }
    }
  } else if (eventType === "call.hangup" || eventType === "streaming.stopped") {
    console.log("📞 Call ended:", eventType);

    // Log call completion to Supabase
    if (callControlId && isSupabaseConfigured()) {
      const endedAt = new Date().toISOString();
      const startTime = payload.start_time ? new Date(payload.start_time) : null;
      let durationSeconds: number | undefined;

      if (startTime) {
        durationSeconds = Math.max(
          0,
          Math.floor((new Date(endedAt).getTime() - startTime.getTime()) / 1000)
        );
      }

      updateCall(callControlId, {
        status: "completed",
        ended_at: endedAt,
        duration_sec: durationSeconds,
      }).catch((err) => console.error("[Supabase] Error logging hangup:", err));
    }

    // Note: We don't have access to callContext here, but we mark the call
    // as inactive via the WebSocket close event. Cleanup happens there.
  } else if (eventType === "call.cost") {
    // Log call cost/billing to Supabase
    const billedSeconds =
      payload.billed_duration_secs ||
      payload.billed_duration_seconds ||
      null;
    const totalCost =
      payload.total_cost ||
      payload.amount_billed_usd ||
      null;
    const currency = payload.currency || "USD";

    if (callControlId && isSupabaseConfigured()) {
      console.log("💰 Call cost received:", totalCost, currency);
      updateCall(callControlId, {
        cost_usd: currency === "USD" ? totalCost : null,
        duration_sec: billedSeconds,
      }).catch((err) => console.error("[Supabase] Error logging cost:", err));
    }
  }

  res.send("ok");
});

// -----------------------------------------------------------------------------
/**
 * Flush accumulated caller utterance to Supabase (insert-only)
 * Joins all final chunks in buffer into a single utterance and logs via insertTranscriptSegment
 * Skips if utterance is empty or already logged
 * @param callContext - The call context with buffer
 */
async function flushCallerUtterance(callContext: CallContext): Promise<void> {
  if (!callContext || !callContext.callControlId) {
    return;
  }

  const buffer = callContext.callerFinalBuf || [];
  if (buffer.length === 0) {
    return;
  }

  // Join all final chunks with spaces
  const utterance = buffer.join(" ").trim();

  // Skip if empty or already logged (deduplication)
  if (!utterance || utterance === callContext.lastCallerUtterance) {
    console.log(`[TRANSCRIPT] Skipping duplicate or empty utterance: "${utterance}"`);
    callContext.callerFinalBuf = [];
    return;
  }

  // Log via insert-only transcript segment
  console.log(`[TRANSCRIPT] Flushing caller utterance (${buffer.length} chunks): "${utterance}"`);

  if (isSupabaseConfigured()) {
    await insertTranscriptSegment({
      call_id: callContext.callControlId,
      speaker: "caller",
      track: "inbound",
      text: utterance,
    }).catch((err) => {
      console.error("[Supabase] Error inserting caller transcript segment:", err);
    });
  }

  // Update dedup state and clear buffer
  callContext.lastCallerUtterance = utterance;
  callContext.callerFinalBuf = [];
}

// WS AUDIO SESSION HANDLER (core of the whole system)
// -----------------------------------------------------------------------------
wss.on("connection", async (ws) => {
  console.log("🔌 Telnyx WebSocket Connected");

  // Initialize call context (populated when "start" message arrives)
  let callContext: CallContext | undefined;

  // Create a Deepgram live stream with VAD events enabled for instant barge-in
  const dgLive = await deepgram.listen.live({
    model: config.deepgram.model,
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    endpointing: 100,
    vad_events: true,
    interim_results: true,
  });

  console.log("🎧 Deepgram stream started");

  // NOTE: We no longer use SpeechStarted for barge-in because it's too sensitive
  // (triggers on any sound, not just actual words). Instead, barge-in is now
  // handled in the Transcript event handler, which only fires when actual words
  // are detected by Deepgram's speech recognition.
  //
  // HUMAN DETECTION: We DO use VAD events to track speech/silence for:
  // - Utterance flushing (0.5s non-speech → flush utterance)
  // - Hold detection (extended silence + hold patterns)
  dgLive.on(LiveTranscriptionEvents.SpeechStarted, () => {
    // Log for debugging, but don't trigger barge-in on VAD alone
    if (callContext?.ttsState === "speaking") {
      console.log("[VAD] SpeechStarted detected while AI speaking (waiting for actual words before barge-in)");
    }

    // Update human detection VAD state
    if (callContext?.humanDetection) {
      humanDetection.updateVadState(callContext.humanDetection, true);

      // If we were on HOLD and speech returns, exit hold mode
      if (callContext.receiverState === "HOLD") {
        console.log("[VAD] Speech detected - exiting hold mode");
        humanDetection.exitHold(callContext.humanDetection);
        callContext.receiverState = callContext.humanDetection.receiverState;
      }
    }
  });

  // Track speech ending for human detection
  dgLive.on(LiveTranscriptionEvents.UtteranceEnd, () => {
    // Update human detection VAD state - speech ended
    if (callContext?.humanDetection) {
      humanDetection.updateVadState(callContext.humanDetection, false);
      console.log(`[VAD] UtteranceEnd - silence duration now tracking`);
    }
  });

  // Relay Deepgram transcript → Groq → Telnyx (with debounce)
  // STRICT-FINAL-ONLY: Only log final recognized speech (is_final=true)
  // BARGE-IN: Trigger on any transcript (interim or final) for responsiveness
  // LOGGING: Only log to Supabase when speech completes (speech_final or timer flush)
  dgLive.on(LiveTranscriptionEvents.Transcript, async (dgEvent: any) => {
    try {
      const results = dgEvent.channel?.alternatives?.[0];
      const isFinal = dgEvent.is_final ?? dgEvent.channel?.is_final ?? false;
      const speechFinal = dgEvent.speech_final ?? dgEvent.channel?.speech_final ?? false;

      // Guard: Check if call is still active BEFORE logging raw transcript
      if (!callContext || !callContext.isCallActive) {
        // Only log at debug level if call is not active to avoid flooding logs
        if (results?.transcript) {
          console.debug("📝 Deepgram raw transcript (call inactive):", results.transcript);
        }
        return;
      }

      if (!results || !results.transcript) return;

      const userText = results.transcript.trim();
      if (!userText) return;

      console.log("🗣️ Caller transcript:", userText, `(is_final: ${isFinal}, speech_final: ${speechFinal})`);

      // Broadcast transcript to live observers
      if (callContext.callControlId) {
        observer.broadcastTranscript(callContext.callControlId, 'caller', userText, isFinal);
      }

      // ============================================================================
      // BARGE-IN: Trigger on any recognized words (interim or final) for responsiveness
      // Barge-in ONLY stops TTS - it does NOT immediately send partials to LLM.
      // Utterance finalization (sending to LLM) only happens when:
      // 1. speech_final=true (Deepgram detected end of utterance), OR
      // 2. Silence timeout after last final transcript
      // ============================================================================
      let bargeInJustOccurred = false;

      // MULTI-INSTANCE SYNC: Check Redis for authoritative TTS state
      // This handles cases where call.speak.ended webhook hit a different instance
      if (callContext.callControlId && sharedState.isRedisEnabled()) {
        const redisState = await sharedState.syncFromRedis(callContext.callControlId);
        if (redisState) {
          // If Redis says TTS is idle but local says speaking, trust Redis
          if (redisState.ttsState === "idle" && callContext.ttsState === "speaking") {
            console.log(`[BARGE-IN] 📡 Redis sync: TTS is actually idle (local was out of sync)`);
            callContext.ttsState = "idle";
          }
          // If Redis has a more recent speakStartedAt, use it
          if (redisState.speakStartedAt && (!callContext.speakStartedAt || redisState.speakStartedAt > callContext.speakStartedAt)) {
            callContext.speakStartedAt = redisState.speakStartedAt;
          }
        }
      }

      if (callContext.ttsState === "speaking" && callContext.callControlId) {
        // Apply cooldown to prevent spamming the stop endpoint
        const now = Date.now();

        // Check grace period - don't trigger barge-in too soon after TTS starts (prevents echo issues)
        // In IVR mode, grace period can be disabled since IVRs don't have echo feedback issues
        const gracePeriodMs = (callContext.isIvrMode && config.ivr.disableBargeInGracePeriod)
          ? 0
          : config.callControl.bargeInGracePeriodMs;
        const timeSinceTtsStart = callContext.speakStartedAt ? now - callContext.speakStartedAt : Infinity;
        if (timeSinceTtsStart < gracePeriodMs) {
          console.log(`[BARGE-IN] ⏳ Ignoring during grace period (${timeSinceTtsStart}ms < ${gracePeriodMs}ms): "${userText}"`);
        } else if (!callContext.bargeInCooldownUntil || now >= callContext.bargeInCooldownUntil) {
          console.log(`[BARGE-IN] 🛑 Words detected while AI speaking: "${userText}" (callControlId: ${callContext.callControlId})`);

          // Set cooldown to prevent multiple rapid stops (uses per-call setting if provided, otherwise config default)
          const cooldownMs = callContext.bargeInCooldownMs ?? config.callControl.bargeInCooldownMs;
          callContext.bargeInCooldownUntil = now + cooldownMs;

          // Mark as stopping
          callContext.ttsState = "stopping";

          // Mark current speech as interrupted (for logging actual spoken portion)
          callContext.speakWasInterrupted = true;

          // Issue playback stop
          try {
            await stopSpeaking(callContext.callControlId);
          } catch (stopError) {
            console.error("[BARGE-IN] ❌ Error stopping playback:", stopError);
          }

          // Clear any pending TTS debounce timer (we will NOT queue the partial that triggered barge-in)
          if (callContext.ttsDebounceTimer) {
            clearTimeout(callContext.ttsDebounceTimer);
            callContext.ttsDebounceTimer = undefined;
          }

          // Clear any pending caller utterance flush (we'll start fresh with the new utterance)
          if (callContext.callerFinalFlushTimer) {
            clearTimeout(callContext.callerFinalFlushTimer);
            callContext.callerFinalFlushTimer = undefined;
          }

          // Clear any accumulated partial transcript buffer - start fresh
          callContext.callerFinalBuf = [];
          callContext.lastUserTranscript = "";
          // Also clear accumulated turn text - barge-in starts a fresh turn
          callContext.accumulatedTurnText = [];

          // Increment turn sequence to invalidate any in-flight LLM/TTS work
          callContext.turnSeq = (callContext.turnSeq || 0) + 1;
          console.log(`[TURN] Turn sequence incremented to ${callContext.turnSeq} (stale responses will be dropped)`);

          // Mark as idle after stop
          callContext.ttsState = "idle";

          // Sync barge-in state to Redis for multi-instance support
          await sharedState.markTtsInterrupted(callContext.callControlId);
          await sharedState.markTtsIdle(callContext.callControlId);

          // Flag that barge-in just occurred - DO NOT queue this partial for LLM
          bargeInJustOccurred = true;
        } else {
          console.log(`[BARGE-IN] Cooldown active, skipping (${callContext.bargeInCooldownUntil - now}ms remaining)`);
        }
      }

      // ============================================================================
      // TRANSCRIPT HANDLING: Only process FINAL transcripts for LLM response
      // Interim (partial) transcripts are NOT queued for LLM - they would cause
      // premature responses like "we close" instead of waiting for "we close at four pm"
      // ============================================================================
      if (!isFinal) {
        // Log interim transcripts for debugging, but do NOT queue for LLM response
        // This prevents processing partial utterances before the speaker finishes
        if (bargeInJustOccurred) {
          console.log(`[TRANSCRIPT] Barge-in partial ignored (waiting for final): "${userText}"`);
        } else {
          console.log(`[TRANSCRIPT] Interim transcript (not queuing for LLM): "${userText}"`);

          // IMPORTANT: Reset the debounce timer if we're receiving interim transcripts
          // This prevents the AI from responding while the caller is still mid-sentence
          // Only reset if AI is not currently speaking (avoid interfering during barge-in scenarios)
          if (callContext.ttsState === "idle" && callContext.ttsDebounceTimer) {
            clearTimeout(callContext.ttsDebounceTimer);
            callContext.ttsDebounceTimer = undefined;
            console.log(`[DEBOUNCE] ⏸️ Timer cleared - caller still speaking (interim detected)`);
          }
        }
        return;
      }

      // Initialize buffer if needed
      if (!callContext.callerFinalBuf) {
        callContext.callerFinalBuf = [];
      }

      // Accumulate final chunks
      callContext.callerFinalBuf.push(userText);
      console.log(`[TRANSCRIPT] Buffered final chunk #${callContext.callerFinalBuf.length}: "${userText}"`);

      // ============================================================================
      // UTTERANCE BOUNDARY: Flush on speech_final or with fallback silence timer
      // IMPORTANT: LLM processing is ONLY triggered when utterance is complete
      // This prevents processing partials like "we close" instead of "we close at four pm"
      // ============================================================================
      const isSpeechFinal = speechFinal === true;

      if (isSpeechFinal) {
        // speech_final flag indicates end of one utterance segment
        console.log("[TRANSCRIPT] speech_final detected, flushing utterance to Supabase");

        // Clear any pending flush timer
        if (callContext.callerFinalFlushTimer) {
          clearTimeout(callContext.callerFinalFlushTimer);
          callContext.callerFinalFlushTimer = undefined;
        }

        // Get the full accumulated utterance before flushing
        const fullUtterance = [...(callContext.callerFinalBuf || [])].join(" ").trim();

        // Flush the buffer to Supabase (for transcript logging - each segment gets logged)
        flushCallerUtterance(callContext);

        // ACCUMULATE for LLM - don't send yet, wait for debounce
        // This collects ALL segments until silence is detected
        if (fullUtterance) {
          if (!callContext.accumulatedTurnText) {
            callContext.accumulatedTurnText = [];
          }
          callContext.accumulatedTurnText.push(fullUtterance);
          console.log(`[TRANSCRIPT] Accumulated turn segment #${callContext.accumulatedTurnText.length}: "${fullUtterance}"`);

          // HUMAN DETECTION: Enhanced receiver classification using state machine
          // Uses the new humanDetection module for more accurate human/IVR detection
          if (callContext.humanDetection) {
            // Add transcript to detection buffer
            humanDetection.addToTranscriptBuffer(callContext.humanDetection, fullUtterance);

            // Check if we should classify (first segment, UNKNOWN state, CHECKING state, or after hold)
            const shouldClassify =
              callContext.receiverState === "UNKNOWN" ||
              callContext.receiverState === "CHECKING" ||
              callContext.humanDetection.justExitedHold;

            if (shouldClassify && humanDetection.canClassify(callContext.humanDetection, callContext)) {
              console.log(`[HUMAN-DETECT] 🎯 Triggering receiver classification (state: ${callContext.receiverState})...`);
              const ctx = callContext;
              const transcript = humanDetection.getRecentTranscript(ctx.humanDetection!);

              // First try quick pattern check (fast, no LLM call needed)
              const quickResult = humanDetection.quickPatternCheck(transcript);
              if (quickResult) {
                console.log(`[HUMAN-DETECT] ⚡ Quick pattern match: ${quickResult.toUpperCase()}`);
                humanDetection.processClassification(ctx.humanDetection!, {
                  receiver: quickResult,
                  confidence: 0.9,
                  reason: "pattern match",
                }, ctx);
                ctx.receiverState = ctx.humanDetection!.receiverState;

                // Update legacy fields for compatibility
                ctx.partyDetectionComplete = true;
                ctx.detectedPartyType = quickResult === "human" ? "human" : "robotic";
                ctx.partyDetectionTimestamp = Date.now();
                if (quickResult === "ivr") {
                  ctx.isIvrMode = true;
                  ctx.ivrConfidence = 0.9;
                }
              } else {
                // Need LLM classification - run async
                humanDetection.transitionState(ctx.humanDetection!, "CHECKING", "awaiting LLM classification");
                ctx.receiverState = ctx.humanDetection!.receiverState;

                classifyReceiver(transcript, ctx.callId).then((classification) => {
                  humanDetection.processClassification(ctx.humanDetection!, classification, ctx);
                  ctx.receiverState = ctx.humanDetection!.receiverState;

                  // Update legacy fields for compatibility
                  ctx.partyDetectionComplete = true;
                  ctx.detectedPartyType = classification.receiver === "human" ? "human" : "robotic";
                  ctx.partyDetectionTimestamp = Date.now();

                  // If IVR detected, also set isIvrMode for backward compatibility
                  if (classification.receiver === "ivr") {
                    ctx.isIvrMode = true;
                    ctx.ivrConfidence = classification.confidence ?? 0.8;
                    console.log(`[HUMAN-DETECT] 🤖 IVR mode enabled based on LLM classification`);
                  } else if (classification.receiver === "human") {
                    ctx.isIvrMode = false;
                    console.log(`[HUMAN-DETECT] 👤 Human detected - using shorter wait times`);
                  }
                }).catch((err) => {
                  console.error(`[HUMAN-DETECT] ❌ Classification failed:`, err);
                  // On error, stay in CHECKING state for another attempt
                });
              }
            }
          }
        }

        // Set debounce timer - only send to LLM after silence
        // Clear any existing TTS debounce timer first
        if (callContext.ttsDebounceTimer) {
          clearTimeout(callContext.ttsDebounceTimer);
        }

        // Use human detection state machine for wait times
        // LIKELY_HUMAN: shorter wait (~1.5s) for natural conversation
        // LIKELY_IVR/CHECKING/UNKNOWN: longer wait (~3s) to avoid interrupting menus
        let debounceMs: number;
        if (callContext.humanDetection) {
          debounceMs = humanDetection.getWaitTimeMs(callContext.humanDetection, callContext);
          const stateLabel = callContext.receiverState || "UNKNOWN";
          if (callContext.receiverState === "LIKELY_HUMAN") {
            console.log(`[HUMAN-DETECT] 👤 Using human wait: ${debounceMs}ms (state: ${stateLabel})`);
          } else if (callContext.receiverState === "LIKELY_IVR") {
            console.log(`[HUMAN-DETECT] 🤖 Using IVR wait: ${debounceMs}ms (state: ${stateLabel})`);
          } else {
            console.log(`[HUMAN-DETECT] ⏳ Using default wait: ${debounceMs}ms (state: ${stateLabel})`);
          }
        } else {
          // Fallback to legacy IVR timing system
          debounceMs = ivrUtils.getDebounceMs(callContext);
          if (callContext.detectedPartyType === "robotic") {
            console.log(`[PARTY-DETECT] ⚡ Using fast debounce: ${debounceMs}ms (legacy ROBOTIC)`);
          } else if (callContext.isIvrMode) {
            console.log(`[IVR] ⚡ Using fast debounce: ${debounceMs}ms (legacy pattern-based)`);
          } else {
            console.log(`[DEBOUNCE] ⏱️ Setting TTS debounce: ${debounceMs}ms (legacy HUMAN mode)`);
          }
        }

        // Increment turn sequence (invalidates in-flight work from previous turns)
        callContext.turnSeq = (callContext.turnSeq || 0) + 1;
        const currentSeq = callContext.turnSeq;
        callContext.lastTranscriptAt = Date.now();

        // Capture context for closure
        const ctx = callContext;
        const wsRef = ws;

        // Schedule LLM processing after debounce - this is when we send ALL accumulated text
        callContext.ttsDebounceTimer = setTimeout(() => {
          // Join ALL accumulated segments into one complete turn
          const completeTurn = (ctx.accumulatedTurnText || []).join(" ").trim();
          if (completeTurn && wsRef.readyState === WebSocket.OPEN) {
            console.log(`[TRANSCRIPT] Debounce fired - sending complete turn to LLM (${ctx.accumulatedTurnText?.length || 0} segments): "${completeTurn}"`);
            ctx.lastUserTranscript = completeTurn;
            scheduleTtsResponse(ctx, wsRef, currentSeq);
          }
        }, debounceMs);
      } else {
        // No speech_final flag: use fallback timer to detect utterance boundary
        // If no new final chunks arrive within configurable timeout, consider utterance complete

        // Clear any existing timer
        if (callContext.callerFinalFlushTimer) {
          clearTimeout(callContext.callerFinalFlushTimer);
        }

        // Schedule flush timer (configurable silence = utterance boundary)
        // Use IVR-optimized timing if in IVR mode
        const flushMs = ivrUtils.getUtteranceFlushMs(callContext);
        // Capture callContext and ws in local variables for closure
        const ctx = callContext;
        const wsRef = ws;
        callContext.callerFinalFlushTimer = setTimeout(() => {
          console.log(`[TRANSCRIPT] Flush timer fired (${flushMs}ms with no new final chunks)${ctx.isIvrMode ? " [IVR mode]" : ""}`);
          if (ctx) {
            // Get the full accumulated utterance before flushing
            const fullUtterance = [...(ctx.callerFinalBuf || [])].join(" ").trim();

            // Flush the buffer to Supabase (for transcript logging)
            flushCallerUtterance(ctx);
            ctx.callerFinalFlushTimer = undefined;

            // ACCUMULATE for LLM - add this segment to the turn
            if (fullUtterance) {
              if (!ctx.accumulatedTurnText) {
                ctx.accumulatedTurnText = [];
              }
              ctx.accumulatedTurnText.push(fullUtterance);
              console.log(`[TRANSCRIPT] Accumulated turn segment #${ctx.accumulatedTurnText.length} (flush timer): "${fullUtterance}"`);

              // HUMAN DETECTION: Enhanced receiver classification using state machine (flush timer path)
              if (ctx.humanDetection) {
                // Add transcript to detection buffer
                humanDetection.addToTranscriptBuffer(ctx.humanDetection, fullUtterance);

                // Check if we should classify
                const shouldClassify =
                  ctx.receiverState === "UNKNOWN" ||
                  ctx.receiverState === "CHECKING" ||
                  ctx.humanDetection.justExitedHold;

                if (shouldClassify && humanDetection.canClassify(ctx.humanDetection, ctx)) {
                  console.log(`[HUMAN-DETECT] 🎯 Triggering classification (flush timer, state: ${ctx.receiverState})...`);
                  const transcript = humanDetection.getRecentTranscript(ctx.humanDetection);

                  // First try quick pattern check
                  const quickResult = humanDetection.quickPatternCheck(transcript);
                  if (quickResult) {
                    console.log(`[HUMAN-DETECT] ⚡ Quick pattern match (flush timer): ${quickResult.toUpperCase()}`);
                    humanDetection.processClassification(ctx.humanDetection, {
                      receiver: quickResult,
                      confidence: 0.9,
                      reason: "pattern match",
                    }, ctx);
                    ctx.receiverState = ctx.humanDetection.receiverState;
                    ctx.partyDetectionComplete = true;
                    ctx.detectedPartyType = quickResult === "human" ? "human" : "robotic";
                    ctx.partyDetectionTimestamp = Date.now();
                    if (quickResult === "ivr") {
                      ctx.isIvrMode = true;
                      ctx.ivrConfidence = 0.9;
                    }
                  } else {
                    // Need LLM classification
                    humanDetection.transitionState(ctx.humanDetection, "CHECKING", "awaiting LLM (flush timer)");
                    ctx.receiverState = ctx.humanDetection.receiverState;

                    classifyReceiver(transcript, ctx.callId).then((classification) => {
                      humanDetection.processClassification(ctx.humanDetection!, classification, ctx);
                      ctx.receiverState = ctx.humanDetection!.receiverState;
                      ctx.partyDetectionComplete = true;
                      ctx.detectedPartyType = classification.receiver === "human" ? "human" : "robotic";
                      ctx.partyDetectionTimestamp = Date.now();
                      if (classification.receiver === "ivr") {
                        ctx.isIvrMode = true;
                        ctx.ivrConfidence = classification.confidence ?? 0.8;
                        console.log(`[HUMAN-DETECT] 🤖 IVR mode enabled (flush timer)`);
                      } else if (classification.receiver === "human") {
                        ctx.isIvrMode = false;
                        console.log(`[HUMAN-DETECT] 👤 Human detected (flush timer)`);
                      }
                    }).catch((err) => {
                      console.error(`[HUMAN-DETECT] ❌ Classification failed (flush timer):`, err);
                    });
                  }
                }
              }

              // Clear any existing TTS debounce timer
              if (ctx.ttsDebounceTimer) {
                clearTimeout(ctx.ttsDebounceTimer);
              }

              // Use human detection state machine for wait times
              let debounceMs: number;
              if (ctx.humanDetection) {
                debounceMs = humanDetection.getWaitTimeMs(ctx.humanDetection, ctx);
                const stateLabel = ctx.receiverState || "UNKNOWN";
                if (ctx.receiverState === "LIKELY_HUMAN") {
                  console.log(`[HUMAN-DETECT] 👤 Using human wait (flush): ${debounceMs}ms (state: ${stateLabel})`);
                } else if (ctx.receiverState === "LIKELY_IVR") {
                  console.log(`[HUMAN-DETECT] 🤖 Using IVR wait (flush): ${debounceMs}ms (state: ${stateLabel})`);
                } else {
                  console.log(`[HUMAN-DETECT] ⏳ Using default wait (flush): ${debounceMs}ms (state: ${stateLabel})`);
                }
              } else {
                // Fallback to legacy IVR timing
                debounceMs = ivrUtils.getDebounceMs(ctx);
                if (ctx.detectedPartyType === "robotic") {
                  console.log(`[PARTY-DETECT] ⚡ Setting TTS debounce: ${debounceMs}ms (flush timer, legacy ROBOTIC)`);
                } else if (ctx.isIvrMode) {
                  console.log(`[IVR] ⚡ Setting TTS debounce: ${debounceMs}ms (flush timer, legacy pattern-based)`);
                } else {
                  console.log(`[DEBOUNCE] ⏱️ Setting TTS debounce: ${debounceMs}ms (flush timer, legacy HUMAN mode)`);
                }
              }

              // Increment turn sequence
              ctx.turnSeq = (ctx.turnSeq || 0) + 1;
              const currentSeq = ctx.turnSeq;
              ctx.lastTranscriptAt = Date.now();

              // Schedule LLM processing after debounce
              ctx.ttsDebounceTimer = setTimeout(() => {
                const completeTurn = (ctx.accumulatedTurnText || []).join(" ").trim();
                if (completeTurn && wsRef.readyState === WebSocket.OPEN) {
                  console.log(`[TRANSCRIPT] Debounce fired - sending complete turn to LLM (${ctx.accumulatedTurnText?.length || 0} segments): "${completeTurn}"`);
                  ctx.lastUserTranscript = completeTurn;
                  scheduleTtsResponse(ctx, wsRef, currentSeq);
                }
              }, debounceMs);
            }
          }
        }, flushMs);
      }

      // NOTE: We do NOT call queueUserTranscript here!
      // LLM processing only happens when utterance is complete (speech_final or silence timeout)
    } catch (error) {
      console.error(
        "❌ Unexpected error in transcript handler:",
        error instanceof Error ? error.message : error
      );
      if (ws.readyState === WebSocket.OPEN && callContext) {
        ws.send(
          JSON.stringify({
            event: "error",
            payload: { message: "Unexpected error processing transcript" },
          })
        );
      }
    }
  });

  //-----------------------------
  // WebSocket MESSAGE HANDLER
  //-----------------------------
  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch (parseError) {
      console.warn("⚠️ Failed to parse WebSocket message:", parseError instanceof Error ? parseError.message : parseError);
      return;
    }

    try {
      // Capture Telnyx client_state when call starts
      if (msg.event === "start") {
        console.log("🎬 Call started");

        try {
          const start = msg.start || {};
          const clientStateBase64 = start.client_state;
          const callControlId = start.call_control_id;
          const streamId = msg.stream_id;

          let decoded: any = {};
          if (typeof clientStateBase64 === "string" && clientStateBase64.length > 0) {
            const json = Buffer.from(clientStateBase64, "base64").toString("utf8");
            decoded = JSON.parse(json);
          }

          // Initialize or retrieve the CallContext from the context manager
          const managedContext = contextMgr.getOrCreateContext(callControlId);

          // Update with current call information
          managedContext.callControlId = callControlId;
          managedContext.streamId = streamId;
          managedContext.goal = decoded.goal;
          managedContext.additionalContext = decoded.additionalContext || null;
          managedContext.userId = decoded.userId;
          managedContext.assistantName = decoded.assistantName || null;
          managedContext.userName = decoded.userName || null;
          managedContext.systemPrompt = decoded.systemPrompt || null;
          managedContext.rollingSummaryPrompt = decoded.rollingSummaryPrompt || null;
          managedContext.model = decoded.model || null;
          managedContext.temperature = decoded.temperature || null;
          managedContext.maxTokens = decoded.maxTokens || null;
          managedContext.topP = decoded.topP || null;
          managedContext.reasoning = decoded.reasoning || null;
          managedContext.stream = decoded.stream || null;
          managedContext.jsonMode = decoded.jsonMode || null;
          // Call control settings
          managedContext.ttsDebounceMs = decoded.ttsDebounceMs || null;
          managedContext.bargeInCooldownMs = decoded.bargeInCooldownMs || null;
          managedContext.callerUtteranceFlushMs = decoded.callerUtteranceFlushMs || null;
          managedContext.holdCheckInIntervalMs = decoded.holdCheckInIntervalMs || null;
          managedContext.holdMaxCheckIns = decoded.holdMaxCheckIns || null;
          // IVR/Phone Tree settings
          managedContext.ivrDebounceMs = decoded.ivrDebounceMs || null;
          managedContext.ivrUtteranceFlushMs = decoded.ivrUtteranceFlushMs || null;
          managedContext.ivrDtmfMinPauseMs = decoded.ivrDtmfMinPauseMs || null;
          managedContext.ivrDtmfDurationMs = decoded.ivrDtmfDurationMs || null;
          managedContext.ivrAutoDetectThreshold = decoded.ivrAutoDetectThreshold || null;
          managedContext.ivrResponseTimeoutMs = decoded.ivrResponseTimeoutMs || null;
          managedContext.ivrMaxDtmfRetries = decoded.ivrMaxDtmfRetries || null;
          managedContext.ivrDisableBargeInGracePeriod = decoded.ivrDisableBargeInGracePeriod ?? null;
          // Human Detection settings (IVR vs Human state machine)
          managedContext.humanDetectionEnabled = decoded.humanDetectionEnabled ?? null;
          managedContext.humanDetectionUtteranceFlushMs = decoded.humanDetectionUtteranceFlushMs || null;
          managedContext.humanDetectionHumanWaitMs = decoded.humanDetectionHumanWaitMs || null;
          managedContext.humanDetectionIvrWaitMs = decoded.humanDetectionIvrWaitMs || null;
          managedContext.humanDetectionMinUtterances = decoded.humanDetectionMinUtterances || null;
          managedContext.humanDetectionMinTranscriptLength = decoded.humanDetectionMinTranscriptLength || null;
          managedContext.humanDetectionHoldSilenceMs = decoded.humanDetectionHoldSilenceMs || null;
          managedContext.humanDetectionHumanTurnsAfterHold = decoded.humanDetectionHumanTurnsAfterHold || null;
          managedContext.humanDetectionMaxUnsure = decoded.humanDetectionMaxUnsure || null;
          managedContext.initiatedAt = decoded.initiatedAt;
          managedContext.isCallActive = true;
          managedContext.lastUserTranscript = "";
          managedContext.lastTranscriptAt = 0;
          managedContext.deepgramSocket = dgLive;

          // Create the local callContext reference for backward compatibility
          callContext = managedContext;

          // Initialize custom recording buffers if enabled
          if (isCustomRecordingEnabled() && !managedContext.recordingBuffers) {
            managedContext.recordingBuffers = {
              inbound: [],
              outbound: [],
              startedAtMs: Date.now(),
            };
            managedContext.customRecordingDisabledDueToSize = false;
            console.log("[CustomRecording] Buffers initialized for call:", callControlId);
          }

          console.log("📋 Call context initialized:", {
            callId: callContext.callId,
            callControlId: callContext.callControlId,
            goal: callContext.goal,
            userId: callContext.userId,
            customRecordingEnabled: isCustomRecordingEnabled(),
            // Call control settings (per-call overrides)
            ttsDebounceMs: callContext.ttsDebounceMs,
            bargeInCooldownMs: callContext.bargeInCooldownMs,
            callerUtteranceFlushMs: callContext.callerUtteranceFlushMs,
          });

          // Register this machine as the handler for this call (for multi-instance observer routing)
          sharedState.registerCallMachine(callControlId);
        } catch (err) {
          console.error("❌ Failed to decode Telnyx client_state:", err instanceof Error ? err.message : err);
          // Do NOT throw; just continue without context
        }
      }
      // Telnyx media packets → Deepgram + Custom Recording
      else if (msg.event === "media" && msg.media?.payload) {
        // Telnyx sends track information: "inbound" = caller, "outbound" = AI
        const track = msg.media?.track;
        const rawAudio = Buffer.from(msg.media.payload, "base64");

        // ============================================================================
        // AUDIO SMOOTHING: DISABLED FOR TESTING
        // The smoother may be introducing artifacts - testing with raw audio
        // ============================================================================
        const audio = rawAudio;

        // ============================================================================
        // CUSTOM RECORDING: Capture BOTH tracks (inbound + outbound) for self-hosted recording
        // This runs regardless of which track we're processing for STT
        // Uses smoothed audio to eliminate clicks in recordings
        // ============================================================================
        if (
          callContext &&
          callContext.recordingBuffers &&
          !callContext.customRecordingDisabledDueToSize
        ) {
          try {
            // Push smoothed audio chunk to the appropriate track buffer
            if (track === "inbound") {
              callContext.recordingBuffers.inbound.push(audio);
            } else if (track === "outbound") {
              callContext.recordingBuffers.outbound.push(audio);
            }

            // Check size limit to prevent memory exhaustion
            const currentSize = getBufferedSize(callContext.recordingBuffers);
            const maxBytes = getCustomRecordingMaxBytes();
            if (currentSize > maxBytes) {
              console.warn(
                `[CustomRecording] Size limit exceeded (${currentSize} > ${maxBytes}), disabling for this call`
              );
              callContext.customRecordingDisabledDueToSize = true;
              // Clear buffers to free memory
              callContext.recordingBuffers.inbound = [];
              callContext.recordingBuffers.outbound = [];
            }
          } catch (recordingError) {
            // Never throw from recording logic - just log and continue
            console.error(
              "[CustomRecording] Error buffering audio:",
              recordingError instanceof Error ? recordingError.message : recordingError
            );
          }
        }

        // ============================================================================
        // LIVE OBSERVER: Broadcast smoothed audio to any connected observers
        // This allows third-party listening in real-time via browser
        // ============================================================================
        if (callContext?.callControlId && (track === "inbound" || track === "outbound")) {
          observer.broadcastAudio(callContext.callControlId, track, audio);
        }

        // ============================================================================
        // STT: ONLY send inbound audio to Deepgram (caller's voice)
        // Skip outbound (AI's voice) and any undefined/unknown tracks
        // ============================================================================
        if (track !== "inbound") {
          if (process.env.LOG_AUDIO_PACKETS === "true") {
            console.log(`🔄 Skipping non-inbound audio packet for STT (track: ${track || "undefined"})`);
          }
          return;
        }

        // Only log packet details if LOG_AUDIO_PACKETS is enabled (reduces noise in logs)
        if (process.env.LOG_AUDIO_PACKETS === "true") {
          console.log("🎙️ Received inbound audio packet, bytes:", audio.length);
        }
        dgLive.send(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength));
      } else if (msg.event === "stop") {
        console.log("🛑 Telnyx media stream stopped");
        if (callContext) {
          cleanupCallState(callContext);
        }
      }
    } catch (error) {
      console.error("❌ Error processing WebSocket message:", error instanceof Error ? error.message : error);
    }
  });

  ws.on("close", () => {
    console.log("🔌 Client disconnected");
    if (callContext) {
      cleanupCallState(callContext);
    }
    dgLive.finish();
  });
});

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------

// Initialize shared state (Redis for multi-instance support)
sharedState.initSharedState();

// Initialize observer WebSocket server for live call listening
observer.setupObserverWebSocket(server);

// Set up WebSocket upgrade routing
// Routes /observe/* to observer WebSocket, all other paths to main media WebSocket
server.on('upgrade', (request, socket, head) => {
  const url = request.url || '/';

  if (observer.isObserverPath(url)) {
    // Route to observer WebSocket for /observe/:callControlId paths
    console.log(`[WebSocket] Routing upgrade to observer: ${url}`);
    observer.handleObserverUpgrade(request, socket, head);
  } else {
    // Route to main media WebSocket (Telnyx audio stream)
    console.log(`[WebSocket] Routing upgrade to main media WS: ${url}`);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }
});

server.listen(config.port, () => {
  console.log(`🚀 AI Server running on port ${config.port}`);
});
