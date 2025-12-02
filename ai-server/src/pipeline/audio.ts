/**
 * Audio pipeline utilities for processing PCM audio streams
 */

/**
 * Standard μ-law (mulaw) encoding algorithm.
 * Converts 16-bit linear PCM samples to 8-bit μ-law compressed format.
 *
 * μ-law is a logarithmic compression codec used in telephony (ITU-T G.711).
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

  // Extract sign bit and work with absolute value
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) {
    sample = -sample;
  }

  // Clip to valid range
  if (sample > CLIP) {
    sample = CLIP;
  }

  // Calculate exponent and mantissa
  let exponent = 0;
  let mantissa = sample + BIAS;

  if (mantissa >= 256) {
    exponent = (Math.log2(mantissa) | 0) - 8;
    mantissa = (mantissa >> (exponent + 3)) & QUANT_MASK;
    exponent = (exponent + 1) << SEG_SHIFT;
  } else {
    mantissa = (mantissa >> 4) & QUANT_MASK;
  }

  // Combine and invert
  return (~(sign | exponent | mantissa)) & 0xff;
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

  const result = Buffer.from(downsampledSamples);
  console.log("🔍 Debug downsample - Input length:", pcmBuffer.length, "Output length:", result.length);
  return result;
}

/**
 * Converts 16-bit linear PCM audio to 8-bit mulaw format.
 *
 * Telnyx uses PCMU (mulaw) codec for voice calls. This converts the 16-bit
 * linear PCM audio (from OpenAI TTS) to 8-bit mulaw format that Telnyx expects.
 *
 * @param pcmBuffer - 16-bit linear PCM audio buffer
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
