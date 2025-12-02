import axios from "axios";
import config from "../config";

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
