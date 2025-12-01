import OpenAI from "openai";
import config from "../config";

/**
 * OpenAI TTS client configured with API key
 */
const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

/**
 * Synthesizes speech from text using OpenAI TTS API.
 * Returns 24kHz PCM audio as a Node.js Buffer.
 *
 * @param aiText - The text to synthesize into speech
 * @returns A Buffer containing 24kHz PCM audio data
 */
export async function synthesizeSpeech(aiText: string): Promise<Buffer> {
  const audioResponse = await openai.audio.speech.create({
    model: config.openai.ttsModel,
    voice: config.openai.ttsVoice as "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer",
    input: aiText,
    response_format: "pcm",
  });

  const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
  return audioBuffer;
}
