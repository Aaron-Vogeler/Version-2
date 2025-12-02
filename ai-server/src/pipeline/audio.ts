/**
 * Audio pipeline utilities for processing PCM audio streams
 */

/**
 * Convert a 16-bit signed PCM sample to 8-bit mu-law format
 * @param sample - 16-bit signed integer sample
 * @returns 8-bit mu-law encoded byte
 */
function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;

  // Get sign bit
  let sign = (sample >> 8) & 0x80;

  // Get absolute value
  if (sign !== 0) {
    sample = -sample;
  }

  // Clip to valid range
  if (sample > CLIP) {
    sample = CLIP;
  }

  // Compress using mu-law algorithm
  sample = sample + BIAS;

  let exponent = 0;
  let mantissa: number;

  for (exponent = 0; exponent < 8; exponent++) {
    if (sample <= (0xFF << (exponent + 3))) {
      break;
    }
  }

  mantissa = (sample >> (exponent + 3)) & 0x0F;
  let compressed = ((exponent & 0x07) << 4) | mantissa;

  // Flip all bits and set sign
  if (sign === 0) {
    compressed |= 0x80;
  }

  return compressed ^ 0xFF;
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
  console.log("🔍 Debug pcmToMulaw - Input buffer length:", pcmBuffer.length, "bytes");

  // Create mulaw encoded buffer (half the size since we're converting 16-bit to 8-bit)
  const mulawBuffer = Buffer.alloc(pcmBuffer.length / 2);

  // Convert each 16-bit sample to 8-bit mulaw
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    mulawBuffer[i / 2] = linearToMulaw(sample);
  }

  console.log("🔍 Debug pcmToMulaw - Output mulaw buffer length:", mulawBuffer.length, "bytes");
  console.log("🔍 Debug pcmToMulaw - First few mulaw bytes:", Array.from(mulawBuffer.slice(0, 5)));

  return mulawBuffer;
}
