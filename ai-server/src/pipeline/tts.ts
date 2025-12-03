import axios from "axios";
import config from "../config";

/**
 * Stops the currently playing audio on a Telnyx call.
 * Used for handling caller interrupts.
 *
 * @param callControlId - The Telnyx call control ID
 */
export async function stopSpeaking(callControlId: string): Promise<void> {
  try {
    console.log("⏹️ Stopping current TTS playback (interrupt detected)");
    await axios.post(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/stop_speak`,
      {},
      {
        headers: {
          "Authorization": `Bearer ${config.telnyx.apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("✅ TTS playback stopped");
  } catch (error: any) {
    // Gracefully ignore 404 (call not found) and 422 (nothing playing or invalid state)
    // These typically mean the audio is already stopped or the call is no longer active
    if (error.response && (error.response.status === 404 || error.response.status === 422)) {
      console.log("📍 TTS already stopped or call not active (no action needed)");
      return;
    }
    // Log but don't throw - if stop fails, the speak will continue (not critical)
    console.warn(
      "⚠️ Failed to stop TTS:",
      error instanceof Error ? error.message : error
    );
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
