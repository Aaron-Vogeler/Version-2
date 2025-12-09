/**
 * μ-law (G.711) Audio Decoder for Browser
 * =========================================
 * Decodes μ-law encoded audio (8-bit) to linear PCM (16-bit)
 * for playback via Web Audio API.
 *
 * μ-law is the standard audio encoding used in telephony (8kHz, 8-bit).
 * This decoder converts it to 16-bit PCM that browsers can play.
 */

/**
 * μ-law lookup table for fast decoding
 * Pre-computed values for all 256 possible μ-law bytes
 */
const MULAW_DECODE_TABLE = new Int16Array([
  -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
  -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
  -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
  -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
  -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
  -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
  -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
  -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
  -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
  -1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
  -876, -844, -812, -780, -748, -716, -684, -652,
  -620, -588, -556, -524, -492, -460, -428, -396,
  -372, -356, -340, -324, -308, -292, -276, -260,
  -244, -228, -212, -196, -180, -164, -148, -132,
  -120, -112, -104, -96, -88, -80, -72, -64,
  -56, -48, -40, -32, -24, -16, -8, 0,
  32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
  23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
  15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
  11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
  7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
  5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
  3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004,
  2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
  1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436,
  1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
  876, 844, 812, 780, 748, 716, 684, 652,
  620, 588, 556, 524, 492, 460, 428, 396,
  372, 356, 340, 324, 308, 292, 276, 260,
  244, 228, 212, 196, 180, 164, 148, 132,
  120, 112, 104, 96, 88, 80, 72, 64,
  56, 48, 40, 32, 24, 16, 8, 0,
]);

/**
 * Decode a single μ-law byte to 16-bit PCM sample
 */
export function decodeMulawSample(mulaw: number): number {
  return MULAW_DECODE_TABLE[mulaw & 0xff];
}

/**
 * Decode μ-law audio buffer to Float32 PCM (-1 to 1 range)
 * This format is ready for Web Audio API playback
 *
 * @param mulawData - Uint8Array of μ-law encoded audio
 * @returns Float32Array of PCM samples (-1 to 1)
 */
export function decodeMulawToFloat32(mulawData: Uint8Array): Float32Array {
  const pcmData = new Float32Array(mulawData.length);

  for (let i = 0; i < mulawData.length; i++) {
    // Decode to 16-bit PCM then normalize to -1..1
    const pcm16 = MULAW_DECODE_TABLE[mulawData[i]];
    pcmData[i] = pcm16 / 32768;
  }

  return pcmData;
}

/**
 * Decode μ-law audio buffer to Int16 PCM
 *
 * @param mulawData - Uint8Array of μ-law encoded audio
 * @returns Int16Array of PCM samples
 */
export function decodeMulawToInt16(mulawData: Uint8Array): Int16Array {
  const pcmData = new Int16Array(mulawData.length);

  for (let i = 0; i < mulawData.length; i++) {
    pcmData[i] = MULAW_DECODE_TABLE[mulawData[i]];
  }

  return pcmData;
}

/**
 * Audio sample rate for telephony μ-law audio
 */
export const MULAW_SAMPLE_RATE = 8000;

/**
 * Create an AudioBuffer from μ-law data for Web Audio API playback
 *
 * @param audioContext - The Web Audio API context
 * @param mulawData - Uint8Array of μ-law encoded audio
 * @param stereo - If true, creates stereo buffer (same audio in both channels)
 * @returns AudioBuffer ready for playback
 */
export function createAudioBufferFromMulaw(
  audioContext: AudioContext,
  mulawData: Uint8Array,
  stereo: boolean = false
): AudioBuffer {
  const pcmData = decodeMulawToFloat32(mulawData);
  const numChannels = stereo ? 2 : 1;
  const audioBuffer = audioContext.createBuffer(
    numChannels,
    pcmData.length,
    MULAW_SAMPLE_RATE
  );

  // Copy PCM data to channel(s) - use getChannelData for direct write access
  const channel0 = audioBuffer.getChannelData(0);
  for (let i = 0; i < pcmData.length; i++) {
    channel0[i] = pcmData[i];
  }
  if (stereo) {
    const channel1 = audioBuffer.getChannelData(1);
    for (let i = 0; i < pcmData.length; i++) {
      channel1[i] = pcmData[i];
    }
  }

  return audioBuffer;
}

/**
 * Utility to convert base64 string to Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Audio Player class for streaming μ-law audio playback
 * Uses ScriptProcessorNode for smooth, continuous playback
 */
export class MulawAudioPlayer {
  private audioContext: AudioContext | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private gainNode: GainNode | null = null;
  private sampleQueue: number[] = [];
  private onStateChange?: (state: 'playing' | 'stopped' | 'buffering') => void;
  private isStarted = false;
  private packetCount = 0;

  constructor(onStateChange?: (state: 'playing' | 'stopped' | 'buffering') => void) {
    this.onStateChange = onStateChange;
  }

  /**
   * Initialize the audio context (must be called after user gesture)
   */
  async initialize(): Promise<void> {
    if (this.audioContext) return;

    // Use default sample rate (usually 44100 or 48000) for better quality
    this.audioContext = new AudioContext();

    // Create gain node for volume control
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = 1.0;
    this.gainNode.connect(this.audioContext.destination);

    // Create script processor for continuous playback
    // Buffer size of 4096 gives ~85ms of audio at 48kHz
    this.scriptNode = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.scriptNode.onaudioprocess = (e) => this.processAudio(e);
    this.scriptNode.connect(this.gainNode);

    console.log('[MulawPlayer] Initialized, context sample rate:', this.audioContext.sampleRate);
  }

  /**
   * Process audio - called by ScriptProcessorNode
   */
  private processAudio(e: AudioProcessingEvent): void {
    const output = e.outputBuffer.getChannelData(0);
    const outputRate = this.audioContext!.sampleRate;
    const inputRate = MULAW_SAMPLE_RATE;
    const ratio = inputRate / outputRate;

    for (let i = 0; i < output.length; i++) {
      // Calculate which input sample we need (linear interpolation for upsampling)
      const inputIndex = i * ratio;
      const index = Math.floor(inputIndex);

      if (index < this.sampleQueue.length - 1) {
        // Linear interpolation between samples for smoother upsampling
        const frac = inputIndex - index;
        const sample1 = this.sampleQueue[index];
        const sample2 = this.sampleQueue[index + 1];
        output[i] = sample1 + frac * (sample2 - sample1);
      } else if (index < this.sampleQueue.length) {
        output[i] = this.sampleQueue[index];
      } else {
        output[i] = 0; // Silence if buffer empty
      }
    }

    // Remove consumed samples
    const consumed = Math.floor(output.length * ratio);
    this.sampleQueue.splice(0, consumed);

    // Update state based on buffer level
    if (this.sampleQueue.length < 1000) {
      this.onStateChange?.('buffering');
    } else {
      this.onStateChange?.('playing');
    }
  }

  /**
   * Add audio chunk - both tracks go to the same buffer
   */
  addAudio(track: 'inbound' | 'outbound', mulawBase64: string): void {
    if (!this.audioContext) return;

    this.packetCount++;
    if (this.packetCount <= 3 || this.packetCount % 200 === 0) {
      console.log(`[MulawPlayer] Packet #${this.packetCount}, queue: ${this.sampleQueue.length} samples`);
    }

    try {
      const mulawData = base64ToUint8Array(mulawBase64);
      const pcmData = decodeMulawToFloat32(mulawData);

      // Add samples to queue
      for (let i = 0; i < pcmData.length; i++) {
        this.sampleQueue.push(pcmData[i]);
      }

      // Prevent buffer from growing too large (max ~2 seconds of 8kHz audio)
      const maxSamples = MULAW_SAMPLE_RATE * 2;
      if (this.sampleQueue.length > maxSamples) {
        this.sampleQueue.splice(0, this.sampleQueue.length - maxSamples);
      }

      if (!this.isStarted) {
        this.isStarted = true;
        this.onStateChange?.('playing');
        console.log('[MulawPlayer] Playback started');
      }
    } catch (error) {
      console.error('[MulawPlayer] Error:', error);
    }
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
   * Stop playback and clear buffers
   */
  stop(): void {
    this.sampleQueue = [];
    this.isStarted = false;
    this.onStateChange?.('stopped');
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.stop();
    if (this.scriptNode) {
      this.scriptNode.disconnect();
      this.scriptNode = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.gainNode = null;
  }

  /**
   * Check if currently playing
   */
  get playing(): boolean {
    return this.isStarted;
  }
}
