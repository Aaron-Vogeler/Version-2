import express from "express";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import axios from "axios";
import config from "./config";
import outboundCallRouter from "./routes/outbound-call";
import { downsample24kHzTo8kHz, pcmToMulaw, chunkAudio, normalizePcm, boostBeforeMulaw } from "./pipeline/audio";
import { createDeepgramClient } from "./pipeline/stt";
import { generateAssistantReply, type CallContext, maybeUpdateSummaryForCall } from "./pipeline/llm";
import { synthesizeSpeech, stopSpeaking, hangupCall } from "./pipeline/tts";
import * as contextMgr from "./callContextManager";
import { upsertCall, safeUpdateStatus, updateCall, isSupabaseConfigured, insertTranscriptSegment, uploadCustomCallRecording } from "./utils/supabase";
import {
  createMulawStereoWav,
  concatTrack,
  getBufferedSize,
  isCustomRecordingEnabled,
  getCustomRecordingMaxBytes,
} from "./pipeline/recording";

// Constants
const TTS_DEBOUNCE_MS = 500; // 500 milliseconds of silence before responding (reduced from 800ms for faster response)

// -----------------------------------------------------------------------------
// CLIENTS
// -----------------------------------------------------------------------------
const deepgram = createDeepgramClient();

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

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
  // Update the transcript and timestamp
  callContext.lastUserTranscript = transcript;
  callContext.lastTranscriptAt = Date.now();

  // Increment turn sequence (invalidates in-flight work from previous turns)
  callContext.turnSeq = (callContext.turnSeq || 0) + 1;
  const currentSeq = callContext.turnSeq;

  // Clear any existing debounce timer
  if (callContext.ttsDebounceTimer) {
    clearTimeout(callContext.ttsDebounceTimer);
  }

  // Schedule a new TTS response timer
  callContext.ttsDebounceTimer = setTimeout(() => {
    scheduleTtsResponse(callContext, ws, currentSeq);
  }, TTS_DEBOUNCE_MS);
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

    // Append assistant turn to the call context if callId is available
    if (callContext.callId) {
      contextMgr.appendTurn(callContext.callId, {
        speaker: "assistant",
        text: aiText,
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
    await sendTtsResponse(callContext, ws, aiText, expectedSeq);

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
  const shouldHangup = /\bchow\b/i.test(aiText);
  if (shouldHangup) {
    console.log("👋 Detected 'Chow' in AI response - will hangup after TTS");
  }

  try {
    // IMPORTANT: Set ttsState to 'speaking' BEFORE calling synthesizeSpeech
    // This enables barge-in detection while audio is being queued/played
    callContext.ttsState = "speaking";
    callContext.speakWasInterrupted = false; // Reset interruption flag
    callContext.currentSpeakText = aiText; // Store text for logging on completion
    console.log(`[TTS] Setting ttsState='speaking' (callControlId: ${callContext.callControlId})`);

    await synthesizeSpeech(aiText, callContext.callControlId);

    // Log what TTS will actually speak (only logged after successful TTS API call)
    console.log("🤖 AI (speaking):", aiText);

    // NOTE: Do NOT set ttsState='idle' here!
    // The HTTP response returns BEFORE audio finishes playing.
    // Telnyx webhooks (call.speak.ended) will set ttsState='idle' when playback truly ends.

    // If AI said "Chow", wait a moment then hangup
    if (shouldHangup && callContext.callControlId) {
      console.log("⏳ Waiting 2 seconds for TTS to complete before hangup...");
      await new Promise(resolve => setTimeout(resolve, 2000));

      try {
        await hangupCall(callContext.callControlId);
        console.log("📞 Call ended after 'Chow'");
      } catch (hangupError) {
        console.error("❌ Hangup failed:", hangupError);
      }
    }
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
 * Updates the calls table with custom_recording_url.
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
      // Update the call record with custom_recording_url
      // NOTE: This does NOT overwrite recording_url (Telnyx native recording)
      if (isSupabaseConfigured()) {
        await updateCall(callControlId, {
          custom_recording_url: result.url,
        });
        console.log(`[CustomRecording] Updated call ${callControlId} with custom_recording_url`);
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
}

// -----------------------------------------------------------------------------
// APP + SERVER
// -----------------------------------------------------------------------------
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

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
        // Start recording
        await axios.post(
          `https://api.telnyx.com/v2/calls/${callControlId}/actions/record_start`,
          {
            format: "mp3",
            channels: "dual",
          },
          {
            headers: {
              "Authorization": `Bearer ${config.telnyx.apiKey}`,
              "Content-Type": "application/json",
            },
          }
        );
        console.log("🎙️ Recording started for call:", callControlId);

        // Start streaming
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
    if (callControlId) {
      const ctx = contextMgr.getContext(callControlId);
      if (ctx) {
        ctx.ttsState = "speaking";
        ctx.speakStartedAt = Date.now(); // Record when playback actually started
        console.log(`[TTS] 🔊 call.speak.started - ttsState='speaking' (callControlId: ${callControlId})`);
      } else {
        console.warn(`[TTS] ⚠️ call.speak.started for unknown callControlId: ${callControlId}`);
      }
    }
  } else if (eventType === "call.speak.ended") {
    // TTS playback has ended
    if (callControlId) {
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
      } else {
        console.warn(`[TTS] ⚠️ call.speak.ended for unknown callControlId: ${callControlId}`);
      }
    }
  } else if (eventType === "call.playback.ended") {
    // Belt-and-suspenders: Also handle generic playback.ended
    if (callControlId) {
      const ctx = contextMgr.getContext(callControlId);
      if (ctx) {
        ctx.ttsState = "idle";
        console.log(`[TTS] ✅ call.playback.ended - ttsState='idle' (callControlId: ${callControlId})`);
      } else {
        console.warn(`[TTS] ⚠️ call.playback.ended for unknown callControlId: ${callControlId}`);
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
  } else if (eventType === "call.recording.saved") {
    // Log recording URL to Supabase
    const recordingUrl =
      payload.public_recording_urls?.mp3 ||
      payload.public_recording_urls?.wav ||
      payload.recording_urls?.mp3 ||
      payload.recording_url ||
      null;

    if (callControlId && recordingUrl && isSupabaseConfigured()) {
      console.log("🎙️ Recording saved:", recordingUrl);
      updateCall(callControlId, {
        recording_url: recordingUrl,
      }).catch((err) => console.error("[Supabase] Error logging recording:", err));
    }
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
  dgLive.on(LiveTranscriptionEvents.SpeechStarted, () => {
    // Log for debugging, but don't trigger barge-in on VAD alone
    if (callContext?.ttsState === "speaking") {
      console.log("[VAD] SpeechStarted detected while AI speaking (waiting for actual words before barge-in)");
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

      // ============================================================================
      // BARGE-IN: Trigger on any recognized words (interim or final) for responsiveness
      // ============================================================================
      if (callContext.ttsState === "speaking" && callContext.callControlId) {
        // Apply cooldown to prevent spamming the stop endpoint
        const now = Date.now();
        if (!callContext.bargeInCooldownUntil || now >= callContext.bargeInCooldownUntil) {
          console.log(`[BARGE-IN] 🛑 Words detected while AI speaking: "${userText}" (callControlId: ${callContext.callControlId})`);

          // Set cooldown (300ms) to prevent multiple rapid stops
          callContext.bargeInCooldownUntil = now + 300;

          // Mark as stopping
          callContext.ttsState = "stopping";

          // Mark current speech as interrupted (prevents logging partial speech)
          callContext.speakWasInterrupted = true;

          // Issue playback stop
          try {
            await stopSpeaking(callContext.callControlId);
          } catch (stopError) {
            console.error("[BARGE-IN] ❌ Error stopping playback:", stopError);
          }

          // Clear any pending TTS debounce timer (we'll queue new response below)
          if (callContext.ttsDebounceTimer) {
            clearTimeout(callContext.ttsDebounceTimer);
            callContext.ttsDebounceTimer = undefined;
          }

          // Clear any pending caller utterance flush (we'll start fresh)
          if (callContext.callerFinalFlushTimer) {
            clearTimeout(callContext.callerFinalFlushTimer);
            callContext.callerFinalFlushTimer = undefined;
          }

          // Increment turn sequence to invalidate any in-flight LLM/TTS work
          callContext.turnSeq = (callContext.turnSeq || 0) + 1;
          console.log(`[TURN] Turn sequence incremented to ${callContext.turnSeq} (stale responses will be dropped)`);

          // Mark as idle after stop
          callContext.ttsState = "idle";
        } else {
          console.log(`[BARGE-IN] Cooldown active, skipping (${callContext.bargeInCooldownUntil - now}ms remaining)`);
        }
      }

      // ============================================================================
      // TRANSCRIPT LOGGING: Only log FINAL recognized speech
      // ============================================================================
      // Only process final transcript chunks (is_final=true)
      if (!isFinal) {
        // Don't log interim transcripts to Supabase; only queue for responsiveness
        // Queue the (interim) transcript with debounce for LLM response
        queueUserTranscript(callContext, userText, ws);
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
      // UTTERANCE BOUNDARY: Flush on speech_final or with fallback timer
      // ============================================================================
      const isSpeechFinal = speechFinal === true;

      if (isSpeechFinal) {
        // speech_final flag indicates end of utterance
        console.log("[TRANSCRIPT] speech_final detected, flushing utterance");

        // Clear any pending flush timer
        if (callContext.callerFinalFlushTimer) {
          clearTimeout(callContext.callerFinalFlushTimer);
          callContext.callerFinalFlushTimer = undefined;
        }

        // Flush the buffer
        flushCallerUtterance(callContext);
      } else {
        // No speech_final flag: use fallback timer to detect utterance boundary
        // If no new final chunks arrive within 300ms, consider the utterance complete

        // Clear any existing timer
        if (callContext.callerFinalFlushTimer) {
          clearTimeout(callContext.callerFinalFlushTimer);
        }

        // Schedule flush timer (300ms of silence = utterance boundary)
        // Capture callContext in local variable to avoid closure issues with TypeScript
        const ctx = callContext;
        callContext.callerFinalFlushTimer = setTimeout(() => {
          console.log("[TRANSCRIPT] Flush timer fired (300ms with no new final chunks)");
          if (ctx) {
            flushCallerUtterance(ctx);
            ctx.callerFinalFlushTimer = undefined;
          }
        }, 300);
      }

      // Queue the transcript with debounce for LLM response
      queueUserTranscript(callContext, userText, ws);
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
          managedContext.userId = decoded.userId;
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
          });
        } catch (err) {
          console.error("❌ Failed to decode Telnyx client_state:", err instanceof Error ? err.message : err);
          // Do NOT throw; just continue without context
        }
      }
      // Telnyx media packets → Deepgram + Custom Recording
      else if (msg.event === "media" && msg.media?.payload) {
        // Telnyx sends track information: "inbound" = caller, "outbound" = AI
        const track = msg.media?.track;
        const audio = Buffer.from(msg.media.payload, "base64");

        // ============================================================================
        // CUSTOM RECORDING: Capture BOTH tracks (inbound + outbound) for self-hosted recording
        // This runs regardless of which track we're processing for STT
        // ============================================================================
        if (
          callContext &&
          callContext.recordingBuffers &&
          !callContext.customRecordingDisabledDueToSize
        ) {
          try {
            // Push audio chunk to the appropriate track buffer (no filtering)
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
server.listen(config.port, () => {
  console.log(`🚀 AI Server running on port ${config.port}`);
});
