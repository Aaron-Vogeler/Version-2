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
 *
 * AUDIO SMOOTHING:
 * - Applies crossfade at segment boundaries to eliminate clicking artifacts
 * - Uses short fade-in/fade-out (2-4ms) at audio-to-silence transitions
 * - Operates in linear PCM domain for accurate fading, then re-encodes to μ-law
 */

// ============================================================================
// μ-LAW CODEC FUNCTIONS (for audio smoothing)
// ============================================================================

/**
 * ITU-T G.711 μ-law decoder.
 * Converts 8-bit μ-law to 16-bit linear PCM.
 * @param mulaw - 8-bit μ-law encoded sample
 * @returns 16-bit linear PCM sample
 */
function decodeMulawG711(mulaw: number): number {
  // Invert the bits (μ-law uses inverted encoding)
  mulaw = ~mulaw & 0xff;

  // Extract sign, exponent, and mantissa
  const sign = mulaw & 0x80 ? -1 : 1;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;

  // Reconstruct the sample
  let sample: number;
  if (exponent === 0) {
    sample = (mantissa << 3) + 132;
  } else {
    sample = ((mantissa << 3) + 132) << exponent;
  }

  // Remove the bias
  sample -= 132;

  return sign * sample;
}

/**
 * ITU-T G.711 μ-law encoder.
 * Converts 16-bit linear PCM to 8-bit μ-law.
 * @param sample - 16-bit linear PCM sample
 * @returns 8-bit μ-law encoded sample
 */
function encodeMulawG711(sample: number): number {
  const BIAS = 0x84; // 132
  const CLIP = 32635; // Maximum before clipping

  // Step 1: Extract sign
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }

  // Step 2: Clip to valid range
  if (sample > CLIP) {
    sample = CLIP;
  }

  // Step 3: Add bias
  sample += BIAS;

  // Step 4: Find segment (exponent) by finding MSB position
  let exponent = 0;
  let mantissa = 0;

  if (sample >= 0x4000) {
    exponent = 7;
    mantissa = (sample >> 10) & 0x0f;
  } else if (sample >= 0x2000) {
    exponent = 6;
    mantissa = (sample >> 9) & 0x0f;
  } else if (sample >= 0x1000) {
    exponent = 5;
    mantissa = (sample >> 8) & 0x0f;
  } else if (sample >= 0x0800) {
    exponent = 4;
    mantissa = (sample >> 7) & 0x0f;
  } else if (sample >= 0x0400) {
    exponent = 3;
    mantissa = (sample >> 6) & 0x0f;
  } else if (sample >= 0x0200) {
    exponent = 2;
    mantissa = (sample >> 5) & 0x0f;
  } else if (sample >= 0x0100) {
    exponent = 1;
    mantissa = (sample >> 4) & 0x0f;
  } else {
    exponent = 0;
    mantissa = (sample >> 3) & 0x0f;
  }

  // Step 5: Combine sign, exponent, mantissa and invert all bits
  const encoded = sign | (exponent << 4) | mantissa;
  return ~encoded & 0xff;
}

// ============================================================================
// AUDIO SMOOTHING FUNCTIONS
// ============================================================================

/**
 * Linear PCM threshold for "silence" detection.
 * Values below this are considered silence (corresponds to very quiet audio).
 */
const SILENCE_THRESHOLD_LINEAR = 100;

/**
 * Fade duration in samples at 8kHz.
 * 32 samples = 4ms - long enough to eliminate clicks, short enough to not affect speech
 */
const FADE_SAMPLES = 32;

/**
 * Apply fade-in/fade-out smoothing to a μ-law audio track.
 * Detects transitions between silence and audio, then applies short fades
 * to eliminate clicking artifacts.
 *
 * @param track - μ-law audio buffer
 * @returns Smoothed μ-law audio buffer
 */
function smoothTrackBoundaries(track: Buffer): Buffer {
  if (track.length < FADE_SAMPLES * 2) {
    // Track too short to smooth meaningfully
    return track;
  }

  // Convert entire track to linear PCM for processing
  const pcmSamples = new Int16Array(track.length);
  for (let i = 0; i < track.length; i++) {
    pcmSamples[i] = decodeMulawG711(track[i]);
  }

  // Find segments (runs of non-silence audio)
  const segments: Array<{ start: number; end: number }> = [];
  let inSegment = false;
  let segmentStart = 0;

  // Use a sliding window to detect segment boundaries (avoid triggering on single samples)
  const WINDOW_SIZE = 4;

  for (let i = 0; i < pcmSamples.length; i++) {
    const isSilent = Math.abs(pcmSamples[i]) < SILENCE_THRESHOLD_LINEAR;

    if (!inSegment && !isSilent) {
      // Check if this is a real segment start (not just noise)
      let nonSilentCount = 0;
      for (let j = i; j < Math.min(i + WINDOW_SIZE, pcmSamples.length); j++) {
        if (Math.abs(pcmSamples[j]) >= SILENCE_THRESHOLD_LINEAR) {
          nonSilentCount++;
        }
      }
      if (nonSilentCount >= WINDOW_SIZE / 2) {
        inSegment = true;
        segmentStart = i;
      }
    } else if (inSegment && isSilent) {
      // Check if this is a real segment end
      let silentCount = 0;
      for (let j = i; j < Math.min(i + WINDOW_SIZE, pcmSamples.length); j++) {
        if (Math.abs(pcmSamples[j]) < SILENCE_THRESHOLD_LINEAR) {
          silentCount++;
        }
      }
      if (silentCount >= WINDOW_SIZE / 2) {
        inSegment = false;
        segments.push({ start: segmentStart, end: i });
      }
    }
  }

  // Handle case where audio runs to the end
  if (inSegment) {
    segments.push({ start: segmentStart, end: pcmSamples.length });
  }

  // Apply fade-in at segment starts and fade-out at segment ends
  for (const segment of segments) {
    // Fade-in at start of segment
    const fadeInEnd = Math.min(segment.start + FADE_SAMPLES, segment.end);
    for (let i = segment.start; i < fadeInEnd; i++) {
      const fadePosition = i - segment.start;
      // Use smooth cosine fade curve
      const fadeFactor = 0.5 * (1 - Math.cos((Math.PI * fadePosition) / FADE_SAMPLES));
      pcmSamples[i] = Math.round(pcmSamples[i] * fadeFactor);
    }

    // Fade-out at end of segment
    const fadeOutStart = Math.max(segment.end - FADE_SAMPLES, segment.start);
    for (let i = fadeOutStart; i < segment.end; i++) {
      const fadePosition = segment.end - i;
      // Use smooth cosine fade curve
      const fadeFactor = 0.5 * (1 - Math.cos((Math.PI * fadePosition) / FADE_SAMPLES));
      pcmSamples[i] = Math.round(pcmSamples[i] * fadeFactor);
    }
  }

  // Convert back to μ-law
  const smoothedTrack = Buffer.alloc(track.length);
  for (let i = 0; i < pcmSamples.length; i++) {
    smoothedTrack[i] = encodeMulawG711(pcmSamples[i]);
  }

  if (segments.length > 0) {
    console.log(
      `[CustomRecording] Smoothed ${segments.length} audio segments (fade: ${FADE_SAMPLES} samples = ${(FADE_SAMPLES / 8).toFixed(1)}ms)`
    );
  }

  return smoothedTrack;
}

/**
 * Concatenate an array of Buffers into a single Buffer.
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
 * Applies audio smoothing to eliminate clicking artifacts at segment boundaries.
 *
 * @param inbound - Inbound (caller/left channel) μ-law audio buffer
 * @param outbound - Outbound (assistant/right channel) μ-law audio buffer
 * @returns Complete WAV file as Buffer (header + interleaved audio data)
 */
export function createMulawStereoWav(inbound: Buffer, outbound: Buffer): Buffer {
  // Apply smoothing to eliminate clicking at segment boundaries
  console.log("[CustomRecording] Applying audio smoothing to eliminate clicks...");
  const smoothedInbound = smoothTrackBoundaries(inbound);
  const smoothedOutbound = smoothTrackBoundaries(outbound);

  // Interleave the two smoothed mono tracks into stereo
  const stereoData = interleaveMulawStereo(smoothedInbound, smoothedOutbound);

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
