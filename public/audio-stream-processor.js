/**
 * AudioWorklet Processor for Continuous Audio Streaming
 * ======================================================
 * Runs on the audio rendering thread for glitch-free playback.
 *
 * Features:
 * - Continuous sample-by-sample output (no chunk boundaries)
 * - Linear interpolation resampling (8kHz → system rate)
 * - Stereo output (left=inbound/caller, right=outbound/assistant)
 * - Graceful underrun handling with smooth fade to silence
 * - Ring buffer for jitter absorption
 */

// Constants
const INPUT_SAMPLE_RATE = 8000;  // μ-law telephony rate
const RING_BUFFER_SECONDS = 3;   // Buffer capacity
const FADE_SAMPLES = 128;        // Fade duration for underrun (matches render quantum)

/**
 * Ring buffer for a single audio channel
 */
class ChannelRingBuffer {
  constructor(capacity) {
    this.buffer = new Float32Array(capacity);
    this.capacity = capacity;
    this.writePos = 0;
    this.readPos = 0;
    this.availableSamples = 0;
  }

  /**
   * Write samples to the buffer
   */
  write(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % this.capacity;

      if (this.availableSamples < this.capacity) {
        this.availableSamples++;
      } else {
        // Overwrite old data - advance read position
        this.readPos = (this.readPos + 1) % this.capacity;
      }
    }
  }

  /**
   * Read a single sample (with interpolation support)
   * @param {number} fractionalIndex - The fractional position to read from
   * @returns {number} The interpolated sample value
   */
  readInterpolated(fractionalIndex) {
    if (this.availableSamples < 2) {
      return 0; // Not enough data for interpolation
    }

    const index0 = Math.floor(fractionalIndex) % this.capacity;
    const index1 = (index0 + 1) % this.capacity;
    const frac = fractionalIndex - Math.floor(fractionalIndex);

    const sample0 = this.buffer[(this.readPos + index0) % this.capacity];
    const sample1 = this.buffer[(this.readPos + index1) % this.capacity];

    return sample0 + frac * (sample1 - sample0);
  }

  /**
   * Advance the read position by a number of samples
   */
  advance(samples) {
    const toAdvance = Math.min(samples, this.availableSamples);
    this.readPos = (this.readPos + toAdvance) % this.capacity;
    this.availableSamples -= toAdvance;
  }

  /**
   * Get number of available samples
   */
  available() {
    return this.availableSamples;
  }

  /**
   * Clear the buffer
   */
  clear() {
    this.writePos = 0;
    this.readPos = 0;
    this.availableSamples = 0;
  }
}

/**
 * Audio Stream Processor
 * Handles continuous playback with resampling
 */
class AudioStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Ring buffers for each channel (3 seconds at input rate)
    const bufferCapacity = INPUT_SAMPLE_RATE * RING_BUFFER_SECONDS;
    this.leftBuffer = new ChannelRingBuffer(bufferCapacity);
    this.rightBuffer = new ChannelRingBuffer(bufferCapacity);

    // Resampling state
    this.resampleRatio = INPUT_SAMPLE_RATE / sampleRate; // e.g., 8000/48000 = 0.1667
    this.resamplePosition = 0; // Fractional position in input buffer

    // Playback state
    this.isPlaying = false;
    this.fadeGain = 0; // For smooth start/stop
    this.lastLeftSample = 0; // For DC offset prevention
    this.lastRightSample = 0;

    // Stats for debugging
    this.samplesProcessed = 0;
    this.underrunCount = 0;

    // Minimum buffer before starting playback (200ms at input rate)
    this.minBufferToStart = INPUT_SAMPLE_RATE * 0.2;

    // Handle messages from main thread
    this.port.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    // Notify main thread we're ready
    this.port.postMessage({ type: 'ready', sampleRate: sampleRate });
  }

  /**
   * Handle messages from main thread
   */
  handleMessage(data) {
    switch (data.type) {
      case 'audio':
        // Receive audio data for a specific track
        if (data.track === 'inbound' || data.track === 'left') {
          this.leftBuffer.write(data.samples);
        } else if (data.track === 'outbound' || data.track === 'right') {
          this.rightBuffer.write(data.samples);
        }
        break;

      case 'clear':
        this.leftBuffer.clear();
        this.rightBuffer.clear();
        this.resamplePosition = 0;
        this.isPlaying = false;
        this.fadeGain = 0;
        break;

      case 'stats':
        // Send stats back to main thread
        this.port.postMessage({
          type: 'stats',
          leftBuffered: this.leftBuffer.available(),
          rightBuffered: this.rightBuffer.available(),
          samplesProcessed: this.samplesProcessed,
          underrunCount: this.underrunCount,
          isPlaying: this.isPlaying
        });
        break;
    }
  }

  /**
   * Main audio processing function
   * Called ~344 times/second at 48kHz (every 128 samples)
   */
  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length < 2) {
      return true; // Keep processor alive
    }

    const leftChannel = output[0];
    const rightChannel = output[1];
    const numSamples = leftChannel.length; // Typically 128

    // Check buffer levels
    const leftAvailable = this.leftBuffer.available();
    const rightAvailable = this.rightBuffer.available();
    const maxAvailable = Math.max(leftAvailable, rightAvailable);

    // Start playback when we have enough buffered
    if (!this.isPlaying && maxAvailable >= this.minBufferToStart) {
      this.isPlaying = true;
      this.port.postMessage({ type: 'state', state: 'playing' });
    }

    // Calculate how many input samples we need for this output block
    const inputSamplesNeeded = numSamples * this.resampleRatio;

    // Check for underrun
    const isUnderrun = this.isPlaying && maxAvailable < inputSamplesNeeded + 2;

    if (isUnderrun) {
      this.underrunCount++;
      // Fade out gracefully
      for (let i = 0; i < numSamples; i++) {
        this.fadeGain = Math.max(0, this.fadeGain - (1 / FADE_SAMPLES));
        leftChannel[i] = this.lastLeftSample * this.fadeGain;
        rightChannel[i] = this.lastRightSample * this.fadeGain;
        // Decay the held samples
        this.lastLeftSample *= 0.99;
        this.lastRightSample *= 0.99;
      }

      if (this.fadeGain === 0) {
        this.isPlaying = false;
        this.port.postMessage({ type: 'state', state: 'buffering' });
      }

      this.samplesProcessed += numSamples;
      return true;
    }

    // Normal playback with resampling
    if (this.isPlaying) {
      for (let i = 0; i < numSamples; i++) {
        // Fade in smoothly
        this.fadeGain = Math.min(1, this.fadeGain + (1 / FADE_SAMPLES));

        // Get interpolated samples from input buffers
        const leftSample = this.leftBuffer.readInterpolated(this.resamplePosition);
        const rightSample = this.rightBuffer.readInterpolated(this.resamplePosition);

        // Apply fade and output
        leftChannel[i] = leftSample * this.fadeGain;
        rightChannel[i] = rightSample * this.fadeGain;

        // Store for underrun handling
        this.lastLeftSample = leftSample;
        this.lastRightSample = rightSample;

        // Advance resample position
        this.resamplePosition += this.resampleRatio;
      }

      // Advance buffer read positions by the integer part
      const samplesToAdvance = Math.floor(this.resamplePosition);
      if (samplesToAdvance > 0) {
        this.leftBuffer.advance(samplesToAdvance);
        this.rightBuffer.advance(samplesToAdvance);
        this.resamplePosition -= samplesToAdvance;
      }
    } else {
      // Not playing - output silence
      for (let i = 0; i < numSamples; i++) {
        leftChannel[i] = 0;
        rightChannel[i] = 0;
      }
    }

    this.samplesProcessed += numSamples;

    // Periodically send buffer status (every ~1 second)
    if (this.samplesProcessed % (sampleRate) < numSamples) {
      this.port.postMessage({
        type: 'buffer_status',
        leftMs: (this.leftBuffer.available() / INPUT_SAMPLE_RATE) * 1000,
        rightMs: (this.rightBuffer.available() / INPUT_SAMPLE_RATE) * 1000,
        isPlaying: this.isPlaying
      });
    }

    return true; // Keep processor alive
  }
}

registerProcessor('audio-stream-processor', AudioStreamProcessor);
