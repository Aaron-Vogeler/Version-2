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
  let sum = 0;
  let sumSquares = 0;

  for (let i = 0; i < sampleCount; i++) {
    const s = pcmBuffer.readInt16LE(i * 2);
    samples[i] = s;
    if (s < min) min = s;
    if (s > max) max = s;
    sum += Math.abs(s);
    sumSquares += s * s;
  }

  // Calculate RMS (Root Mean Square) - indicator of audio loudness
  const rms = Math.sqrt(sumSquares / sampleCount);
  const avgAmplitude = sum / sampleCount;

  // Very small histogram just to see distribution
  let nearZero = 0;
  let low = 0;      // -5k..5k
  let mid = 0;      // -15k..15k
  let high = 0;     // outside that
  let clipped = 0;  // samples at or near max/min

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
    if (Math.abs(s) >= 32700) {
      clipped++;
    }
  }

  // Calculate expected duration (24kHz sample rate)
  const durationMs = (sampleCount / 24000) * 1000;

  console.log("🔍 ========== TTS PCM ANALYSIS ==========");
  console.log("📊 Buffer Info:");
  console.log("   • Buffer length:", pcmBuffer.length, "bytes");
  console.log("   • Sample count:", sampleCount);
  console.log("   • Expected duration:", durationMs.toFixed(2), "ms");
  console.log("   • Sample rate: 24000 Hz (expected)");
  console.log("");
  console.log("📈 Amplitude Stats:");
  console.log("   • Min sample:", min);
  console.log("   • Max sample:", max);
  console.log("   • Peak range:", max - min);
  console.log("   • RMS amplitude:", rms.toFixed(2));
  console.log("   • Avg amplitude:", avgAmplitude.toFixed(2));
  console.log("   • Clipped samples:", clipped, `(${((clipped / sampleCount) * 100).toFixed(2)}%)`);
  console.log("");
  console.log("📊 Distribution Histogram:");
  console.log("   • Near zero (-100 to 100):", nearZero, `(${((nearZero / sampleCount) * 100).toFixed(1)}%)`);
  console.log("   • Low (-5k to 5k):", low, `(${((low / sampleCount) * 100).toFixed(1)}%)`);
  console.log("   • Mid (-15k to 15k):", mid, `(${((mid / sampleCount) * 100).toFixed(1)}%)`);
  console.log("   • High (±15k+):", high, `(${((high / sampleCount) * 100).toFixed(1)}%)`);
  console.log("");
  console.log("🔍 First 10 samples:", Array.from(samples.slice(0, 10)));
  console.log("🔍 Last 10 samples:", Array.from(samples.slice(-10)));
  console.log("========================================");
}

/**
 * Synthesizes speech from text using OpenAI TTS API.
 * Returns 24kHz PCM audio as a Node.js Buffer.
 *
 * @param aiText - The text to synthesize into speech
 * @returns A Buffer containing 24kHz PCM audio data
 */
export async function synthesizeSpeech(aiText: string): Promise<Buffer> {
  const startTime = Date.now();
  console.log("🎤 ========== TTS SYNTHESIS START ==========");
  console.log("📝 Text to synthesize:", aiText);
  console.log("🔧 TTS Model:", config.openai.ttsModel);
  console.log("🗣️ TTS Voice:", config.openai.ttsVoice);
  console.log("📤 Calling OpenAI TTS API...");

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

  const apiResponseTime = Date.now();
  console.log("✅ OpenAI API responded in", (apiResponseTime - startTime), "ms");

  const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

  const bufferParseTime = Date.now();
  console.log("✅ Audio buffer parsed in", (bufferParseTime - apiResponseTime), "ms");

  // 🔎 NEW: analyze the raw PCM before we touch it
  analyzePcmBuffer(audioBuffer);

  console.log("⏱️ Total TTS synthesis time:", (Date.now() - startTime), "ms");
  console.log("==========================================");

  return audioBuffer;
}
