/**
 * Custom Call Recording Module
 * =============================
 * Creates stereo WAV files from dual-channel μ-law audio streams.
 *
 * Format: Stereo WAV with μ-law (G.711) encoding at 8kHz
 * - Left channel: inbound (caller)
 * - Right channel: outbound (assistant)
 *
 * WAV Header Structure (44 bytes):
 * - RIFF header: 12 bytes (ChunkID, ChunkSize, Format)
 * - fmt sub-chunk: 24 bytes (SubchunkID, Size, AudioFormat, Channels, SampleRate, ByteRate, BlockAlign, BitsPerSample)
 * - data sub-chunk: 8 bytes header + audio data
 */

/**
 * Decode μ-law to linear PCM sample.
 * @param mulaw - μ-law encoded byte
 * @returns Linear PCM value (-32768 to 32767)
 */
function decodeMulaw(mulaw: number): number {
  mulaw = ~mulaw & 0xff;
  const sign = (mulaw & 0x80) ? -1 : 1;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;

  let sample: number;
  if (exponent === 0) {
    sample = (mantissa << 3) + 132;
  } else {
    sample = ((mantissa << 3) + 132) << exponent;
  }
  sample -= 132;

  return sign * sample;
}

/**
 * Encode linear PCM sample to μ-law.
 * @param sample - Linear PCM value (-32768 to 32767)
 * @returns μ-law encoded byte
 */
function encodeMulaw(sample: number): number {
  const MULAW_MAX = 0x1fff;
  const MULAW_BIAS = 132;

  // Get sign and absolute value
  const sign = sample < 0 ? 0x80 : 0x00;
  if (sample < 0) sample = -sample;

  // Clip to max value
  if (sample > MULAW_MAX) sample = MULAW_MAX;

  // Add bias
  sample += MULAW_BIAS;

  // Find exponent (position of highest set bit)
  let exponent = 0;
  let temp = sample >> 8;
  while (temp > 0) {
    exponent++;
    temp >>= 1;
  }

  // Limit exponent to 7
  if (exponent > 7) exponent = 7;

  // Extract mantissa (4 bits after exponent position)
  const mantissa = (sample >> (exponent + 3)) & 0x0f;

  // Compose μ-law byte and invert
  const mulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;

  return mulaw;
}

/**
 * Apply crossfade between two buffers at the boundary.
 * Smooths the transition to eliminate clicking noises.
 * @param buf1 - First buffer (end will be crossfaded)
 * @param buf2 - Second buffer (start will be crossfaded)
 * @param crossfadeSamples - Number of samples to crossfade (default: 8)
 * @returns Tuple of [modified buf1, modified buf2]
 */
function applyCrossfade(
  buf1: Buffer,
  buf2: Buffer,
  crossfadeSamples: number = 8
): [Buffer, Buffer] {
  // If either buffer is too short for crossfading, return as-is
  if (buf1.length < crossfadeSamples || buf2.length < crossfadeSamples) {
    return [buf1, buf2];
  }

  // Create copies to avoid modifying originals
  const modified1 = Buffer.from(buf1);
  const modified2 = Buffer.from(buf2);

  // Apply crossfade at the boundary
  for (let i = 0; i < crossfadeSamples; i++) {
    // Calculate fade weights (linear crossfade)
    const fade1 = 1.0 - (i / crossfadeSamples); // Fade out buf1
    const fade2 = i / crossfadeSamples;         // Fade in buf2

    // Get samples from end of buf1 and start of buf2
    const idx1 = buf1.length - crossfadeSamples + i;
    const idx2 = i;

    // Decode μ-law to linear PCM
    const sample1 = decodeMulaw(buf1[idx1]);
    const sample2 = decodeMulaw(buf2[idx2]);

    // Apply crossfade
    const blended = sample1 * fade1 + sample2 * fade2;

    // Encode back to μ-law
    modified1[idx1] = encodeMulaw(blended);
    modified2[idx2] = encodeMulaw(blended);
  }

  return [modified1, modified2];
}

/**
 * Concatenate an array of Buffers into a single Buffer with smooth transitions.
 * Applies crossfading at segment boundaries to eliminate clicking noises.
 * @param buffers - Array of Buffer chunks
 * @returns Single concatenated Buffer with smoothed boundaries
 */
export function concatTrack(buffers: Buffer[]): Buffer {
  if (!buffers || buffers.length === 0) {
    return Buffer.alloc(0);
  }

  if (buffers.length === 1) {
    return buffers[0];
  }

  // Apply crossfading between consecutive segments
  const smoothedBuffers: Buffer[] = [];

  for (let i = 0; i < buffers.length; i++) {
    if (i === 0) {
      // First buffer: only crossfade with next
      if (buffers.length > 1) {
        const [modified1, modified2] = applyCrossfade(buffers[0], buffers[1]);
        smoothedBuffers.push(modified1);
        // Store modified2 for next iteration
        buffers[1] = modified2;
      } else {
        smoothedBuffers.push(buffers[0]);
      }
    } else if (i === buffers.length - 1) {
      // Last buffer: already crossfaded with previous
      smoothedBuffers.push(buffers[i]);
    } else {
      // Middle buffers: crossfade with next
      const [modified1, modified2] = applyCrossfade(buffers[i], buffers[i + 1]);
      smoothedBuffers.push(modified1);
      buffers[i + 1] = modified2;
    }
  }

  return Buffer.concat(smoothedBuffers);
}

/**
 * Interleave two mono μ-law tracks into stereo.
 * If track lengths differ, pad the shorter track with silence (0xFF for μ-law).
 *
 * μ-law encoding: 0xFF represents silence (zero amplitude).
 * Interleaving pattern: L0 R0 L1 R1 L2 R2 ...
 *
 * @param left - Left channel (inbound/caller) μ-law bytes
 * @param right - Right channel (outbound/assistant) μ-law bytes
 * @param padByte - Byte value for padding shorter track (default: 0xFF = μ-law silence)
 * @returns Interleaved stereo buffer (2x the length of the longer track)
 */
export function interleaveMulawStereo(
  left: Buffer,
  right: Buffer,
  padByte: number = 0xff
): Buffer {
  const maxLen = Math.max(left.length, right.length);

  // If both are empty, return empty buffer
  if (maxLen === 0) {
    return Buffer.alloc(0);
  }

  // Allocate stereo buffer (2 bytes per sample: 1 left + 1 right)
  const stereo = Buffer.alloc(maxLen * 2);

  for (let i = 0; i < maxLen; i++) {
    // Get left sample (pad with silence if shorter)
    const leftSample = i < left.length ? left[i] : padByte;
    // Get right sample (pad with silence if shorter)
    const rightSample = i < right.length ? right[i] : padByte;

    // Interleave: left channel first, then right channel
    stereo[i * 2] = leftSample;
    stereo[i * 2 + 1] = rightSample;
  }

  return stereo;
}

/**
 * Generate a 44-byte WAV header for stereo μ-law audio.
 *
 * WAV format details:
 * - AudioFormat = 7 (μ-law / PCMU)
 * - NumChannels = 2 (stereo)
 * - SampleRate = 8000 Hz (telephony standard)
 * - BitsPerSample = 8 (μ-law is 8-bit)
 * - ByteRate = SampleRate * NumChannels * BitsPerSample/8 = 8000 * 2 * 1 = 16000
 * - BlockAlign = NumChannels * BitsPerSample/8 = 2 * 1 = 2
 *
 * @param dataByteLength - Length of the audio data in bytes
 * @param sampleRate - Sample rate (default: 8000 Hz for telephony)
 * @returns 44-byte WAV header Buffer
 */
export function wavHeaderMulawStereo(
  dataByteLength: number,
  sampleRate: number = 8000
): Buffer {
  const numChannels = 2; // Stereo
  const bitsPerSample = 8; // μ-law uses 8 bits per sample
  const audioFormat = 7; // μ-law (PCMU) format code per WAV specification

  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  // Total file size = 36 bytes (header without "data" chunk header) + 8 (data chunk header) + data
  // ChunkSize = 4 + (8 + 16) + (8 + dataByteLength) = 36 + dataByteLength
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
  header.writeUInt32LE(16, offset); // Subchunk1Size (16 for PCM/μ-law)
  offset += 4;
  header.writeUInt16LE(audioFormat, offset); // AudioFormat (7 = μ-law)
  offset += 2;
  header.writeUInt16LE(numChannels, offset); // NumChannels (2 = stereo)
  offset += 2;
  header.writeUInt32LE(sampleRate, offset); // SampleRate (8000)
  offset += 4;
  header.writeUInt32LE(byteRate, offset); // ByteRate (16000)
  offset += 4;
  header.writeUInt16LE(blockAlign, offset); // BlockAlign (2)
  offset += 2;
  header.writeUInt16LE(bitsPerSample, offset); // BitsPerSample (8)
  offset += 2;

  // data sub-chunk
  header.write("data", offset); // Subchunk2ID
  offset += 4;
  header.writeUInt32LE(dataByteLength, offset); // Subchunk2Size

  return header;
}

/**
 * Create a complete stereo μ-law WAV file from two mono tracks.
 *
 * @param inbound - Inbound (caller/left channel) μ-law audio buffer
 * @param outbound - Outbound (assistant/right channel) μ-law audio buffer
 * @returns Complete WAV file as Buffer (header + interleaved audio data)
 */
export function createMulawStereoWav(inbound: Buffer, outbound: Buffer): Buffer {
  // Interleave the two mono tracks into stereo
  const stereoData = interleaveMulawStereo(inbound, outbound);

  // Generate WAV header for the stereo data
  const header = wavHeaderMulawStereo(stereoData.length);

  // Sanity check: header should be 44 bytes and start with "RIFF"
  if (header.length !== 44) {
    console.error("[CustomRecording] WAV header size mismatch:", header.length);
  }
  if (header.toString("ascii", 0, 4) !== "RIFF") {
    console.error("[CustomRecording] WAV header does not start with RIFF");
  }

  // Concatenate header and audio data
  const wavFile = Buffer.concat([header, stereoData]);

  console.log(`[CustomRecording] Created WAV: header=${header.length}B, data=${stereoData.length}B, total=${wavFile.length}B`);

  return wavFile;
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
  const inboundSize = recordingBuffers.inbound.reduce((sum, buf) => sum + buf.length, 0);
  const outboundSize = recordingBuffers.outbound.reduce((sum, buf) => sum + buf.length, 0);
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
