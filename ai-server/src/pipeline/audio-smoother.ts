/**
 * Audio Smoother for μ-law Streams
 * =================================
 * Eliminates clicks/pops at audio boundaries by applying fade-in/fade-out
 * when transitioning between silence and audio.
 *
 * Problem: μ-law silence is 0xFF (decodes to ~0). When audio suddenly starts
 * with a non-zero sample value, this creates a discontinuity that sounds like
 * a click or pop.
 *
 * Solution: Track the previous sample value for each track and apply a short
 * crossfade when there's a large amplitude jump.
 */

// μ-law decode table (same as browser-side)
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

// μ-law encode function (simplified - finds closest value)
function encodeMulaw(pcmSample: number): number {
  // Clamp to valid range
  pcmSample = Math.max(-32768, Math.min(32767, Math.round(pcmSample)));

  // Find closest match in decode table
  let bestMatch = 0;
  let bestDiff = Math.abs(MULAW_DECODE_TABLE[0] - pcmSample);

  for (let i = 1; i < 256; i++) {
    const diff = Math.abs(MULAW_DECODE_TABLE[i] - pcmSample);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestMatch = i;
    }
  }

  return bestMatch;
}

// Decode a single μ-law byte to PCM
function decodeMulaw(mulawByte: number): number {
  return MULAW_DECODE_TABLE[mulawByte & 0xff];
}

// μ-law silence value
const MULAW_SILENCE = 0xff;
const SILENCE_THRESHOLD = 500; // PCM amplitude below this is considered silence

// Fade duration in samples (at 8kHz)
// 8 samples = 1ms, 16 samples = 2ms, 32 samples = 4ms
const FADE_SAMPLES = 16; // 2ms fade - short enough to not affect speech quality

/**
 * Track state for audio smoothing
 */
interface TrackState {
  lastPcmValue: number;
  wasInSilence: boolean;
  fadeInRemaining: number;
  fadeOutRemaining: number;
  packetCount: number;
  lastLogTime: number;
}

/**
 * Audio Smoother class - maintains state per track
 */
export class AudioSmoother {
  private tracks: Map<string, TrackState> = new Map();
  private debugEnabled: boolean;

  constructor(debugEnabled: boolean = false) {
    this.debugEnabled = debugEnabled || process.env.DEBUG_AUDIO_SMOOTHER === 'true';
  }

  /**
   * Get or create track state
   */
  private getTrackState(trackId: string): TrackState {
    if (!this.tracks.has(trackId)) {
      this.tracks.set(trackId, {
        lastPcmValue: 0,
        wasInSilence: true,
        fadeInRemaining: 0,
        fadeOutRemaining: 0,
        packetCount: 0,
        lastLogTime: 0,
      });
    }
    return this.tracks.get(trackId)!;
  }

  /**
   * Process an audio packet and apply smoothing
   * Returns the smoothed audio buffer
   */
  processPacket(trackId: string, audioData: Buffer): Buffer {
    const state = this.getTrackState(trackId);
    state.packetCount++;

    // Decode μ-law to PCM for processing
    const pcmSamples = new Int16Array(audioData.length);
    for (let i = 0; i < audioData.length; i++) {
      pcmSamples[i] = decodeMulaw(audioData[i]);
    }

    // Analyze packet
    const firstSample = pcmSamples[0];
    const lastSample = pcmSamples[pcmSamples.length - 1];
    let peakAmplitude = 0;
    let sumSquares = 0;

    for (let i = 0; i < pcmSamples.length; i++) {
      const abs = Math.abs(pcmSamples[i]);
      if (abs > peakAmplitude) peakAmplitude = abs;
      sumSquares += pcmSamples[i] * pcmSamples[i];
    }

    const rms = Math.sqrt(sumSquares / pcmSamples.length);
    const isCurrentlySilent = peakAmplitude < SILENCE_THRESHOLD;

    // Debug logging (every 5 seconds per track)
    const now = Date.now();
    if (this.debugEnabled && now - state.lastLogTime > 5000) {
      console.log(`[AudioSmoother] Track ${trackId}: packet #${state.packetCount}, ` +
        `first=${firstSample}, last=${lastSample}, peak=${peakAmplitude}, rms=${rms.toFixed(0)}, ` +
        `silent=${isCurrentlySilent}, wasSilent=${state.wasInSilence}`);
      state.lastLogTime = now;
    }

    // Detect transitions and apply smoothing
    const transitioningToAudio = state.wasInSilence && !isCurrentlySilent;
    const transitioningToSilence = !state.wasInSilence && isCurrentlySilent;

    if (transitioningToAudio) {
      // Starting audio after silence - apply fade-in
      state.fadeInRemaining = FADE_SAMPLES;
      if (this.debugEnabled) {
        console.log(`[AudioSmoother] Track ${trackId}: FADE-IN triggered at packet #${state.packetCount}, ` +
          `jump from ${state.lastPcmValue} to ${firstSample}`);
      }
    }

    if (transitioningToSilence) {
      // Going to silence - the previous packet should have had fade-out
      // (handled at end of processing)
    }

    // Apply fade-in if active
    if (state.fadeInRemaining > 0) {
      const fadeStart = FADE_SAMPLES - state.fadeInRemaining;
      for (let i = 0; i < pcmSamples.length && state.fadeInRemaining > 0; i++) {
        const fadePosition = fadeStart + i;
        const fadeFactor = fadePosition / FADE_SAMPLES;
        // Blend from last known value to current value
        pcmSamples[i] = Math.round(
          state.lastPcmValue * (1 - fadeFactor) + pcmSamples[i] * fadeFactor
        );
        state.fadeInRemaining--;
      }
    }

    // Check if we should apply fade-out at end of this packet
    // (if the last few samples are heading toward silence)
    const tailSamples = Math.min(8, pcmSamples.length);
    let tailPeak = 0;
    for (let i = pcmSamples.length - tailSamples; i < pcmSamples.length; i++) {
      tailPeak = Math.max(tailPeak, Math.abs(pcmSamples[i]));
    }
    const tailGoingQuiet = tailPeak < SILENCE_THRESHOLD * 2 && peakAmplitude > SILENCE_THRESHOLD * 2;

    if (tailGoingQuiet) {
      // Apply gentle fade-out to last few samples
      const fadeOutStart = pcmSamples.length - FADE_SAMPLES;
      for (let i = Math.max(0, fadeOutStart); i < pcmSamples.length; i++) {
        const fadePosition = i - fadeOutStart;
        const fadeFactor = 1 - (fadePosition / FADE_SAMPLES);
        pcmSamples[i] = Math.round(pcmSamples[i] * fadeFactor);
      }
    }

    // Update state
    state.lastPcmValue = pcmSamples[pcmSamples.length - 1];
    state.wasInSilence = isCurrentlySilent;

    // Re-encode to μ-law
    const smoothedBuffer = Buffer.alloc(audioData.length);
    for (let i = 0; i < pcmSamples.length; i++) {
      smoothedBuffer[i] = encodeMulaw(pcmSamples[i]);
    }

    return smoothedBuffer;
  }

  /**
   * Clear state for a track (call when call ends)
   */
  clearTrack(trackId: string): void {
    this.tracks.delete(trackId);
  }

  /**
   * Clear all track states
   */
  clearAll(): void {
    this.tracks.clear();
  }

  /**
   * Enable/disable debug logging
   */
  setDebug(enabled: boolean): void {
    this.debugEnabled = enabled;
  }
}

// Global smoother instance for the server
let globalSmoother: AudioSmoother | null = null;

/**
 * Get the global audio smoother instance
 */
export function getAudioSmoother(): AudioSmoother {
  if (!globalSmoother) {
    globalSmoother = new AudioSmoother(process.env.DEBUG_AUDIO_SMOOTHER === 'true');
  }
  return globalSmoother;
}

/**
 * Process audio for a specific call and track
 * This is the main entry point for smoothing audio
 */
export function smoothAudio(
  callControlId: string,
  track: 'inbound' | 'outbound',
  audioData: Buffer
): Buffer {
  const smoother = getAudioSmoother();
  const trackId = `${callControlId}:${track}`;
  return smoother.processPacket(trackId, audioData);
}

/**
 * Clear smoother state for a call (call when call ends)
 */
export function clearSmootherState(callControlId: string): void {
  const smoother = getAudioSmoother();
  smoother.clearTrack(`${callControlId}:inbound`);
  smoother.clearTrack(`${callControlId}:outbound`);
}
