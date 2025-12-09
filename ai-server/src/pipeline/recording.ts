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
 * Audio Quality Features:
 * - Crossfade smoothing at speaker transitions to prevent clipping
 * - Sample-level interleaving for perfect sync
 */

// μ-law constants
const MULAW_SILENCE = 0xff; // μ-law encoding of zero/silence
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

// Crossfade configuration (samples at 8kHz)
// 10ms crossfade = 80 samples, provides smooth transitions without noticeable delay
const CROSSFADE_SAMPLES = 80;

// Silence detection threshold - samples near 0xFF are considered silence
// In μ-law, values 0xFE-0xFF and 0x7E-0x7F are very quiet
const SILENCE_THRESHOLD_HIGH = 0xfe; // Near positive silence
const SILENCE_THRESHOLD_LOW = 0x7e; // Near negative silence

/**
 * Check if a μ-law sample is near silence
 */
function isMulawSilent(sample: number): boolean {
  return (
    sample >= SILENCE_THRESHOLD_HIGH || // 0xFE, 0xFF
    (sample >= SILENCE_THRESHOLD_LOW && sample <= 0x7f) // 0x7E, 0x7F
  );
}

/**
 * Decode a single μ-law byte to 16-bit PCM
 * Used for crossfade calculations
 */
function decodeMulaw(mulaw: number): number {
  mulaw = ~mulaw;
  const sign = mulaw & 0x80;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

/**
 * Encode a 16-bit PCM sample to μ-law
 * Used for crossfade calculations
 */
function encodeMulaw(pcm: number): number {
  const sign = pcm < 0 ? 0x80 : 0;
  if (pcm < 0) pcm = -pcm;
  if (pcm > MULAW_CLIP) pcm = MULAW_CLIP;
  pcm += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}

  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  const mulaw = ~(sign | (exponent << 4) | mantissa);
  return mulaw & 0xff;
}

/**
 * Apply crossfade between two μ-law samples
 * @param from - Starting sample (being faded out)
 * @param to - Ending sample (being faded in)
 * @param progress - Crossfade progress (0 = all 'from', 1 = all 'to')
 */
function crossfadeMulaw(from: number, to: number, progress: number): number {
  // Decode both samples to PCM
  const fromPcm = decodeMulaw(from);
  const toPcm = decodeMulaw(to);

  // Linear crossfade in PCM domain
  const mixed = Math.round(fromPcm * (1 - progress) + toPcm * progress);

  // Encode back to μ-law
  return encodeMulaw(mixed);
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
 * Detect speaker transition points and apply crossfade smoothing to a track.
 * This prevents audio clipping/popping when transitioning from silence to speech.
 *
 * @param track - μ-law audio buffer
 * @returns Smoothed μ-law audio buffer with crossfades at transitions
 */
export function applySpeakerTransitionSmoothing(track: Buffer): Buffer {
  if (track.length < CROSSFADE_SAMPLES * 2) {
    return track; // Too short for smoothing
  }

  const result = Buffer.from(track); // Copy to avoid modifying original

  // Scan for transitions from silence to audio and vice versa
  let wasInSilence = isMulawSilent(track[0]);
  let transitionStart = -1;

  for (let i = 1; i < track.length; i++) {
    const isNowSilent = isMulawSilent(track[i]);

    if (wasInSilence !== isNowSilent) {
      // Transition detected
      transitionStart = i;

      // Apply crossfade around the transition point
      const fadeStart = Math.max(0, i - CROSSFADE_SAMPLES / 2);
      const fadeEnd = Math.min(track.length, i + CROSSFADE_SAMPLES / 2);
      const fadeLength = fadeEnd - fadeStart;

      if (fadeLength > 1) {
        for (let j = 0; j < fadeLength; j++) {
          const idx = fadeStart + j;
          const progress = j / fadeLength;

          if (wasInSilence) {
            // Transitioning from silence to audio: fade in
            result[idx] = crossfadeMulaw(MULAW_SILENCE, track[idx], progress);
          } else {
            // Transitioning from audio to silence: fade out
            result[idx] = crossfadeMulaw(track[idx], MULAW_SILENCE, progress);
          }
        }
      }

      wasInSilence = isNowSilent;
    }
  }

  return result;
}

/**
 * Interleave two mono μ-law tracks into stereo with crossfade smoothing.
 * If track lengths differ, pad the shorter track with silence (0xFF for μ-law).
 * Applies crossfade smoothing at speaker transitions to prevent clipping.
 *
 * μ-law encoding: 0xFF represents silence (zero amplitude).
 * Interleaving pattern: L0 R0 L1 R1 L2 R2 ...
 *
 * @param left - Left channel (inbound/caller) μ-law bytes
 * @param right - Right channel (outbound/assistant) μ-law bytes
 * @param padByte - Byte value for padding shorter track (default: 0xFF = μ-law silence)
 * @param enableCrossfade - Apply crossfade smoothing at transitions (default: true)
 * @returns Interleaved stereo buffer (2x the length of the longer track)
 */
export function interleaveMulawStereo(
  left: Buffer,
  right: Buffer,
  padByte: number = 0xff,
  enableCrossfade: boolean = true
): Buffer {
  const maxLen = Math.max(left.length, right.length);

  // If both are empty, return empty buffer
  if (maxLen === 0) {
    return Buffer.alloc(0);
  }

  // Apply speaker transition smoothing to each track before interleaving
  const smoothedLeft = enableCrossfade ? applySpeakerTransitionSmoothing(left) : left;
  const smoothedRight = enableCrossfade ? applySpeakerTransitionSmoothing(right) : right;

  // Allocate stereo buffer (2 bytes per sample: 1 left + 1 right)
  const stereo = Buffer.alloc(maxLen * 2);

  for (let i = 0; i < maxLen; i++) {
    // Get left sample (pad with silence if shorter)
    const leftSample = i < smoothedLeft.length ? smoothedLeft[i] : padByte;
    // Get right sample (pad with silence if shorter)
    const rightSample = i < smoothedRight.length ? smoothedRight[i] : padByte;

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
