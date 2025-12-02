/**
 * Audio pipeline utilities for processing PCM audio streams
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
  const SEG_MASK = 0x70;

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
 * OpenAI TTS returns 24kHz PCM (16-bit signed) audio. Telnyx expects 8kHz,
 * so we downsample by taking every 3rd sample (24000 / 8000 = 3).
 *
 * @param pcmBuffer - 24kHz PCM audio buffer (16-bit signed)
 * @returns 8kHz PCM audio buffer (16-bit signed)
 */
export function downsample24kHzTo8kHz(pcmBuffer: Buffer): Buffer {
  const samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.byteLength / 2
  );
  const downsampledSamples = new Int16Array(Math.floor(samples.length / 3));

  for (let i = 0; i < downsampledSamples.length; i++) {
    downsampledSamples[i] = samples[i * 3];
  }

  // Create a Buffer that wraps the Int16Array's underlying memory
  // This preserves the 16-bit little-endian sample data
  const result = Buffer.from(
    downsampledSamples.buffer,
    downsampledSamples.byteOffset,
    downsampledSamples.byteLength
  );
  console.log("🔍 Debug downsample - Input length:", pcmBuffer.length, "Output length:", result.length);
  return result;
}

/**
 * Converts 16-bit linear PCM audio to 8-bit mulaw format.
 *
 * Telnyx uses PCMU (mulaw) codec for voice calls. This converts the 16-bit
 * linear PCM audio (from OpenAI TTS) to 8-bit mulaw format that Telnyx expects.
 *
 * @param pcmBuffer - 16-bit linear PCM audio buffer (8kHz sample rate)
 * @returns 8-bit mulaw audio buffer
 */
export function pcmToMulaw(pcmBuffer: Buffer): Buffer {
  // Create a fresh Int16Array from the buffer data
  // This ensures we have a clean, properly-formed Int16Array for the encoder
  const samples = new Int16Array(pcmBuffer.length / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = pcmBuffer.readInt16LE(i * 2);
  }

  console.log("🔍 Debug pcmToMulaw - Input buffer length:", pcmBuffer.length, "bytes");
  console.log("🔍 Debug pcmToMulaw - Samples count:", samples.length);
  console.log("🔍 Debug pcmToMulaw - First few samples:", Array.from(samples.slice(0, 5)));

  // Encode each 16-bit PCM sample to 8-bit μ-law
  const mulawArray = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
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
 * This function breaks the audio into 20ms chunks, which is the standard
 * packet size for VoIP applications.
 *
 * @param mulawBuffer - 8-bit mulaw audio buffer (full audio)
 * @returns Array of 20ms audio chunks
 */
export function chunkAudio(mulawBuffer: Buffer): Buffer[] {
  const SAMPLE_RATE = 8000; // Hz
  const CHUNK_DURATION_MS = 20; // milliseconds
  const CHUNK_SIZE = (SAMPLE_RATE / 1000) * CHUNK_DURATION_MS; // bytes per chunk at 8kHz

  const chunks: Buffer[] = [];

  for (let i = 0; i < mulawBuffer.length; i += CHUNK_SIZE) {
    const chunk = mulawBuffer.slice(i, Math.min(i + CHUNK_SIZE, mulawBuffer.length));
    chunks.push(chunk);
  }

  console.log(`🔀 Chunked audio into ${chunks.length} packets of ${CHUNK_SIZE} bytes (20ms each)`);
  return chunks;
}
