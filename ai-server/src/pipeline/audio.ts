/**
 * Audio pipeline utilities for processing PCM audio streams
 */

import { encode as encodeMulaw } from 'mu-law';

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

  // Encode Int16Array to mulaw - returns Uint8Array
  let mulawArray: any;
  try {
    mulawArray = encodeMulaw(samples);
    console.log("🔍 Debug pcmToMulaw - Encode successful, result type:", typeof mulawArray);
    if (mulawArray instanceof Uint8Array) {
      console.log("🔍 Debug pcmToMulaw - Result is Uint8Array, length:", mulawArray.length);
    } else {
      console.log("🔍 Debug pcmToMulaw - WARNING: Encode returned:", mulawArray);
    }
  } catch (err) {
    console.error("🔍 Debug pcmToMulaw - Encode threw error:", err);
    throw err;
  }

  // Convert Uint8Array to Buffer
  const mulawBuffer = Buffer.from(mulawArray);
  return mulawBuffer;
}
