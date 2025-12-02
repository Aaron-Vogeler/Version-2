/**
 * Audio pipeline utilities for processing PCM audio streams.
 * Handles downsampling, mulaw encoding, and chunking for Telnyx PCMU streams.
 */

/**
 * Standard μ-law (mulaw) encoding algorithm (ITU-T G.711).
 * Converts 16-bit linear PCM samples to 8-bit μ-law compressed format.
 *
 * μ-law is a logarithmic compression codec used in telephony.
 * This implementation strictly follows the ITU-T G.711 specification.
 *
 * @param sample - 16-bit signed PCM sample
 * @returns 8-bit μ-law encoded byte
 */
function encodeSampleMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const QUANT_MASK = 0xf;
  const SEG_SHIFT = 4;

  // Extract sign bit
  let sign = (sample & 0x8000) ? 0x80 : 0x00;

  // Work with absolute value
  if (sign !== 0) {
    sample = -sample;
  }

  // Clip to valid range
  if (sample > CLIP) {
    sample = CLIP;
  }

  // Add bias
  sample = sample + BIAS;

  let exponent = 0;
  let mantissa = 0;

  // Find the exponent by finding the highest set bit position
  // This determines which segment (0-7) the sample belongs to
  for (exponent = 7; exponent > 0; exponent--) {
    if ((sample & (0xff << exponent)) !== 0) {
      break;
    }
  }

  // Extract the 4-bit mantissa from the appropriate bits
  mantissa = (sample >> (exponent + 3)) & QUANT_MASK;

  // Combine sign, exponent, and mantissa
  const encoded = sign | (exponent << SEG_SHIFT) | mantissa;

  // Invert for μ-law encoding
  return (~encoded) & 0xff;
}

/**
 * Downsamples 24kHz PCM audio to 8kHz for Telnyx compatibility.
 *
 * OpenAI TTS returns 24kHz PCM (16-bit signed, little-endian) audio.
 * Telnyx expects 8kHz, so we downsample by taking every 3rd sample (24000 / 8000 = 3).
 *
 * This function correctly preserves the 16-bit little-endian sample data
 * by returning a Buffer view of the underlying Int16Array memory.
 *
 * @param pcmBuffer - 24kHz PCM audio buffer (16-bit signed, little-endian)
 * @returns 8kHz PCM audio buffer (16-bit signed, little-endian)
 */
const DECIMATION_FACTOR = 3;
// Heavier low-pass (Blackman-windowed) to reject alias energy before μ-law.
// 191 taps gives ~80 dB stopband attenuation around 4 kHz for 24 kHz input,
// which audibly reduces "warble" when encoded to PCMU.
const LOWPASS_TAPS = createLowpassTaps({
  cutoffHz: 3200,
  sampleRate: 24000,
  numTaps: 191,
});

export function downsample24kHzTo8kHz(pcmBuffer: Buffer): Buffer {
  // Create an Int16Array view of the input buffer (24 kHz samples)
  const samples24k = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.byteLength / 2
  );

  // FIR low-pass filter before decimating by 3. A 63-tap Hann-windowed
  // sinc removes high-frequency energy more aggressively than the
  // previous biquad and avoids warble artifacts once μ-law encoded.
  const samples8k = new Int16Array(Math.floor(samples24k.length / DECIMATION_FACTOR));
  const centerTap = (LOWPASS_TAPS.length - 1) / 2;

  for (let i = 0; i < samples8k.length; i++) {
    const sourceIndex = i * DECIMATION_FACTOR;
    let acc = 0;

    for (let t = 0; t < LOWPASS_TAPS.length; t++) {
      const tapIndex = sourceIndex + t - centerTap;
      const sample = tapIndex >= 0 && tapIndex < samples24k.length ? samples24k[tapIndex] : 0;
      acc += sample * LOWPASS_TAPS[t];
    }

    const clamped = Math.max(-32768, Math.min(32767, Math.round(acc)));
    samples8k[i] = clamped;
  }

  // Wrap the Int16Array's underlying memory in a Buffer.
  // This preserves the 16-bit little-endian sample data correctly.
  // CRITICAL: Do NOT use Buffer.from(samples8k) because that would
  // treat the array as an iterable of numbers and corrupt the data.
  const result = Buffer.from(
    samples8k.buffer,
    samples8k.byteOffset,
    samples8k.byteLength
  );

  console.log(
    "🔍 Debug downsample - Input length:",
    pcmBuffer.length,
    "bytes | Output length:",
    result.length,
    "bytes"
  );

  return result;
}

function createLowpassTaps({
  cutoffHz,
  sampleRate,
  numTaps,
}: {
  cutoffHz: number;
  sampleRate: number;
  numTaps: number;
}): Float64Array {
  const taps = new Float64Array(numTaps);
  const center = (numTaps - 1) / 2;
  const fc = cutoffHz / sampleRate; // normalized cutoff (0..0.5)

  for (let i = 0; i < numTaps; i++) {
    const n = i - center;

    // Blackman window for stronger stopband rejection than Hann/Hamming
    const window =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (numTaps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (numTaps - 1));

    const ideal =
      n === 0
        ? 2 * fc
        : (Math.sin(2 * Math.PI * fc * n) / (Math.PI * n)) * 2 * fc;

    taps[i] = ideal * window;
  }

  // Normalize to unity gain at DC to preserve level
  const sum = taps.reduce((acc, v) => acc + v, 0);
  for (let i = 0; i < numTaps; i++) {
    taps[i] /= sum || 1;
  }

  return taps;
}

/**
 * Converts 16-bit linear PCM audio to 8-bit mulaw format.
 *
 * Telnyx uses PCMU (mulaw) codec for voice calls. This converts the 16-bit
 * linear PCM audio (from OpenAI TTS at 8 kHz) to 8-bit mulaw format.
 *
 * @param pcmBuffer - 16-bit linear PCM audio buffer (8kHz, little-endian)
 * @returns 8-bit mulaw audio buffer (8kHz)
 */
export function pcmToMulaw(pcmBuffer: Buffer): Buffer {
  // Read 16-bit little-endian samples from the input buffer
  const sampleCount = pcmBuffer.length / 2;
  const samples = new Int16Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    samples[i] = pcmBuffer.readInt16LE(i * 2);
  }

  console.log("🔍 Debug pcmToMulaw - Input buffer length:", pcmBuffer.length, "bytes");
  console.log("🔍 Debug pcmToMulaw - Samples count:", samples.length);
  console.log("🔍 Debug pcmToMulaw - First few samples:", Array.from(samples.slice(0, 5)));

  // Encode each 16-bit PCM sample to 8-bit μ-law
  const mulawArray = new Uint8Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    mulawArray[i] = encodeSampleMulaw(samples[i]);
  }

  console.log("🔍 Debug pcmToMulaw - Encoding complete");
  console.log("🔍 Debug pcmToMulaw - Result is Uint8Array, length:", mulawArray.length);
  console.log("🔍 Debug pcmToMulaw - First few encoded bytes:", Array.from(mulawArray.slice(0, 5)));

  // Convert Uint8Array to Buffer
  const mulawBuffer = Buffer.from(mulawArray);
  console.log("🔍 Debug pcmToMulaw - Converted to Buffer, length:", mulawBuffer.length);

  return mulawBuffer;
}

/**
 * Chunks mulaw audio into properly-sized packets for Telnyx streaming.
 *
 * At 8kHz sample rate, 20ms of audio = 160 samples = 160 bytes (8-bit mulaw).
 * This function breaks the mulaw audio into 20ms chunks, which is the standard
 * packet size for VoIP applications and matches Telnyx streaming expectations.
 *
 * @param mulawBuffer - 8-bit mulaw audio buffer (8kHz)
 * @returns Array of 20ms audio chunks (Buffer objects)
 */
export function chunkAudio(mulawBuffer: Buffer): Buffer[] {
  const SAMPLE_RATE = 8000; // Hz
  const CHUNK_DURATION_MS = 20; // milliseconds
  const CHUNK_SIZE = (SAMPLE_RATE / 1000) * CHUNK_DURATION_MS; // 160 bytes per chunk

  const chunks: Buffer[] = [];

  // Slice the buffer into 20ms chunks
  for (let i = 0; i < mulawBuffer.length; i += CHUNK_SIZE) {
    const chunk = mulawBuffer.slice(i, Math.min(i + CHUNK_SIZE, mulawBuffer.length));
    chunks.push(chunk);
  }

  console.log(
    `🔀 Chunked audio into ${chunks.length} packets of ${CHUNK_SIZE} bytes (20ms each)`
  );

  return chunks;
}
