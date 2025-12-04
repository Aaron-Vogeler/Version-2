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
 * Higher threshold (800) to avoid triggering on telephony noise.
 * Only actual speech (typically 1000+) will be detected as non-silent.
 */
const SILENCE_THRESHOLD_LINEAR = 800;

/**
 * Minimum gap (in samples) between audio to consider it a new segment.
 * 400 samples = 50ms at 8kHz. Prevents detecting brief pauses as segment boundaries.
 */
const MIN_SILENCE_GAP = 400;

/**
 * Fade duration in samples at 8kHz for segment boundaries.
 * 24 samples = 3ms - quick fade at speech start/end
 */
const SEGMENT_FADE_SAMPLES = 24;

/**
 * Crossfade duration for packet boundaries (in samples).
 * 8 samples = 1ms - very short crossfade to smooth discontinuities
 */
const PACKET_CROSSFADE_SAMPLES = 8;

/**
 * Concatenate audio buffers with crossfade smoothing at boundaries.
 * This eliminates clicks caused by discontinuities between packets.
 *
 * @param buffers - Array of μ-law audio chunks
 * @returns Single smoothed μ-law buffer
 */
function concatWithCrossfade(buffers: Buffer[]): Buffer {
  if (!buffers || buffers.length === 0) {
    return Buffer.alloc(0);
  }

  if (buffers.length === 1) {
    return buffers[0];
  }

  // Calculate total size
  const totalSize = buffers.reduce((sum, buf) => sum + buf.length, 0);
  const result = Buffer.alloc(totalSize);

  let offset = 0;

  for (let bufIdx = 0; bufIdx < buffers.length; bufIdx++) {
    const chunk = buffers[bufIdx];

    if (bufIdx === 0) {
      // First chunk: copy entirely
      chunk.copy(result, offset);
      offset += chunk.length;
    } else {
      // Subsequent chunks: apply crossfade at boundary
      const fadeLen = Math.min(
        PACKET_CROSSFADE_SAMPLES,
        chunk.length,
        offset // Can't fade more than what we've written
      );

      if (fadeLen > 0) {
        // Apply crossfade at the boundary
        for (let i = 0; i < fadeLen; i++) {
          const fadeOut = 1 - i / fadeLen; // Previous chunk fades out
          const fadeIn = i / fadeLen; // New chunk fades in

          // Decode both samples to linear PCM
          const prevSample = decodeMulawG711(result[offset - fadeLen + i]);
          const newSample = decodeMulawG711(chunk[i]);

          // Crossfade in linear domain
          const mixed = Math.round(prevSample * fadeOut + newSample * fadeIn);

          // Encode back to μ-law and overwrite
          result[offset - fadeLen + i] = encodeMulawG711(mixed);
        }

        // Copy the rest of the chunk (after crossfade region)
        chunk.copy(result, offset, fadeLen);
        offset += chunk.length - fadeLen;
      } else {
        // No crossfade possible, just copy
        chunk.copy(result, offset);
        offset += chunk.length;
      }
    }
  }

  return result.slice(0, offset);
}

/**
 * Apply fade-in/fade-out smoothing at major speech segment boundaries.
 * Uses higher thresholds and longer windows to detect actual speech segments,
 * not noise fluctuations.
 *
 * @param track - μ-law audio buffer
 * @returns Smoothed μ-law audio buffer
 */
function smoothSegmentBoundaries(track: Buffer): Buffer {
  if (track.length < MIN_SILENCE_GAP) {
    return track;
  }

  // Convert entire track to linear PCM for processing
  const pcmSamples = new Int16Array(track.length);
  for (let i = 0; i < track.length; i++) {
    pcmSamples[i] = decodeMulawG711(track[i]);
  }

  // Find major speech segments using RMS energy over windows
  const WINDOW_SIZE = 80; // 10ms window for energy calculation
  const segments: Array<{ start: number; end: number }> = [];
  let inSegment = false;
  let segmentStart = 0;
  let silenceCounter = 0;

  for (let i = 0; i < pcmSamples.length; i += WINDOW_SIZE) {
    // Calculate RMS energy for this window
    let sumSquares = 0;
    const windowEnd = Math.min(i + WINDOW_SIZE, pcmSamples.length);
    for (let j = i; j < windowEnd; j++) {
      sumSquares += pcmSamples[j] * pcmSamples[j];
    }
    const rms = Math.sqrt(sumSquares / (windowEnd - i));

    const isActive = rms >= SILENCE_THRESHOLD_LINEAR;

    if (!inSegment && isActive) {
      // Start of new segment
      inSegment = true;
      segmentStart = i;
      silenceCounter = 0;
    } else if (inSegment && !isActive) {
      // Potential end of segment - count silence duration
      silenceCounter += WINDOW_SIZE;
      if (silenceCounter >= MIN_SILENCE_GAP) {
        // Confirmed end of segment
        inSegment = false;
        segments.push({ start: segmentStart, end: i - silenceCounter + WINDOW_SIZE });
        silenceCounter = 0;
      }
    } else if (inSegment && isActive) {
      // Reset silence counter if we're back to active
      silenceCounter = 0;
    }
  }

  // Handle segment that runs to the end
  if (inSegment) {
    segments.push({ start: segmentStart, end: pcmSamples.length });
  }

  // Apply fades only at segment boundaries
  for (const segment of segments) {
    // Fade-in at start
    const fadeInEnd = Math.min(segment.start + SEGMENT_FADE_SAMPLES, segment.end);
    for (let i = segment.start; i < fadeInEnd; i++) {
      const t = (i - segment.start) / SEGMENT_FADE_SAMPLES;
      // Smooth cosine fade
      const factor = 0.5 * (1 - Math.cos(Math.PI * t));
      pcmSamples[i] = Math.round(pcmSamples[i] * factor);
    }

    // Fade-out at end
    const fadeOutStart = Math.max(segment.end - SEGMENT_FADE_SAMPLES, segment.start);
    for (let i = fadeOutStart; i < segment.end; i++) {
      const t = (segment.end - i) / SEGMENT_FADE_SAMPLES;
      // Smooth cosine fade
      const factor = 0.5 * (1 - Math.cos(Math.PI * t));
      pcmSamples[i] = Math.round(pcmSamples[i] * factor);
    }
  }

  // Convert back to μ-law
  const smoothedTrack = Buffer.alloc(track.length);
  for (let i = 0; i < pcmSamples.length; i++) {
    smoothedTrack[i] = encodeMulawG711(pcmSamples[i]);
  }

  if (segments.length > 0) {
    console.log(
      `[CustomRecording] Detected ${segments.length} speech segments, applied ${SEGMENT_FADE_SAMPLES / 8}ms fades`
    );
  }

  return smoothedTrack;
}

/**
 * Concatenate an array of Buffers into a single Buffer with crossfade smoothing.
 * Applies 1ms crossfade at each packet boundary to eliminate clicks.
 * @param buffers - Array of Buffer chunks
 * @returns Single concatenated and smoothed Buffer
 */
export function concatTrack(buffers: Buffer[]): Buffer {
  if (!buffers || buffers.length === 0) {
    return Buffer.alloc(0);
  }
  // Use crossfade concatenation to smooth packet boundaries
  const result = concatWithCrossfade(buffers);
  console.log(
    `[CustomRecording] Concatenated ${buffers.length} chunks with ${PACKET_CROSSFADE_SAMPLES / 8}ms crossfades`
  );
  return result;
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
  // Apply segment boundary smoothing to eliminate clicks at speech start/end
  console.log("[CustomRecording] Applying segment boundary smoothing...");
  const smoothedInbound = smoothSegmentBoundaries(inbound);
  const smoothedOutbound = smoothSegmentBoundaries(outbound);

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
