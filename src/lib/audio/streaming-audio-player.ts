/**
 * High-Quality Streaming Audio Player
 * ====================================
 * Mimics the recording playback approach by accumulating audio into
 * large continuous buffers before playback, minimizing chunk boundaries.
 *
 * Key design principles (matching recording quality):
 * 1. Accumulate audio into continuous buffers (like recording does)
 * 2. Play larger chunks (200ms+) to minimize boundary artifacts
 * 3. Sample-level track synchronization
 * 4. Native browser resampling from 8kHz
 * 5. Crossfade smoothing at speaker transitions to prevent clipping
 */

import { decodeMulawToFloat32, base64ToUint8Array, MULAW_SAMPLE_RATE } from './mulaw-decoder';

export type PlayerState = 'stopped' | 'buffering' | 'playing';

// Crossfade configuration (samples at 8kHz)
// 10ms crossfade = 80 samples, provides smooth transitions without noticeable delay
const CROSSFADE_SAMPLES = 80;

// Silence detection threshold for Float32 audio (-1 to 1 range)
// Values near zero are considered silence
const SILENCE_THRESHOLD = 0.02;

/**
 * Check if a Float32 sample is near silence
 */
function isNearSilence(sample: number): boolean {
  return Math.abs(sample) < SILENCE_THRESHOLD;
}

/**
 * Apply crossfade smoothing to a Float32 audio buffer at speaker transitions.
 * Detects transitions from silence to audio (and vice versa) and applies
 * fade-in/fade-out to prevent clipping.
 */
function applySpeakerTransitionSmoothing(samples: Float32Array): Float32Array {
  if (samples.length < CROSSFADE_SAMPLES * 2) {
    return samples; // Too short for smoothing
  }

  const result = new Float32Array(samples);

  // Track whether we're in a silence region
  let wasInSilence = isNearSilence(samples[0]);

  for (let i = 1; i < samples.length; i++) {
    const isNowSilent = isNearSilence(samples[i]);

    if (wasInSilence !== isNowSilent) {
      // Transition detected - apply crossfade around this point
      const fadeStart = Math.max(0, i - Math.floor(CROSSFADE_SAMPLES / 2));
      const fadeEnd = Math.min(samples.length, i + Math.floor(CROSSFADE_SAMPLES / 2));
      const fadeLength = fadeEnd - fadeStart;

      if (fadeLength > 1) {
        for (let j = 0; j < fadeLength; j++) {
          const idx = fadeStart + j;
          const progress = j / fadeLength;

          if (wasInSilence) {
            // Transitioning from silence to audio: fade in
            // Use smooth ease-in curve for natural sound
            const fadeIn = progress * progress; // Quadratic ease-in
            result[idx] = samples[idx] * fadeIn;
          } else {
            // Transitioning from audio to silence: fade out
            // Use smooth ease-out curve for natural sound
            const fadeOut = 1 - ((1 - progress) * (1 - progress)); // Quadratic ease-out
            result[idx] = samples[idx] * (1 - fadeOut);
          }
        }
      }

      wasInSilence = isNowSilent;
    }
  }

  return result;
}

/**
 * Apply crossfade at chunk boundaries to prevent clicks between scheduled chunks.
 * This smooths the transition between consecutive audio buffers.
 */
function applyChunkBoundaryCrossfade(
  samples: Float32Array,
  previousLastSamples: Float32Array | null,
  isFirstChunk: boolean
): Float32Array {
  if (samples.length === 0) return samples;

  const result = new Float32Array(samples);
  const fadeLength = Math.min(CROSSFADE_SAMPLES, Math.floor(samples.length / 4));

  // Apply fade-in at the start if we have previous samples
  if (previousLastSamples && previousLastSamples.length > 0 && !isFirstChunk) {
    for (let i = 0; i < fadeLength; i++) {
      const progress = i / fadeLength;
      // Smooth S-curve: 3t² - 2t³ (Hermite interpolation)
      const smoothProgress = progress * progress * (3 - 2 * progress);
      result[i] = samples[i] * smoothProgress;
    }
  }

  return result;
}

/**
 * Circular buffer for efficient continuous audio accumulation
 */
class CircularAudioBuffer {
  private buffer: Float32Array;
  private writePos: number = 0;
  private readPos: number = 0;
  private availableSamples: number = 0;

  constructor(maxSamples: number) {
    this.buffer = new Float32Array(maxSamples);
  }

  /**
   * Write samples to the buffer
   */
  write(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % this.buffer.length;

      // If we're about to overwrite unread data, advance read position
      if (this.availableSamples >= this.buffer.length) {
        this.readPos = (this.readPos + 1) % this.buffer.length;
      } else {
        this.availableSamples++;
      }
    }
  }

  /**
   * Read samples from the buffer
   */
  read(count: number): Float32Array | null {
    if (this.availableSamples < count) {
      return null;
    }

    const result = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      result[i] = this.buffer[this.readPos];
      this.readPos = (this.readPos + 1) % this.buffer.length;
    }
    this.availableSamples -= count;
    return result;
  }

  /**
   * Read up to count samples (may return less if not enough available)
   */
  readUpTo(count: number): Float32Array {
    const toRead = Math.min(count, this.availableSamples);
    if (toRead === 0) {
      return new Float32Array(0);
    }

    const result = new Float32Array(toRead);
    for (let i = 0; i < toRead; i++) {
      result[i] = this.buffer[this.readPos];
      this.readPos = (this.readPos + 1) % this.buffer.length;
    }
    this.availableSamples -= toRead;
    return result;
  }

  /**
   * Peek at the last N samples without consuming them
   * Used for crossfade between chunks
   */
  peekLast(count: number): Float32Array {
    const toRead = Math.min(count, this.availableSamples);
    if (toRead === 0) {
      return new Float32Array(0);
    }

    const result = new Float32Array(toRead);
    let peekPos = this.readPos;
    for (let i = 0; i < toRead; i++) {
      result[i] = this.buffer[peekPos];
      peekPos = (peekPos + 1) % this.buffer.length;
    }
    return result;
  }

  /**
   * Get number of available samples
   */
  available(): number {
    return this.availableSamples;
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this.writePos = 0;
    this.readPos = 0;
    this.availableSamples = 0;
  }
}

/**
 * High-quality streaming audio player using continuous buffer accumulation
 */
export class StreamingAudioPlayer {
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private state: PlayerState = 'stopped';
  private onStateChange?: (state: PlayerState) => void;

  // Continuous circular buffers for each track (5 seconds max)
  private readonly MAX_BUFFER_SAMPLES = MULAW_SAMPLE_RATE * 5;
  private inboundBuffer: CircularAudioBuffer;
  private outboundBuffer: CircularAudioBuffer;

  // Track total samples received for synchronization
  private inboundSamplesReceived: number = 0;
  private outboundSamplesReceived: number = 0;

  // Scheduling state
  private nextPlayTime: number = 0;
  private scheduledEndTime: number = 0;
  private scheduleTimer: number | null = null;

  // Crossfade state - track last samples from previous chunk for smooth transitions
  private lastInboundSamples: Float32Array | null = null;
  private lastOutboundSamples: Float32Array | null = null;
  private isFirstChunk: boolean = true;

  // Playback settings - larger chunks = fewer boundaries = smoother audio
  // Recording plays as one continuous stream, so we use very large chunks
  private readonly JITTER_BUFFER_MS = 300; // Buffer 300ms before starting
  private readonly PLAYBACK_CHUNK_MS = 500; // Play 500ms chunks (25x larger than before!)
  private readonly SCHEDULE_AHEAD_MS = 1000; // Keep 1 second scheduled ahead
  private readonly MIN_BUFFER_MS = 200; // Minimum buffer to maintain

  // Stats
  private packetsReceived = 0;

  constructor(onStateChange?: (state: PlayerState) => void) {
    this.onStateChange = onStateChange;
    this.inboundBuffer = new CircularAudioBuffer(this.MAX_BUFFER_SAMPLES);
    this.outboundBuffer = new CircularAudioBuffer(this.MAX_BUFFER_SAMPLES);
  }

  /**
   * Initialize the audio context (must be called after user gesture)
   */
  async initialize(): Promise<void> {
    if (this.audioContext) return;

    this.audioContext = new AudioContext();

    // Create gain node for volume control
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = 1.0;
    this.gainNode.connect(this.audioContext.destination);

    // Resume context if suspended (browser autoplay policy)
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    console.log('[StreamingPlayer] Initialized, output sample rate:', this.audioContext.sampleRate);
    this.setState('buffering');

    // Start the scheduling loop
    this.startScheduleLoop();
  }

  /**
   * Start the scheduling loop (runs every 50ms)
   */
  private startScheduleLoop(): void {
    if (this.scheduleTimer !== null) return;

    const scheduleLoop = () => {
      this.scheduleAudio();
      this.scheduleTimer = window.setTimeout(scheduleLoop, 50);
    };
    scheduleLoop();
  }

  /**
   * Stop the scheduling loop
   */
  private stopScheduleLoop(): void {
    if (this.scheduleTimer !== null) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  /**
   * Add audio chunk from WebSocket
   */
  addAudio(track: 'inbound' | 'outbound', mulawBase64: string): void {
    if (!this.audioContext) return;

    this.packetsReceived++;

    try {
      const mulawData = base64ToUint8Array(mulawBase64);
      const pcmData = decodeMulawToFloat32(mulawData);

      // Add to appropriate track buffer
      if (track === 'inbound') {
        this.inboundBuffer.write(pcmData);
        this.inboundSamplesReceived += pcmData.length;
      } else {
        this.outboundBuffer.write(pcmData);
        this.outboundSamplesReceived += pcmData.length;
      }

      // Log occasionally
      if (this.packetsReceived <= 3 || this.packetsReceived % 500 === 0) {
        const bufferedMs = this.getBufferedMs();
        console.log(`[StreamingPlayer] Packet #${this.packetsReceived}, track=${track}, buffered=${bufferedMs.toFixed(0)}ms`);
      }
    } catch (error) {
      console.error('[StreamingPlayer] Error processing audio:', error);
    }
  }

  /**
   * Get currently buffered audio in milliseconds
   * Uses the maximum of both tracks since we can play silence on the other
   */
  private getBufferedMs(): number {
    const maxSamples = Math.max(
      this.inboundBuffer.available(),
      this.outboundBuffer.available()
    );
    return (maxSamples / MULAW_SAMPLE_RATE) * 1000;
  }

  /**
   * Get the synchronized buffer amount (minimum of both tracks)
   */
  private getSyncedBufferedMs(): number {
    const minSamples = Math.min(
      this.inboundBuffer.available(),
      this.outboundBuffer.available()
    );
    return (minSamples / MULAW_SAMPLE_RATE) * 1000;
  }

  /**
   * Schedule buffered audio for playback
   */
  private scheduleAudio(): void {
    if (!this.audioContext || !this.gainNode) return;

    const currentTime = this.audioContext.currentTime;

    // If we're not playing yet, wait for jitter buffer to fill
    if (this.state === 'buffering') {
      const bufferedMs = this.getBufferedMs();
      if (bufferedMs >= this.JITTER_BUFFER_MS) {
        console.log(`[StreamingPlayer] Jitter buffer full (${bufferedMs.toFixed(0)}ms), starting playback`);
        this.setState('playing');
        // Start playback slightly in the future
        this.nextPlayTime = currentTime + 0.1;
        this.scheduledEndTime = this.nextPlayTime;
      } else {
        return;
      }
    }

    // Schedule more audio chunks while we need more scheduled ahead and have buffered data
    let scheduledCount = 0;
    const maxSchedulePerLoop = 5; // Prevent infinite loops

    while (scheduledCount < maxSchedulePerLoop) {
      const scheduledAheadMs = Math.max(0, (this.scheduledEndTime - currentTime) * 1000);
      const bufferedMs = this.getBufferedMs();

      // Stop if we have enough scheduled ahead or not enough buffered
      if (scheduledAheadMs >= this.SCHEDULE_AHEAD_MS || bufferedMs < this.PLAYBACK_CHUNK_MS) {
        break;
      }

      const scheduled = this.scheduleNextChunk();
      if (!scheduled) break;
      scheduledCount++;
    }

    // Check if we're running low on buffer and nothing scheduled
    const finalBufferedMs = this.getBufferedMs();
    if (this.state === 'playing' && finalBufferedMs < this.MIN_BUFFER_MS && this.scheduledEndTime <= currentTime) {
      console.log('[StreamingPlayer] Buffer underrun, rebuffering...');
      this.setState('buffering');
    }
  }

  /**
   * Schedule the next chunk of audio with crossfade smoothing
   */
  private scheduleNextChunk(): boolean {
    if (!this.audioContext || !this.gainNode) return false;

    const chunkSamples = Math.floor((this.PLAYBACK_CHUNK_MS / 1000) * MULAW_SAMPLE_RATE);

    // Read from both buffers - read up to chunkSamples, may get less
    let inboundSamples = this.inboundBuffer.readUpTo(chunkSamples);
    let outboundSamples = this.outboundBuffer.readUpTo(chunkSamples);

    // Determine the chunk length (use the longer track)
    const actualLength = Math.max(inboundSamples.length, outboundSamples.length);

    // Need at least some data to play
    if (actualLength === 0) return false;

    // Apply speaker transition smoothing to each track
    // This prevents clipping when transitioning from silence to speech
    if (inboundSamples.length > 0) {
      inboundSamples = applySpeakerTransitionSmoothing(inboundSamples);
      // Apply chunk boundary crossfade for seamless transitions between chunks
      inboundSamples = applyChunkBoundaryCrossfade(
        inboundSamples,
        this.lastInboundSamples,
        this.isFirstChunk
      );
      // Save last samples for next chunk's crossfade
      this.lastInboundSamples = inboundSamples.slice(-CROSSFADE_SAMPLES);
    }

    if (outboundSamples.length > 0) {
      outboundSamples = applySpeakerTransitionSmoothing(outboundSamples);
      // Apply chunk boundary crossfade for seamless transitions between chunks
      outboundSamples = applyChunkBoundaryCrossfade(
        outboundSamples,
        this.lastOutboundSamples,
        this.isFirstChunk
      );
      // Save last samples for next chunk's crossfade
      this.lastOutboundSamples = outboundSamples.slice(-CROSSFADE_SAMPLES);
    }

    this.isFirstChunk = false;

    // Create a stereo AudioBuffer at native 8kHz sample rate
    // Browser handles resampling with high-quality algorithms
    const audioBuffer = this.audioContext.createBuffer(
      2, // stereo
      actualLength,
      MULAW_SAMPLE_RATE
    );

    // Fill left channel (inbound/caller) - zeros are silence by default
    const leftChannel = audioBuffer.getChannelData(0);
    if (inboundSamples.length > 0) {
      leftChannel.set(inboundSamples);
    }

    // Fill right channel (outbound/assistant) - zeros are silence by default
    const rightChannel = audioBuffer.getChannelData(1);
    if (outboundSamples.length > 0) {
      rightChannel.set(outboundSamples);
    }

    // Create source node
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode);

    // Ensure we don't schedule in the past
    const currentTime = this.audioContext.currentTime;
    if (this.nextPlayTime < currentTime) {
      // We've fallen behind, jump ahead with small buffer
      this.nextPlayTime = currentTime + 0.02;
    }

    // Schedule playback at precise time
    source.start(this.nextPlayTime);

    // Update timing for next chunk
    const chunkDuration = actualLength / MULAW_SAMPLE_RATE;
    this.nextPlayTime += chunkDuration;
    this.scheduledEndTime = this.nextPlayTime;

    return true;
  }

  /**
   * Set volume (0-1)
   */
  setVolume(volume: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
    }
  }

  /**
   * Get current volume
   */
  getVolume(): number {
    return this.gainNode?.gain.value ?? 1;
  }

  /**
   * Stop playback and clear buffers
   */
  stop(): void {
    this.inboundBuffer.clear();
    this.outboundBuffer.clear();
    this.inboundSamplesReceived = 0;
    this.outboundSamplesReceived = 0;
    this.nextPlayTime = 0;
    this.scheduledEndTime = 0;
    // Reset crossfade state
    this.lastInboundSamples = null;
    this.lastOutboundSamples = null;
    this.isFirstChunk = true;
    this.setState('stopped');
    console.log('[StreamingPlayer] Stopped');
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.stopScheduleLoop();
    this.stop();
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    console.log('[StreamingPlayer] Disposed');
  }

  /**
   * Get current state
   */
  getState(): PlayerState {
    return this.state;
  }

  /**
   * Check if currently playing
   */
  get playing(): boolean {
    return this.state === 'playing';
  }

  private setState(newState: PlayerState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.onStateChange?.(newState);
    }
  }
}
