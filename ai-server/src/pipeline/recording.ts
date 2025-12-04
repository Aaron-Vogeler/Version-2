/**
 * Custom Call Recording Module
 * =============================
 * Creates stereo WAV files from dual-channel μ-law audio streams.
 *
 * Format: Stereo WAV with 16-bit PCM at 8kHz (decoded from μ-law)
 * - Left channel: inbound (caller)
 * - Right channel: outbound (assistant)
 *
 * The audio is decoded from μ-law to PCM and crossfaded between chunks
 * to eliminate clicking artifacts at chunk boundaries.
 */

// μ-law decoding lookup table for fast conversion
// Pre-computed table maps 8-bit μ-law values to 16-bit linear PCM
const MULAW_DECODE_TABLE: Int16Array = new Int16Array(256);

// Initialize the μ-law decode table
(function initMulawTable() {
  for (let i = 0; i < 256; i++) {
    // μ-law uses inverted bits
    const mulaw = ~i & 0xff;

    // Extract sign, exponent, and mantissa
    const sign = mulaw & 0x80 ? -1 : 1;
    const exponent = (mulaw >> 4) & 0x07;
    const mantissa = mulaw & 0x0f;

    // Reconstruct the linear sample
    // Formula: ((mantissa << 3) + 0x84) << exponent - 0x84
    let sample: number;
    if (exponent === 0) {
      sample = (mantissa << 3) + 0x84;
    } else {
      sample = ((mantissa << 3) + 0x84) << exponent;
    }
    sample -= 0x84;

    MULAW_DECODE_TABLE[i] = sign * sample;
  }
})();

/**
 * Decode a single μ-law byte to 16-bit linear PCM.
 * Uses pre-computed lookup table for speed.
 */
function decodeMulaw(mulaw: number): number {
  return MULAW_DECODE_TABLE[mulaw & 0xff];
}

/**
 * Decode a buffer of μ-law bytes to 16-bit PCM samples.
 * @param mulaw - Buffer of μ-law encoded audio
 * @returns Int16Array of decoded PCM samples
 */
function decodeMulawBuffer(mulaw: Buffer): Int16Array {
  const pcm = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    pcm[i] = decodeMulaw(mulaw[i]);
  }
  return pcm;
}

// Crossfade length in samples (at 8kHz, 32 samples = 4ms)
const CROSSFADE_SAMPLES = 32;

/**
 * Concatenate an array of μ-law Buffers with crossfading to eliminate clicks.
 * Decodes to PCM, applies crossfade between chunks, returns PCM Int16Array.
 *
 * @param buffers - Array of μ-law Buffer chunks
 * @returns Int16Array of decoded and crossfaded PCM samples
 */
export function concatTrackWithCrossfade(buffers: Buffer[]): Int16Array {
  if (!buffers || buffers.length === 0) {
    return new Int16Array(0);
  }

  if (buffers.length === 1) {
    return decodeMulawBuffer(buffers[0]);
  }

  // Calculate total length
  let totalLength = 0;
  for (const buf of buffers) {
    totalLength += buf.length;
  }

  // Subtract overlap regions (we'll blend them)
  const overlapCount = buffers.length - 1;
  const finalLength = totalLength - overlapCount * CROSSFADE_SAMPLES;

  if (finalLength <= 0) {
    // Very short audio, just decode without crossfade
    return decodeMulawBuffer(Buffer.concat(buffers));
  }

  const result = new Int16Array(finalLength);
  let writePos = 0;

  for (let chunkIdx = 0; chunkIdx < buffers.length; chunkIdx++) {
    const chunk = buffers[chunkIdx];
    const pcm = decodeMulawBuffer(chunk);

    if (chunkIdx === 0) {
      // First chunk: write all but the last CROSSFADE_SAMPLES
      const copyLen = Math.max(0, pcm.length - CROSSFADE_SAMPLES);
      for (let i = 0; i < copyLen; i++) {
        result[writePos++] = pcm[i];
      }

      // Store the fade-out portion for blending with next chunk
      if (pcm.length >= CROSSFADE_SAMPLES) {
        const fadeStart = pcm.length - CROSSFADE_SAMPLES;
        for (let i = 0; i < CROSSFADE_SAMPLES; i++) {
          // Fade out: multiply by decreasing factor
          const fadeOut = 1.0 - i / CROSSFADE_SAMPLES;
          result[writePos + i] = Math.round(pcm[fadeStart + i] * fadeOut);
        }
      }
    } else if (chunkIdx === buffers.length - 1) {
      // Last chunk: blend first CROSSFADE_SAMPLES with previous, then write rest
      const blendLen = Math.min(CROSSFADE_SAMPLES, pcm.length);

      for (let i = 0; i < blendLen; i++) {
        // Fade in: multiply by increasing factor, add to existing fade-out
        const fadeIn = i / CROSSFADE_SAMPLES;
        const blended = result[writePos + i] + Math.round(pcm[i] * fadeIn);
        // Clamp to 16-bit range
        result[writePos + i] = Math.max(-32768, Math.min(32767, blended));
      }
      writePos += blendLen;

      // Write the rest of the chunk
      for (let i = blendLen; i < pcm.length; i++) {
        result[writePos++] = pcm[i];
      }
    } else {
      // Middle chunk: blend first CROSSFADE_SAMPLES, write middle, prepare fade-out
      const blendLen = Math.min(CROSSFADE_SAMPLES, pcm.length);

      // Blend with previous chunk's fade-out
      for (let i = 0; i < blendLen; i++) {
        const fadeIn = i / CROSSFADE_SAMPLES;
        const blended = result[writePos + i] + Math.round(pcm[i] * fadeIn);
        result[writePos + i] = Math.max(-32768, Math.min(32767, blended));
      }
      writePos += blendLen;

      // Write middle portion (excluding fade regions)
      const middleEnd = Math.max(blendLen, pcm.length - CROSSFADE_SAMPLES);
      for (let i = blendLen; i < middleEnd; i++) {
        result[writePos++] = pcm[i];
      }

      // Prepare fade-out for next chunk
      if (pcm.length > CROSSFADE_SAMPLES) {
        const fadeStart = pcm.length - CROSSFADE_SAMPLES;
        for (let i = 0; i < CROSSFADE_SAMPLES; i++) {
          const fadeOut = 1.0 - i / CROSSFADE_SAMPLES;
          result[writePos + i] = Math.round(pcm[fadeStart + i] * fadeOut);
        }
      }
    }
  }

  return result;
}

/**
 * Simple concatenation without crossfade (legacy, for reference).
 * @param buffers - Array of Buffer chunks
 * @returns Single concatenated Buffer
 */
export function concatTrack(buffers: Buffer[]): Buffer {
  if (!buffers || buffers.length === 0) {
    return Buffer.alloc(0);
  }
  return Buffer.concat(buffers);
}

/**
 * Interleave two mono PCM tracks into stereo.
 * If track lengths differ, pad the shorter track with silence (0).
 *
 * @param left - Left channel (inbound/caller) PCM samples
 * @param right - Right channel (outbound/assistant) PCM samples
 * @returns Interleaved stereo Int16Array (2x the length of the longer track)
 */
export function interleavePcmStereo(
  left: Int16Array,
  right: Int16Array
): Int16Array {
  const maxLen = Math.max(left.length, right.length);

  if (maxLen === 0) {
    return new Int16Array(0);
  }

  // Allocate stereo buffer (2 samples per frame: 1 left + 1 right)
  const stereo = new Int16Array(maxLen * 2);

  for (let i = 0; i < maxLen; i++) {
    // Get left sample (0 = silence if shorter)
    const leftSample = i < left.length ? left[i] : 0;
    // Get right sample (0 = silence if shorter)
    const rightSample = i < right.length ? right[i] : 0;

    // Interleave: left channel first, then right channel
    stereo[i * 2] = leftSample;
    stereo[i * 2 + 1] = rightSample;
  }

  return stereo;
}

/**
 * Generate a 44-byte WAV header for stereo 16-bit PCM audio.
 *
 * WAV format details:
 * - AudioFormat = 1 (PCM)
 * - NumChannels = 2 (stereo)
 * - SampleRate = 8000 Hz (telephony standard)
 * - BitsPerSample = 16
 * - ByteRate = SampleRate * NumChannels * BitsPerSample/8 = 8000 * 2 * 2 = 32000
 * - BlockAlign = NumChannels * BitsPerSample/8 = 2 * 2 = 4
 *
 * @param dataByteLength - Length of the audio data in bytes
 * @param sampleRate - Sample rate (default: 8000 Hz for telephony)
 * @returns 44-byte WAV header Buffer
 */
export function wavHeaderPcmStereo(
  dataByteLength: number,
  sampleRate: number = 8000
): Buffer {
  const numChannels = 2; // Stereo
  const bitsPerSample = 16; // 16-bit PCM
  const audioFormat = 1; // PCM format

  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  // ChunkSize = 36 + dataByteLength
  const chunkSize = 36 + dataByteLength;

  const header = Buffer.alloc(44);
  let offset = 0;

  // RIFF chunk descriptor
  header.write("RIFF", offset); // ChunkID
  offset += 4;
  header.writeUInt32LE(chunkSize, offset); // ChunkSize
  offset += 4;
  header.write("WAVE", offset); // Format
  offset += 4;

  // fmt sub-chunk
  header.write("fmt ", offset); // Subchunk1ID
  offset += 4;
  header.writeUInt32LE(16, offset); // Subchunk1Size (16 for PCM)
  offset += 4;
  header.writeUInt16LE(audioFormat, offset); // AudioFormat (1 = PCM)
  offset += 2;
  header.writeUInt16LE(numChannels, offset); // NumChannels (2 = stereo)
  offset += 2;
  header.writeUInt32LE(sampleRate, offset); // SampleRate (8000)
  offset += 4;
  header.writeUInt32LE(byteRate, offset); // ByteRate (32000)
  offset += 4;
  header.writeUInt16LE(blockAlign, offset); // BlockAlign (4)
  offset += 2;
  header.writeUInt16LE(bitsPerSample, offset); // BitsPerSample (16)
  offset += 2;

  // data sub-chunk
  header.write("data", offset); // Subchunk2ID
  offset += 4;
  header.writeUInt32LE(dataByteLength, offset); // Subchunk2Size

  return header;
}

/**
 * Convert Int16Array to Buffer (little-endian).
 */
function int16ArrayToBuffer(pcm: Int16Array): Buffer {
  const buffer = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    buffer.writeInt16LE(pcm[i], i * 2);
  }
  return buffer;
}

/**
 * Create a complete stereo PCM WAV file from two mono μ-law track buffers.
 * Decodes μ-law to PCM, applies crossfading, and outputs 16-bit PCM WAV.
 *
 * @param inboundBuffers - Array of inbound (caller/left channel) μ-law buffers
 * @param outboundBuffers - Array of outbound (assistant/right channel) μ-law buffers
 * @returns Complete WAV file as Buffer (header + interleaved PCM audio data)
 */
export function createStereoWavFromBuffers(
  inboundBuffers: Buffer[],
  outboundBuffers: Buffer[]
): Buffer {
  // Decode and crossfade each track
  const inboundPcm = concatTrackWithCrossfade(inboundBuffers);
  const outboundPcm = concatTrackWithCrossfade(outboundBuffers);

  console.log(
    `[CustomRecording] Decoded tracks: inbound=${inboundPcm.length} samples, outbound=${outboundPcm.length} samples`
  );

  // Interleave the two mono PCM tracks into stereo
  const stereoPcm = interleavePcmStereo(inboundPcm, outboundPcm);

  // Convert to buffer
  const stereoData = int16ArrayToBuffer(stereoPcm);

  // Generate WAV header for the stereo data
  const header = wavHeaderPcmStereo(stereoData.length);

  // Sanity check
  if (header.length !== 44) {
    console.error("[CustomRecording] WAV header size mismatch:", header.length);
  }
  if (header.toString("ascii", 0, 4) !== "RIFF") {
    console.error("[CustomRecording] WAV header does not start with RIFF");
  }

  // Concatenate header and audio data
  const wavFile = Buffer.concat([header, stereoData]);

  console.log(
    `[CustomRecording] Created WAV: header=${header.length}B, data=${stereoData.length}B, total=${wavFile.length}B`
  );

  return wavFile;
}

/**
 * Legacy function - kept for backward compatibility but now uses the improved pipeline.
 * @deprecated Use createStereoWavFromBuffers instead
 */
export function createMulawStereoWav(inbound: Buffer, outbound: Buffer): Buffer {
  // Convert single buffers to arrays and use the new function
  return createStereoWavFromBuffers([inbound], [outbound]);
}

/**
 * Calculate the total buffered size for both tracks.
 * Used for size limit checking.
 *
 * @param recordingBuffers - The recording buffers object
 * @returns Total bytes buffered across both tracks
 */
export function getBufferedSize(recordingBuffers: {
  inbound: Buffer[];
  outbound: Buffer[];
}): number {
  const inboundSize = recordingBuffers.inbound.reduce(
    (sum, buf) => sum + buf.length,
    0
  );
  const outboundSize = recordingBuffers.outbound.reduce(
    (sum, buf) => sum + buf.length,
    0
  );
  return inboundSize + outboundSize;
}

/**
 * Environment variable helpers for custom recording feature
 */
export function isCustomRecordingEnabled(): boolean {
  const envValue = process.env.CUSTOM_RECORDING_ENABLED;
  // Default to true if not set
  if (envValue === undefined || envValue === "") {
    return true;
  }
  return envValue.toLowerCase() === "true" || envValue === "1";
}

export function getCustomRecordingMaxBytes(): number {
  const envValue = process.env.CUSTOM_RECORDING_MAX_BYTES;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  // Default: ~50MB total buffers (handles ~50 minutes of dual-track μ-law at 8kHz)
  return 50_000_000;
}
