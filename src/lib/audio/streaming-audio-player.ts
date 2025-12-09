/**
 * High-Quality Streaming Audio Player
 * ====================================
 * Uses scheduled AudioBufferSourceNode playback with native resampling
 * for smooth, high-quality live audio streaming.
 *
 * Key improvements over ScriptProcessorNode approach:
 * 1. Native browser resampling (high-quality sinc interpolation)
 * 2. Scheduled playback for gapless audio
 * 3. Jitter buffer to handle network variability
 * 4. Separate tracks (inbound/outbound) with stereo output
 */

import { decodeMulawToFloat32, base64ToUint8Array, MULAW_SAMPLE_RATE } from './mulaw-decoder';

export type PlayerState = 'stopped' | 'buffering' | 'playing';

interface ScheduledChunk {
  startTime: number;
  duration: number;
}

/**
 * High-quality streaming audio player using scheduled AudioBufferSourceNode
 *
 * This approach lets the browser's native audio engine handle resampling
 * from 8kHz to the output sample rate (44.1kHz/48kHz) using high-quality
 * algorithms, rather than doing manual linear interpolation.
 */
export class StreamingAudioPlayer {
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private state: PlayerState = 'stopped';
  private onStateChange?: (state: PlayerState) => void;

  // Separate buffers for each track
  private inboundQueue: Float32Array[] = [];
  private outboundQueue: Float32Array[] = [];

  // Scheduling state
  private nextPlayTime: number = 0;
  private isScheduling: boolean = false;
  private scheduledChunks: ScheduledChunk[] = [];

  // Jitter buffer settings
  private readonly JITTER_BUFFER_MS = 150; // Buffer 150ms before starting playback
  private readonly MIN_BUFFER_MS = 50; // Minimum buffer to maintain
  private readonly CHUNK_DURATION_MS = 20; // Telnyx sends ~20ms chunks

  // Stats
  private packetsReceived = 0;
  private totalSamplesBuffered = 0;

  constructor(onStateChange?: (state: PlayerState) => void) {
    this.onStateChange = onStateChange;
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

      // Add to appropriate track queue
      if (track === 'inbound') {
        this.inboundQueue.push(pcmData);
      } else {
        this.outboundQueue.push(pcmData);
      }

      this.totalSamplesBuffered += pcmData.length;

      // Log occasionally
      if (this.packetsReceived <= 3 || this.packetsReceived % 500 === 0) {
        console.log(`[StreamingPlayer] Packet #${this.packetsReceived}, track=${track}, buffered=${this.getBufferedMs().toFixed(0)}ms`);
      }

      // Try to schedule more audio
      this.scheduleAudio();
    } catch (error) {
      console.error('[StreamingPlayer] Error processing audio:', error);
    }
  }

  /**
   * Get currently buffered audio in milliseconds
   */
  private getBufferedMs(): number {
    const inboundSamples = this.inboundQueue.reduce((sum, arr) => sum + arr.length, 0);
    const outboundSamples = this.outboundQueue.reduce((sum, arr) => sum + arr.length, 0);
    const maxSamples = Math.max(inboundSamples, outboundSamples);
    return (maxSamples / MULAW_SAMPLE_RATE) * 1000;
  }

  /**
   * Schedule buffered audio for playback
   */
  private scheduleAudio(): void {
    if (!this.audioContext || !this.gainNode || this.isScheduling) return;

    this.isScheduling = true;

    try {
      const bufferedMs = this.getBufferedMs();
      const currentTime = this.audioContext.currentTime;

      // Clean up old scheduled chunks
      this.scheduledChunks = this.scheduledChunks.filter(
        chunk => chunk.startTime + chunk.duration > currentTime
      );

      // Calculate how much audio is already scheduled
      const scheduledEndTime = this.scheduledChunks.length > 0
        ? Math.max(...this.scheduledChunks.map(c => c.startTime + c.duration))
        : currentTime;
      const scheduledAheadMs = (scheduledEndTime - currentTime) * 1000;

      // If we're not playing yet, wait for jitter buffer to fill
      if (this.state === 'buffering') {
        if (bufferedMs >= this.JITTER_BUFFER_MS) {
          console.log(`[StreamingPlayer] Jitter buffer full (${bufferedMs.toFixed(0)}ms), starting playback`);
          this.setState('playing');
          // Start playback slightly in the future for smoothness
          this.nextPlayTime = currentTime + 0.05;
        } else {
          return;
        }
      }

      // Schedule chunks while we have buffered audio and need more scheduled ahead
      const TARGET_SCHEDULED_AHEAD_MS = 200; // Keep 200ms scheduled ahead

      while (this.getBufferedMs() >= this.CHUNK_DURATION_MS && scheduledAheadMs < TARGET_SCHEDULED_AHEAD_MS) {
        const scheduled = this.scheduleNextChunk();
        if (!scheduled) break;
      }

      // Check if we're running low on buffer
      if (this.state === 'playing' && this.getBufferedMs() < this.MIN_BUFFER_MS && this.scheduledChunks.length === 0) {
        console.log('[StreamingPlayer] Buffer underrun, rebuffering...');
        this.setState('buffering');
      }
    } finally {
      this.isScheduling = false;
    }
  }

  /**
   * Schedule the next chunk of audio
   */
  private scheduleNextChunk(): boolean {
    if (!this.audioContext || !this.gainNode) return false;

    // Get the next chunk from each queue
    const inboundChunk = this.inboundQueue.shift();
    const outboundChunk = this.outboundQueue.shift();

    if (!inboundChunk && !outboundChunk) return false;

    // Determine chunk length (use the longer one)
    const chunkLength = Math.max(
      inboundChunk?.length || 0,
      outboundChunk?.length || 0
    );

    if (chunkLength === 0) return false;

    // Create a stereo AudioBuffer at the native 8kHz sample rate
    // The Web Audio API will automatically resample to output rate using high-quality algorithms
    const audioBuffer = this.audioContext.createBuffer(
      2, // stereo
      chunkLength,
      MULAW_SAMPLE_RATE // 8kHz - let browser handle resampling
    );

    // Fill left channel (inbound/caller)
    const leftChannel = audioBuffer.getChannelData(0);
    if (inboundChunk) {
      leftChannel.set(inboundChunk);
    }
    // Silence is already 0 by default

    // Fill right channel (outbound/assistant)
    const rightChannel = audioBuffer.getChannelData(1);
    if (outboundChunk) {
      rightChannel.set(outboundChunk);
    }

    // Create source node
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode);

    // Ensure we don't schedule in the past
    const currentTime = this.audioContext.currentTime;
    if (this.nextPlayTime < currentTime) {
      this.nextPlayTime = currentTime + 0.01; // Small offset
    }

    // Schedule playback
    source.start(this.nextPlayTime);

    // Track scheduled chunk
    const duration = chunkLength / MULAW_SAMPLE_RATE;
    this.scheduledChunks.push({
      startTime: this.nextPlayTime,
      duration: duration
    });

    // Update next play time
    this.nextPlayTime += duration;

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
    this.inboundQueue = [];
    this.outboundQueue = [];
    this.scheduledChunks = [];
    this.nextPlayTime = 0;
    this.totalSamplesBuffered = 0;
    this.setState('stopped');
    console.log('[StreamingPlayer] Stopped');
  }

  /**
   * Clean up resources
   */
  dispose(): void {
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
