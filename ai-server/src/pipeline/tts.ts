import axios from "axios";
import config from "../config";

/**
 * Stops the currently playing audio on a Telnyx call.
 * Gracefully handles expected failures (404 = already ended, 409 = already stopping).
 * Uses command_id when available for more targeted stops.
 *
 * @param callControlId - The Telnyx call control ID
 * @param commandId - Optional command_id for targeted stop (from call.speak.started webhook)
 * @throws Only throws on unexpected errors, not on 404/409 (acceptable race conditions)
 */
export async function stopSpeaking(
  callControlId: string,
  commandId?: string
): Promise<void> {
  try {
    console.log("⏹️ Stopping current TTS playback (interrupt detected)", commandId ? `(cmd: ${commandId})` : "");

    const requestBody: Record<string, any> = {};
    if (commandId) {
      requestBody.command_id = commandId;
    }

    await axios.post(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/stop_speak`,
      requestBody,
      {
        headers: {
          "Authorization": `Bearer ${config.telnyx.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 5000, // 5 second timeout to prevent hanging
      }
    );
    console.log("✅ TTS stop command sent successfully");
  } catch (error) {
    // Handle expected race condition responses gracefully
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;

      // 404: No active speak command (already ended, or never started)
      // 409: Conflict (speak is already stopping)
      // Both are acceptable race condition outcomes
      if (status === 404 || status === 409) {
        console.log(`⚠️ TTS stop returned ${status} - speak may have already ended (acceptable race condition)`);
        return; // Don't throw - this is expected
      }

      // 401/403: Authentication issue
      if (status === 401 || status === 403) {
        console.error("❌ TTS stop failed - authentication error:", error.response?.data);
        throw error;
      }

      // Network timeout
      if (error.code === "ECONNABORTED") {
        console.warn("⚠️ TTS stop request timed out");
        return; // Don't throw - timeout is not critical
      }
    }

    // Log other unexpected errors but don't throw
    console.warn(
      "⚠️ Failed to stop TTS:",
      error instanceof Error ? error.message : error
    );
    // Continue - don't throw, as TTS will eventually end anyway
  }
}

/**
 * Speaks text on an active Telnyx call using the speak endpoint.
 * Telnyx handles TTS synthesis and streaming directly.
 *
 * @param aiText - The text to synthesize and speak
 * @param callControlId - The Telnyx call control ID
 */
export async function synthesizeSpeech(
  aiText: string,
  callControlId: string
): Promise<void> {
  const startTime = Date.now();
  console.log("🎤 ========== TTS SYNTHESIS START ==========");
  console.log("📝 Text to synthesize:", aiText);
  console.log("🗣️ TTS Voice:", config.telnyx.ttsVoiceId);
  console.log("📤 Calling Telnyx Speak API...");

  try {
    // Call Telnyx Speak API to synthesize and play audio on the call
    await axios.post(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/speak`,
      {
        payload: aiText,
        voice: config.telnyx.ttsVoiceId,
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
      "✅ Telnyx Speak API responded in",
      apiResponseTime - startTime,
      "ms"
    );
    console.log("🔊 Audio is now playing on the call");
    console.log("⏱️ Total TTS time:", Date.now() - startTime, "ms");
    console.log("==========================================");
  } catch (error) {
    console.error("❌ TTS Error:", error);
    // Log detailed error response if available
    if (error instanceof Error && "response" in error) {
      const err = error as any;
      console.error("📋 Telnyx API Error Details:", {
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
