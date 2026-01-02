import axios from "axios";
import config from "../config";
import { accumulateTtsStats } from "../callContextManager";
import { calculateTelnyxTtsCost } from "../utils/supabase";

/**
 * Sends DTMF tones on an active Telnyx call.
 * Used for navigating phone trees and IVR systems.
 *
 * @param callControlId - The Telnyx call control ID
 * @param digits - The DTMF digits to send (0-9, *, #, A-D, w for pause)
 * @param durationMs - Duration of each tone in milliseconds (default: 250ms)
 * @param pauseBetweenDigitsMs - Pause between digits in milliseconds (default: 250ms)
 */
export async function sendDtmf(
  callControlId: string,
  digits: string,
  durationMs: number = 250,
  pauseBetweenDigitsMs: number = 250
): Promise<void> {
  const startTime = Date.now();
  console.log("[DTMF] 📱 ========== DTMF SEND START ==========");
  console.log(`[DTMF] 🔢 Digits to send: "${digits}" (callControlId: ${callControlId})`);
  console.log(`[DTMF] ⏱️ Duration: ${durationMs}ms, Pause: ${pauseBetweenDigitsMs}ms`);

  try {
    await axios.post(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/send_dtmf`,
      {
        digits: digits,
        duration_millis: durationMs,
        // Note: Telnyx API handles inter-digit pause automatically
      },
      {
        headers: {
          "Authorization": `Bearer ${config.telnyx.apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const apiResponseTime = Date.now();
    console.log(`[DTMF] ✅ DTMF sent successfully in ${apiResponseTime - startTime}ms`);
    console.log("[DTMF] ==========================================");
  } catch (error) {
    console.error(`[DTMF] ❌ DTMF Error (callControlId: ${callControlId}):`, error);
    if (error instanceof Error && "response" in error) {
      const err = error as any;
      console.error("[DTMF] 📋 Telnyx API Error Details:", {
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data,
      });
    }
    throw error;
  }
}

/**
 * Stops the currently playing audio on a Telnyx call.
 * Used for handling caller interrupts (barge-in).
 * Uses playback_stop with stop:'all' to halt current playback AND clear queued audio.
 *
 * @param callControlId - The Telnyx call control ID
 */
export async function stopSpeaking(callControlId: string): Promise<void> {
  try {
    console.log("[TTS] ⏹️ Issuing playback_stop(all) - barge-in detected");
    await axios.post(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/playback_stop`,
      { stop: "all" },
      {
        headers: {
          "Authorization": `Bearer ${config.telnyx.apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("[TTS] ✅ Playback stopped (all queued audio cleared)");
  } catch (error) {
    // Log but don't throw - if stop fails, the speak will continue (not critical)
    console.warn(
      "[TTS] ⚠️ Failed to stop playback:",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Splits text at the first punctuation mark for faster initial TTS response.
 * Returns an array with [firstChunk, remainingText] or just [fullText] if no punctuation found.
 * Punctuation marks: . , ! ? ; :
 *
 * @param text - The full text to potentially split
 * @param minFirstChunkLength - Minimum characters before looking for punctuation (default: 10)
 * @returns Array with first chunk and optionally remaining text
 */
export function splitAtFirstPunctuation(
  text: string,
  minFirstChunkLength: number = 10
): [string, string | null] {
  // Punctuation marks that indicate a natural break point
  const punctuationRegex = /[.,!?;:]/;

  // Search for first punctuation after minimum length
  const searchStart = Math.min(minFirstChunkLength, text.length);
  const searchArea = text.slice(searchStart);
  const match = searchArea.match(punctuationRegex);

  if (match && match.index !== undefined) {
    // Found punctuation - split at that point (include the punctuation in first chunk)
    const splitIndex = searchStart + match.index + 1;
    const firstChunk = text.slice(0, splitIndex).trim();
    const remaining = text.slice(splitIndex).trim();

    // Only split if remaining text is meaningful (more than just whitespace)
    if (remaining.length > 0) {
      console.log(`[TTS] 🔀 Splitting text at first punctuation: "${firstChunk.slice(0, 50)}..." + "${remaining.slice(0, 50)}..."`);
      return [firstChunk, remaining];
    }
  }

  // No suitable split point found, return full text
  return [text, null];
}

/**
 * Speaks text on an active Telnyx call using the speak endpoint.
 * Telnyx handles TTS synthesis and streaming directly.
 *
 * @param aiText - The text to synthesize and speak
 * @param callControlId - The Telnyx call control ID
 * @param voiceId - Optional custom voice ID (overrides config default)
 * @param callId - Optional call ID for cost tracking (from CallContext.callId)
 */
export async function synthesizeSpeech(
  aiText: string,
  callControlId: string,
  voiceId?: string,
  callId?: string
): Promise<void> {
  const startTime = Date.now();
  const effectiveVoiceId = voiceId || config.telnyx.ttsVoiceId;
  console.log("[TTS] 🎤 ========== TTS SYNTHESIS START ==========");
  console.log(`[TTS] 📝 Text to synthesize (callControlId: ${callControlId}):`, aiText);
  console.log("[TTS] 🗣️ TTS Voice:", effectiveVoiceId);
  console.log("[TTS] 📤 Calling Telnyx Speak API...");

  try {
    // Call Telnyx Speak API to synthesize and play audio on the call
    // NOTE: This HTTP response returns BEFORE audio finishes playing.
    // Actual playback start/end is tracked via webhooks (call.speak.started/ended).
    await axios.post(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/speak`,
      {
        payload: aiText,
        voice: effectiveVoiceId,
      },
      {
        headers: {
          "Authorization": `Bearer ${config.telnyx.apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const apiResponseTime = Date.now();
    console.log(
      `[TTS] ✅ Telnyx Speak API responded in ${apiResponseTime - startTime}ms (callControlId: ${callControlId})`
    );
    console.log("[TTS] 🔊 Speak request submitted (audio will play asynchronously)");
    console.log("[TTS] ⏱️ Total API call time:", Date.now() - startTime, "ms");
    console.log("[TTS] ==========================================");

    // Track TTS cost if callId provided
    if (callId) {
      const ttsCost = calculateTelnyxTtsCost(aiText.length);
      accumulateTtsStats(callId, aiText, effectiveVoiceId, ttsCost);
    }
  } catch (error) {
    console.error(`[TTS] ❌ TTS Error (callControlId: ${callControlId}):`, error);
    // Log detailed error response if available
    if (error instanceof Error && "response" in error) {
      const err = error as any;
      console.error("[TTS] 📋 Telnyx API Error Details:", {
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data,
      });
    }
    throw error;
  }
}

/**
 * Hangs up an active Telnyx call.
 * Called after the AI says "Chow" to end the conversation.
 *
 * @param callControlId - The Telnyx call control ID
 */
export async function hangupCall(callControlId: string): Promise<void> {
  try {
    console.log("📞 Initiating call hangup...");
    await axios.post(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`,
      {},
      {
        headers: {
          "Authorization": `Bearer ${config.telnyx.apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("✅ Call hangup initiated successfully");
  } catch (error) {
    console.error(
      "❌ Failed to hangup call:",
      error instanceof Error ? error.message : error
    );
    if (error instanceof Error && "response" in error) {
      const err = error as any;
      console.error("📋 Telnyx Hangup Error Details:", {
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data,
      });
    }
    throw error;
  }
}
