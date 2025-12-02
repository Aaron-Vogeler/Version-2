import OpenAI from "openai";
import config from "../config";

/**
 * OpenAI TTS client configured with API key
 */
const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

/**
 * Quick helper to inspect raw PCM from OpenAI.
 * This will tell us if the samples look like real 16-bit audio
 * or if we're mis-interpreting the format.
 */
function analyzePcmBuffer(pcmBuffer: Buffer) {
  // Interpret as 16-bit little-endian samples
  const sampleCount = pcmBuffer.length / 2;
  const samples = new Int16Array(sampleCount);

  let min = 32767;
  let max = -32768;

  for (let i = 0; i < sampleCount; i++) {
    const s = pcmBuffer.readInt16LE(i * 2);
    samples[i] = s;
    if (s < min) min = s;
    if (s > max) max = s;
  }

  // Very small histogram just to see distribution
  let nearZero = 0;
  let low = 0;      // -5k..5k
  let mid = 0;      // -15k..15k
  let high = 0;     // outside that

  for (let i = 0; i < sampleCount; i++) {
    const s = samples[i];
    if (s >= -100 && s <= 100) {
      nearZero++;
    } else if (s >= -5000 && s <= 5000) {
      low++;
    } else if (s >= -15000 && s <= 15000) {
      mid++;
    } else {
      high++;
    }
  }

  console.log("🔍 TTS PCM analysis:");
  console.log("   Buffer length:", pcmBuffer.length, "bytes");
  console.log("   Sample count:", sampleCount);
  console.log("   Min sample:", min, " Max sample:", max);
  console.log(
    "   Histogram approx -> nearZero:",
    nearZero,
    "| low:",
    low,
    "| mid:",
    mid,
    "| high:",
    high
  );
}

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
    voice: config.openai.ttsVoice as
      | "alloy"
      | "echo"
      | "fable"
      | "onyx"
      | "nova"
      | "shimmer",
    input: aiText,
    response_format: "pcm",
  });

  const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

  // 🔎 NEW: analyze the raw PCM before we touch it
  analyzePcmBuffer(audioBuffer);

  return audioBuffer;
}
