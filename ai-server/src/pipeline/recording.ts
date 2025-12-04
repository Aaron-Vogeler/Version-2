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
 * Check if a buffer is mostly silence.
 * @param buffer - Audio buffer to check
 * @param threshold - Ratio of silence samples required (0-1)
 * @returns true if buffer is mostly silence
 */
function isSilenceBuffer(buffer: Buffer, threshold: number = 0.9): boolean {
  if (buffer.length === 0) return true;

  let silenceCount = 0;
  for (let i = 0; i < buffer.length; i++) {
    // μ-law silence is 0xFF or very close to it
    if (buffer[i] >= 0xFD) {
      silenceCount++;
    }
  }

  return (silenceCount / buffer.length) >= threshold;
}

/**
 * Apply a fade-out to the end of a buffer (linear fade to 0xFF).
 * @param buffer - Buffer to fade
 * @param fadeSamples - Number of samples to fade
 * @returns Faded buffer
 */
function applyFadeOut(buffer: Buffer, fadeSamples: number): Buffer {
  if (buffer.length < fadeSamples) {
    fadeSamples = buffer.length;
  }

  const faded = Buffer.from(buffer);
  const startIdx = buffer.length - fadeSamples;

  for (let i = 0; i < fadeSamples; i++) {
    const fadePos = i / fadeSamples; // 0 to 1
    const currentSample = buffer[startIdx + i];
    // Linear fade towards silence (0xFF)
    faded[startIdx + i] = Math.round(currentSample + (0xFF - currentSample) * fadePos);
  }

  return faded;
}

/**
 * Apply a fade-in from the start of a buffer (linear fade from 0xFF).
 * @param buffer - Buffer to fade
 * @param fadeSamples - Number of samples to fade
 * @returns Faded buffer
 */
function applyFadeIn(buffer: Buffer, fadeSamples: number): Buffer {
  if (buffer.length < fadeSamples) {
    fadeSamples = buffer.length;
  }

  const faded = Buffer.from(buffer);

  for (let i = 0; i < fadeSamples; i++) {
    const fadePos = i / fadeSamples; // 0 to 1
    const currentSample = buffer[i];
    // Linear fade from silence (0xFF) to actual sample
    faded[i] = Math.round(0xFF + (currentSample - 0xFF) * fadePos);
  }

  return faded;
}

/**
 * Concatenate an array of Buffers into a single Buffer.
 * Applies fade-in/fade-out at speech boundaries to eliminate clicks.
 * @param buffers - Array of Buffer chunks
 * @returns Single concatenated Buffer with smooth speech transitions
 */
export function concatTrack(buffers: Buffer[]): Buffer {
  if (!buffers || buffers.length === 0) {
    return Buffer.alloc(0);
  }

  if (buffers.length === 1) {
    return buffers[0];
  }

  const FADE_SAMPLES = 8; // 1ms fade at 8kHz
  const processedBuffers: Buffer[] = [];

  // Track previous packet state
  let prevWasSilence = true;

  for (let i = 0; i < buffers.length; i++) {
    const currentBuffer = buffers[i];
    const currentIsSilence = isSilenceBuffer(currentBuffer);

    let processedBuffer = currentBuffer;

    // Detect speech start (silence -> speech transition)
    if (prevWasSilence && !currentIsSilence) {
      // Apply fade-in to smooth the speech onset
      processedBuffer = applyFadeIn(currentBuffer, FADE_SAMPLES);
    }
    // Detect speech end (speech -> silence transition)
    else if (!prevWasSilence && currentIsSilence) {
      // Apply fade-out to the previous buffer (if we can still modify it)
      if (processedBuffers.length > 0) {
        const lastIdx = processedBuffers.length - 1;
        processedBuffers[lastIdx] = applyFadeOut(processedBuffers[lastIdx], FADE_SAMPLES);
      }
    }

    processedBuffers.push(processedBuffer);
    prevWasSilence = currentIsSilence;
  }

  return Buffer.concat(processedBuffers);
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
