/**
 * AudioWorklet-based Streaming Audio Player
 * ==========================================
 * Uses AudioWorkletNode for glitch-free, continuous audio playback.
 *
 * Key improvements over the previous BufferSourceNode approach:
 * 1. NO chunk boundaries - audio flows as a continuous stream
 * 2. Sample-accurate timing on the audio rendering thread
 * 3. Smooth resampling from 8kHz to system rate (44.1/48kHz)
 * 4. Graceful underrun handling with fade to silence
 * 5. Eliminates clicks/pops during speaker transitions
 */

import { decodeMulawToFloat32, base64ToUint8Array, MULAW_SAMPLE_RATE } from './mulaw-decoder';

export type PlayerState = 'stopped' | 'buffering' | 'playing';

/**
 * Message types for communication with AudioWorklet
 */
interface WorkletAudioMessage {
  type: 'audio';
  track: 'inbound' | 'outbound' | 'left' | 'right';
  samples: Float32Array;
}

interface WorkletControlMessage {
  type: 'clear' | 'stats';
}

type WorkletMessage = WorkletAudioMessage | WorkletControlMessage;

/**
 * High-quality streaming audio player using AudioWorklet
 */
export class StreamingAudioPlayer {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;
  private state: PlayerState = 'stopped';
  private onStateChange?: (state: PlayerState) => void;
  private workletReady: boolean = false;

  // Stats
  private packetsReceived = 0;
  private lastBufferStatus: { leftMs: number; rightMs: number } = { leftMs: 0, rightMs: 0 };

  // Fallback flag - use old method if worklet fails to load
  private useFallback: boolean = false;
  private fallbackPlayer: FallbackAudioPlayer | null = null;

  constructor(onStateChange?: (state: PlayerState) => void) {
    this.onStateChange = onStateChange;
  }

  /**
   * Initialize the audio context and worklet (must be called after user gesture)
   */
  async initialize(): Promise<void> {
    if (this.audioContext) return;

    try {
      this.audioContext = new AudioContext();

      // Create gain node for volume control
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = 1.0;
      this.gainNode.connect(this.audioContext.destination);

      // Resume context if suspended (browser autoplay policy)
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      // Load the AudioWorklet module
      try {
        await this.audioContext.audioWorklet.addModule('/audio-stream-processor.js');

        // Create the worklet node
        this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-stream-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2], // Stereo output
        });

        // Connect worklet to gain node
        this.workletNode.connect(this.gainNode);

        // Handle messages from worklet
        this.workletNode.port.onmessage = (event) => {
          this.handleWorkletMessage(event.data);
        };

        console.log('[StreamingPlayer] AudioWorklet initialized, output sample rate:', this.audioContext.sampleRate);
        this.setState('buffering');

      } catch (workletError) {
        console.warn('[StreamingPlayer] AudioWorklet failed to load, using fallback:', workletError);
        this.useFallback = true;
        this.fallbackPlayer = new FallbackAudioPlayer(this.audioContext, this.gainNode, (state) => {
          this.setState(state);
        });
        this.setState('buffering');
      }

    } catch (error) {
      console.error('[StreamingPlayer] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Handle messages from the AudioWorklet
   */
  private handleWorkletMessage(data: any): void {
    switch (data.type) {
      case 'ready':
        console.log('[StreamingPlayer] Worklet ready, system sample rate:', data.sampleRate);
        this.workletReady = true;
        break;

      case 'state':
        if (data.state === 'playing') {
          this.setState('playing');
        } else if (data.state === 'buffering') {
          this.setState('buffering');
        }
        break;

      case 'buffer_status':
        this.lastBufferStatus = { leftMs: data.leftMs, rightMs: data.rightMs };
        // Log occasionally
        if (this.packetsReceived % 500 === 0) {
          console.log(`[StreamingPlayer] Buffer: L=${data.leftMs.toFixed(0)}ms R=${data.rightMs.toFixed(0)}ms, playing=${data.isPlaying}`);
        }
        break;

      case 'stats':
        console.log('[StreamingPlayer] Stats:', data);
        break;
    }
  }

  /**
   * Add audio chunk from WebSocket
   */
  addAudio(track: 'inbound' | 'outbound', mulawBase64: string): void {
    if (!this.audioContext) return;

    this.packetsReceived++;

    try {
      // Decode μ-law to Float32
      const mulawData = base64ToUint8Array(mulawBase64);
      const pcmData = decodeMulawToFloat32(mulawData);

      if (this.useFallback && this.fallbackPlayer) {
        // Use fallback player
        this.fallbackPlayer.addAudio(track, pcmData);
      } else if (this.workletNode && this.workletReady) {
        // Send to AudioWorklet
        const message: WorkletAudioMessage = {
          type: 'audio',
          track: track,
          samples: pcmData,
        };

        // Transfer the Float32Array for efficiency (zero-copy)
        this.workletNode.port.postMessage(message, [pcmData.buffer]);
      }

      // Log first few packets
      if (this.packetsReceived <= 3) {
        console.log(`[StreamingPlayer] Packet #${this.packetsReceived}, track=${track}, samples=${pcmData.length}`);
      }
    } catch (error) {
      console.error('[StreamingPlayer] Error processing audio:', error);
    }
  }

  /**
   * Get current buffer levels in milliseconds
   */
  getBufferStatus(): { leftMs: number; rightMs: number } {
    return this.lastBufferStatus;
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
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'clear' });
    }
    if (this.fallbackPlayer) {
      this.fallbackPlayer.stop();
    }
    this.packetsReceived = 0;
    this.lastBufferStatus = { leftMs: 0, rightMs: 0 };
    this.setState('stopped');
    console.log('[StreamingPlayer] Stopped');
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.stop();

    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.fallbackPlayer) {
      this.fallbackPlayer.dispose();
      this.fallbackPlayer = null;
    }
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.workletReady = false;
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

  /**
   * Request stats from worklet (for debugging)
   */
  requestStats(): void {
    if (this.workletNode && this.workletReady) {
      this.workletNode.port.postMessage({ type: 'stats' });
    }
  }
}


/**
 * Fallback Audio Player
 * =====================
 * Uses the older scheduled BufferSourceNode approach as a fallback
 * when AudioWorklet is not available (e.g., older browsers, security restrictions).
 *
 * This includes crossfade logic to minimize boundary artifacts.
 */
class FallbackAudioPlayer {
  private audioContext: AudioContext;
  private gainNode: GainNode;
  private onStateChange: (state: PlayerState) => void;

  // Circular buffers for accumulating audio
  private inboundBuffer: Float32Array;
  private outboundBuffer: Float32Array;
  private inboundWritePos = 0;
  private outboundWritePos = 0;
  private inboundAvailable = 0;
  private outboundAvailable = 0;

  // Scheduling
  private nextPlayTime = 0;
  private scheduledEndTime = 0;
  private scheduleTimer: number | null = null;
  private state: PlayerState = 'buffering';

  // Settings
  private readonly MAX_BUFFER_SAMPLES = MULAW_SAMPLE_RATE * 5;
  private readonly JITTER_BUFFER_MS = 300;
  private readonly PLAYBACK_CHUNK_MS = 500;
  private readonly SCHEDULE_AHEAD_MS = 1000;
  private readonly CROSSFADE_SAMPLES = 64; // ~8ms at 8kHz

  // For crossfade
  private lastChunkEndLeft: Float32Array | null = null;
  private lastChunkEndRight: Float32Array | null = null;

  constructor(audioContext: AudioContext, gainNode: GainNode, onStateChange: (state: PlayerState) => void) {
    this.audioContext = audioContext;
    this.gainNode = gainNode;
    this.onStateChange = onStateChange;

    this.inboundBuffer = new Float32Array(this.MAX_BUFFER_SAMPLES);
    this.outboundBuffer = new Float32Array(this.MAX_BUFFER_SAMPLES);

    this.startScheduleLoop();
  }

  addAudio(track: 'inbound' | 'outbound', samples: Float32Array): void {
    if (track === 'inbound') {
      for (let i = 0; i < samples.length; i++) {
        this.inboundBuffer[this.inboundWritePos] = samples[i];
        this.inboundWritePos = (this.inboundWritePos + 1) % this.MAX_BUFFER_SAMPLES;
        if (this.inboundAvailable < this.MAX_BUFFER_SAMPLES) {
          this.inboundAvailable++;
        }
      }
    } else {
      for (let i = 0; i < samples.length; i++) {
        this.outboundBuffer[this.outboundWritePos] = samples[i];
        this.outboundWritePos = (this.outboundWritePos + 1) % this.MAX_BUFFER_SAMPLES;
        if (this.outboundAvailable < this.MAX_BUFFER_SAMPLES) {
          this.outboundAvailable++;
        }
      }
    }
  }

  private startScheduleLoop(): void {
    const loop = () => {
      this.scheduleAudio();
      this.scheduleTimer = window.setTimeout(loop, 50);
    };
    loop();
  }

  private getBufferedMs(): number {
    return (Math.max(this.inboundAvailable, this.outboundAvailable) / MULAW_SAMPLE_RATE) * 1000;
  }

  private scheduleAudio(): void {
    const currentTime = this.audioContext.currentTime;

    if (this.state === 'buffering') {
      if (this.getBufferedMs() >= this.JITTER_BUFFER_MS) {
        this.state = 'playing';
        this.onStateChange('playing');
        this.nextPlayTime = currentTime + 0.1;
        this.scheduledEndTime = this.nextPlayTime;
      } else {
        return;
      }
    }

    let scheduledCount = 0;
    while (scheduledCount < 5) {
      const scheduledAheadMs = Math.max(0, (this.scheduledEndTime - currentTime) * 1000);
      if (scheduledAheadMs >= this.SCHEDULE_AHEAD_MS || this.getBufferedMs() < this.PLAYBACK_CHUNK_MS) {
        break;
      }
      if (!this.scheduleNextChunk()) break;
      scheduledCount++;
    }

    if (this.state === 'playing' && this.getBufferedMs() < 100 && this.scheduledEndTime <= currentTime) {
      this.state = 'buffering';
      this.onStateChange('buffering');
    }
  }

  private scheduleNextChunk(): boolean {
    const chunkSamples = Math.floor((this.PLAYBACK_CHUNK_MS / 1000) * MULAW_SAMPLE_RATE);

    // Read from buffers
    const leftSamples = this.readFromBuffer('inbound', chunkSamples);
    const rightSamples = this.readFromBuffer('outbound', chunkSamples);

    const actualLength = Math.max(leftSamples.length, rightSamples.length);
    if (actualLength === 0) return false;

    // Apply crossfade with previous chunk
    if (this.lastChunkEndLeft && leftSamples.length > 0) {
      this.applyCrossfade(this.lastChunkEndLeft, leftSamples);
    }
    if (this.lastChunkEndRight && rightSamples.length > 0) {
      this.applyCrossfade(this.lastChunkEndRight, rightSamples);
    }

    // Store end of this chunk for next crossfade
    if (leftSamples.length >= this.CROSSFADE_SAMPLES) {
      this.lastChunkEndLeft = leftSamples.slice(-this.CROSSFADE_SAMPLES);
    }
    if (rightSamples.length >= this.CROSSFADE_SAMPLES) {
      this.lastChunkEndRight = rightSamples.slice(-this.CROSSFADE_SAMPLES);
    }

    // Apply fade envelope to prevent clicks
    this.applyFadeEnvelope(leftSamples);
    this.applyFadeEnvelope(rightSamples);

    // Create stereo AudioBuffer
    const audioBuffer = this.audioContext.createBuffer(2, actualLength, MULAW_SAMPLE_RATE);

    const leftChannel = audioBuffer.getChannelData(0);
    if (leftSamples.length > 0) {
      leftChannel.set(leftSamples);
    }

    const rightChannel = audioBuffer.getChannelData(1);
    if (rightSamples.length > 0) {
      rightChannel.set(rightSamples);
    }

    // Create and schedule source
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode);

    const currentTime = this.audioContext.currentTime;
    if (this.nextPlayTime < currentTime) {
      this.nextPlayTime = currentTime + 0.02;
    }

    source.start(this.nextPlayTime);

    const chunkDuration = actualLength / MULAW_SAMPLE_RATE;
    this.nextPlayTime += chunkDuration;
    this.scheduledEndTime = this.nextPlayTime;

    return true;
  }

  private readFromBuffer(track: 'inbound' | 'outbound', count: number): Float32Array {
    const buffer = track === 'inbound' ? this.inboundBuffer : this.outboundBuffer;
    const available = track === 'inbound' ? this.inboundAvailable : this.outboundAvailable;
    const writePos = track === 'inbound' ? this.inboundWritePos : this.outboundWritePos;

    const toRead = Math.min(count, available);
    if (toRead === 0) return new Float32Array(0);

    const result = new Float32Array(toRead);
    let readPos = (writePos - available + this.MAX_BUFFER_SAMPLES) % this.MAX_BUFFER_SAMPLES;

    for (let i = 0; i < toRead; i++) {
      result[i] = buffer[readPos];
      readPos = (readPos + 1) % this.MAX_BUFFER_SAMPLES;
    }

    if (track === 'inbound') {
      this.inboundAvailable -= toRead;
    } else {
      this.outboundAvailable -= toRead;
    }

    return result;
  }

  private applyCrossfade(prevEnd: Float32Array, current: Float32Array): void {
    const fadeLength = Math.min(this.CROSSFADE_SAMPLES, prevEnd.length, current.length);
    for (let i = 0; i < fadeLength; i++) {
      const fadeOut = 1 - (i / fadeLength);
      const fadeIn = i / fadeLength;
      current[i] = prevEnd[i] * fadeOut + current[i] * fadeIn;
    }
  }

  private applyFadeEnvelope(samples: Float32Array): void {
    const fadeLength = Math.min(32, samples.length / 4); // ~4ms fade

    // Fade in
    for (let i = 0; i < fadeLength; i++) {
      samples[i] *= i / fadeLength;
    }

    // Fade out
    for (let i = 0; i < fadeLength; i++) {
      samples[samples.length - 1 - i] *= i / fadeLength;
    }
  }

  stop(): void {
    this.inboundAvailable = 0;
    this.outboundAvailable = 0;
    this.inboundWritePos = 0;
    this.outboundWritePos = 0;
    this.nextPlayTime = 0;
    this.scheduledEndTime = 0;
    this.lastChunkEndLeft = null;
    this.lastChunkEndRight = null;
    this.state = 'buffering';
  }

  dispose(): void {
    if (this.scheduleTimer !== null) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    this.stop();
  }
}
