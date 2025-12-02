/**
 * Audio pipeline utilities for processing PCM audio streams.
 * Handles downsampling, mulaw encoding, and chunking for Telnyx PCMU streams.
 * 
 * FIXED ISSUES:
 * 1. Corrected ITU-T G.711 μ-law encoder (was using wrong segment detection)
 * 2. Lowered FIR cutoff to 3400 Hz (was 4100 Hz, above 4000 Hz Nyquist)
 * 3. Reduced normalization target to 85% (was 99%, causing harshness)
 * 4. Removed redundant pre-μlaw boost (double amplification)
 */

/**
 * ITU-T G.711 μ-law encoding lookup table approach.
 * This is the CORRECT implementation per the G.711 standard.
 * 
 * μ-law compresses 14-bit dynamic range into 8 bits using logarithmic
 * compression, which matches human hearing perception.
 */

// Precomputed segment table for fast encoding
const MULAW_BIAS = 0x84;  // 132 in decimal
const MULAW_CLIP = 32635; // Maximum value before clipping
const MULAW_SEGMENT_TABLE = [0, 132, 396, 924, 1980, 4092, 8316, 16764];

/**
 * Standard ITU-T G.711 μ-law encoding.
 * Converts a 16-bit linear PCM sample to 8-bit μ-law.
 * 
 * @param sample - 16-bit signed PCM sample (-32768 to 32767)
 * @returns 8-bit μ-law encoded byte (0-255)
 */
function encodeSampleMulaw(sample: number): number {
  // Get the sign bit (1 = positive, 0 = negative in μ-law convention)
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }

  // Clip to maximum value
  if (sample > MULAW_CLIP) {
    sample = MULAW_CLIP;
  }

  // Add bias for better low-amplitude encoding
  sample += MULAW_BIAS;

  // Find the segment (exponent) by checking which range the sample falls into
  let exponent = 7;
  for (let i = 0; i < 8; i++) {
    if (sample <= MULAW_SEGMENT_TABLE[i + 1]) {
      exponent = i;
      break;
    }
  }
  
  // Alternative segment finding using bit position (more standard approach)
  // Find the position of the most significant bit
  exponent = 0;
  let shifted = sample >> 7;
  while (shifted > 0 && exponent < 7) {
    shifted >>= 1;
    exponent++;
  }

  // Extract the 4-bit mantissa from the appropriate position
  const mantissa = (sample >> (exponent + 3)) & 0x0F;

  // Combine: sign (1 bit) + exponent (3 bits) + mantissa (4 bits)
  // Then invert all bits (μ-law uses inverted encoding for better noise immunity)
  const encoded = ~(sign | (exponent << 4) | mantissa);
  
  return encoded & 0xFF;
}

/**
 * Alternative: Use the standard μ-law formula directly.
 * This is mathematically equivalent but clearer.
 * 
 * Formula: F(x) = sgn(x) * ln(1 + μ|x|) / ln(1 + μ)
 * where μ = 255 for telephony.
 */
function encodeSampleMulawPrecise(sample: number): number {
  const MU = 255;
  const MAX = 32768;

  // Get sign
  const sign = sample < 0 ? 1 : 0;
  sample = Math.abs(sample);

  // Normalize to 0-1 range
  const normalized = Math.min(sample / MAX, 1.0);

  // Apply μ-law compression formula
  const compressed = Math.log(1 + MU * normalized) / Math.log(1 + MU);

  // Convert back to 8-bit range (0-127 for magnitude)
  let magnitude = Math.floor(compressed * 127);

  // Combine sign and magnitude, then invert
  const encoded = (sign << 7) | magnitude;
  return (~encoded) & 0xFF;
}

/**
 * Normalizes PCM audio to use optimal dynamic range for μ-law encoding.
 * 
 * IMPORTANT: μ-law is logarithmic, so it handles a wide dynamic range well.
 * Over-normalization (pushing to 99%) actually HURTS quality by:
 * - Clipping transients
 * - Reducing natural speech dynamics
 * - Creating harsh, compressed sound
 * 
 * Target: ~80-85% of full scale preserves dynamics while avoiding quantization noise.
 *
 * @param pcmBuffer - 16-bit signed PCM audio buffer
 * @returns Normalized 16-bit signed PCM audio buffer
 */
export function normalizePcm(pcmBuffer: Buffer): Buffer {
  const startTime = Date.now();
  console.log("📈 ========== AUDIO NORMALIZATION ==========");

  // Create Int16Array view
  const samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.byteLength / 2
  );

  // Find peak amplitude
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }

  // Calculate RMS for reference
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  const rmsIn = Math.sqrt(sumSquares / samples.length);

  console.log("📊 Input:");
  console.log("   • Peak amplitude:", peak);
  console.log("   • RMS amplitude:", rmsIn.toFixed(2));
  console.log("   • Peak utilization:", ((peak / 32767) * 100).toFixed(1) + "%");

  // MODERATE normalization: target 85% of full scale
  // This preserves speech dynamics while ensuring good SNR
  const TARGET_PEAK = Math.round(32767 * 0.85); // 85% of full scale
  let scaleFactor = 1.0;
  let clippedSamples = 0;

  // Only normalize if peak is below 70% (avoid amplifying already loud audio)
  if (peak > 0 && peak < TARGET_PEAK * 0.82) {  // ~70% threshold
    scaleFactor = TARGET_PEAK / peak;
    
    // Limit maximum gain to 3x to avoid amplifying noise
    scaleFactor = Math.min(scaleFactor, 3.0);

    console.log("🔊 Normalizing by", scaleFactor.toFixed(2) + "x (targeting 85% scale)...");

    // Apply scaling with soft clipping to avoid harsh artifacts
    for (let i = 0; i < samples.length; i++) {
      let scaled = samples[i] * scaleFactor;
      
      // Soft clipping using tanh-like curve for values approaching limits
      if (Math.abs(scaled) > 28000) {
        const sign = scaled > 0 ? 1 : -1;
        const excess = Math.abs(scaled) - 28000;
        // Compress the excess to avoid hard clipping
        scaled = sign * (28000 + excess * 0.3);
      }
      
      const clamped = Math.max(-32768, Math.min(32767, Math.round(scaled)));
      if (Math.abs(scaled) > 32767) clippedSamples++;
      samples[i] = clamped;
    }

    if (clippedSamples > 0) {
      console.log("⚠️  Soft-clipped", clippedSamples, "samples (", ((clippedSamples / samples.length) * 100).toFixed(2) + "%)");
    }
  } else if (peak === 0) {
    console.log("⚠️  No audio data detected!");
  } else {
    console.log("✅ Audio already at good level, no normalization needed");
  }

  // Re-calculate peak and RMS after scaling
  let newPeak = 0;
  let newSumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > newPeak) newPeak = abs;
    newSumSquares += samples[i] * samples[i];
  }
  const rmsOut = Math.sqrt(newSumSquares / samples.length);

  console.log("");
  console.log("📊 Output:");
  console.log("   • Peak amplitude:", newPeak);
  console.log("   • RMS amplitude:", rmsOut.toFixed(2));
  console.log("   • Peak utilization:", ((newPeak / 32767) * 100).toFixed(1) + "%");
  console.log("   • Gain applied:", scaleFactor.toFixed(2) + "x");
  console.log("");
  console.log("✅ Normalization complete in", (Date.now() - startTime), "ms");
  console.log("=========================================");

  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

/**
 * Downsamples 24kHz PCM audio to 8kHz for Telnyx compatibility.
 *
 * CRITICAL FIX: Cutoff frequency lowered from 4100 Hz to 3400 Hz.
 * 
 * The Nyquist frequency for 8kHz output is 4000 Hz. Any frequency content
 * above Nyquist will "fold back" (alias) into the audible range, creating
 * metallic/warbling artifacts.
 * 
 * Standard telephony uses 3400 Hz cutoff (the standard "toll quality" bandwidth).
 * This provides a guard band to ensure clean anti-aliasing.
 *
 * @param pcmBuffer - 24kHz PCM audio buffer (16-bit signed, little-endian)
 * @returns 8kHz PCM audio buffer (16-bit signed, little-endian)
 */
const DECIMATION_FACTOR = 3;

// FIR filter with CORRECT cutoff at 3400 Hz (telephony standard)
const LOWPASS_TAPS = createLowpassTaps({
  cutoffHz: 3400,   // FIXED: Was 4100 Hz (above Nyquist!)
  sampleRate: 24000,
  numTaps: 63,      // Good balance of quality and performance
});

export function downsample24kHzTo8kHz(pcmBuffer: Buffer): Buffer {
  const startTime = Date.now();
  console.log("📉 ========== DOWNSAMPLING 24kHz → 8kHz ==========");

  // Create an Int16Array view of the input buffer (24 kHz samples)
  const samples24k = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.byteLength / 2
  );

  console.log("📊 Input (24kHz):");
  console.log("   • Buffer length:", pcmBuffer.length, "bytes");
  console.log("   • Sample count:", samples24k.length);
  console.log("   • Duration:", ((samples24k.length / 24000) * 1000).toFixed(2), "ms");

  // Analyze input samples
  let min24k = 32767, max24k = -32768, sum24k = 0;
  for (let i = 0; i < samples24k.length; i++) {
    const s = samples24k[i];
    if (s < min24k) min24k = s;
    if (s > max24k) max24k = s;
    sum24k += s * s;
  }
  const rms24k = Math.sqrt(sum24k / samples24k.length);
  console.log("   • RMS amplitude:", rms24k.toFixed(2));
  console.log("   • Peak range:", min24k, "to", max24k);

  // Apply FIR low-pass filter with decimation
  const samples8k = new Int16Array(Math.floor(samples24k.length / DECIMATION_FACTOR));
  const centerTap = (LOWPASS_TAPS.length - 1) / 2;

  console.log("🔧 Filter Configuration:");
  console.log("   • Filter type: FIR low-pass (Hann-windowed sinc)");
  console.log("   • Number of taps:", LOWPASS_TAPS.length);
  console.log("   • Decimation factor:", DECIMATION_FACTOR);
  console.log("   • Cutoff frequency: 3400 Hz (telephony standard)");

  let clampedSamples = 0;
  for (let i = 0; i < samples8k.length; i++) {
    const sourceIndex = i * DECIMATION_FACTOR;
    let acc = 0;

    for (let t = 0; t < LOWPASS_TAPS.length; t++) {
      const tapIndex = sourceIndex + t - centerTap;
      const sample = tapIndex >= 0 && tapIndex < samples24k.length ? samples24k[tapIndex] : 0;
      acc += sample * LOWPASS_TAPS[t];
    }

    const rounded = Math.round(acc);
    const clamped = Math.max(-32768, Math.min(32767, rounded));
    if (rounded !== clamped) clampedSamples++;
    samples8k[i] = clamped;
  }

  // Analyze output samples
  let min8k = 32767, max8k = -32768, sum8k = 0;
  for (let i = 0; i < samples8k.length; i++) {
    const s = samples8k[i];
    if (s < min8k) min8k = s;
    if (s > max8k) max8k = s;
    sum8k += s * s;
  }
  const rms8k = Math.sqrt(sum8k / samples8k.length);

  console.log("");
  console.log("📊 Output (8kHz):");
  console.log("   • Sample count:", samples8k.length);
  console.log("   • Duration:", ((samples8k.length / 8000) * 1000).toFixed(2), "ms");
  console.log("   • RMS amplitude:", rms8k.toFixed(2));
  console.log("   • Peak range:", min8k, "to", max8k);
  console.log("   • Clamped samples:", clampedSamples, `(${((clampedSamples / samples8k.length) * 100).toFixed(2)}%)`);
  console.log("   • RMS preservation:", ((rms8k / rms24k) * 100).toFixed(1) + "%");

  const result = Buffer.from(
    samples8k.buffer,
    samples8k.byteOffset,
    samples8k.byteLength
  );

  console.log("");
  console.log("✅ Downsampling complete in", (Date.now() - startTime), "ms");
  console.log("   • Output buffer length:", result.length, "bytes");
  console.log("================================================");

  return result;
}

/**
 * Creates FIR low-pass filter coefficients using windowed sinc design.
 * 
 * @param cutoffHz - Cutoff frequency in Hz
 * @param sampleRate - Sample rate in Hz
 * @param numTaps - Number of filter taps (must be odd)
 * @returns Filter coefficients (Float64Array)
 */
function createLowpassTaps({
  cutoffHz,
  sampleRate,
  numTaps,
}: {
  cutoffHz: number;
  sampleRate: number;
  numTaps: number;
}): Float64Array {
  const taps = new Float64Array(numTaps);
  const center = (numTaps - 1) / 2;
  const fc = cutoffHz / sampleRate; // normalized cutoff (0..0.5)

  for (let i = 0; i < numTaps; i++) {
    const n = i - center;
    // Hann window for smooth frequency response
    const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (numTaps - 1)));
    // Ideal sinc filter
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    taps[i] = sinc * window;
  }

  // Normalize to unity gain at DC
  const sum = taps.reduce((acc, v) => acc + v, 0);
  for (let i = 0; i < numTaps; i++) {
    taps[i] /= sum || 1;
  }

  return taps;
}

/**
 * Final amplitude adjustment before μ-law encoding.
 * 
 * SIMPLIFIED: Removed aggressive boosting. The normalization stage
 * already handles level optimization. This now just does a gentle
 * check to ensure we're not sending silent audio.
 * 
 * μ-law's logarithmic nature means it handles a WIDE dynamic range well.
 * Peaks at 15000-25000 work perfectly fine. Over-boosting causes distortion.
 */
export function boostBeforeMulaw(pcmBuffer: Buffer): Buffer {
  const samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.byteLength / 2
  );

  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }

  // Only boost if audio is very quiet (below 20% of full scale)
  // This catches edge cases where TTS output is unusually quiet
  const MIN_ACCEPTABLE_PEAK = 6500; // ~20% of full scale

  if (peak > 0 && peak < MIN_ACCEPTABLE_PEAK) {
    // Gentle boost to reach 50% of full scale (not 99%!)
    const targetPeak = 16000;
    const boost = targetPeak / peak;

    console.log("🔊 ========== GENTLE PRE-MULAW BOOST ==========");
    console.log("📊 Input peak:", peak, `(${((peak / 32767) * 100).toFixed(1)}%)`);
    console.log("🔊 Applying gentle boost:", boost.toFixed(2) + "x");

    for (let i = 0; i < samples.length; i++) {
      const boosted = samples[i] * boost;
      samples[i] = Math.max(-32768, Math.min(32767, Math.round(boosted)));
    }

    console.log("=========================================");
  } else {
    console.log("✅ Audio level good for μ-law, peak:", peak, `(${((peak / 32767) * 100).toFixed(1)}%)`);
  }

  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

/**
 * Converts 16-bit linear PCM audio to 8-bit μ-law format.
 * Uses the CORRECT ITU-T G.711 standard algorithm.
 *
 * @param pcmBuffer - 16-bit linear PCM audio buffer (8kHz, little-endian)
 * @returns 8-bit μ-law audio buffer (8kHz)
 */
export function pcmToMulaw(pcmBuffer: Buffer): Buffer {
  const startTime = Date.now();
  console.log("🔄 ========== PCM → μ-LAW ENCODING ==========");

  const sampleCount = pcmBuffer.length / 2;
  
  // Analyze input PCM
  let minPcm = 32767, maxPcm = -32768, sumPcm = 0;
  for (let i = 0; i < sampleCount; i++) {
    const s = pcmBuffer.readInt16LE(i * 2);
    if (s < minPcm) minPcm = s;
    if (s > maxPcm) maxPcm = s;
    sumPcm += s * s;
  }
  const rmsPcm = Math.sqrt(sumPcm / sampleCount);

  console.log("📊 Input (16-bit PCM @ 8kHz):");
  console.log("   • Sample count:", sampleCount);
  console.log("   • Duration:", ((sampleCount / 8000) * 1000).toFixed(2), "ms");
  console.log("   • RMS amplitude:", rmsPcm.toFixed(2));
  console.log("   • Peak range:", minPcm, "to", maxPcm);

  // Encode each sample using CORRECT G.711 μ-law algorithm
  const mulawArray = new Uint8Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcmBuffer.readInt16LE(i * 2);
    mulawArray[i] = encodeMulawG711(sample);
  }

  console.log("");
  console.log("📊 Output (8-bit μ-law):");
  console.log("   • Encoded bytes:", mulawArray.length);
  console.log("   • Compression ratio: 2:1");
  console.log("   • First 10 encoded bytes:", Array.from(mulawArray.slice(0, 10)));

  const mulawBuffer = Buffer.from(mulawArray);

  console.log("");
  console.log("✅ μ-law encoding complete in", (Date.now() - startTime), "ms");
  console.log("===========================================");

  return mulawBuffer;
}

/**
 * CORRECT ITU-T G.711 μ-law encoder.
 * 
 * This implementation matches the official G.711 specification exactly.
 * The algorithm:
 * 1. Handle sign
 * 2. Add bias (132)
 * 3. Find segment by locating MSB position
 * 4. Extract mantissa
 * 5. Combine and invert
 */
function encodeMulawG711(sample: number): number {
  const BIAS = 0x84;  // 132
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
  // Segments are defined by bit positions after bias is added
  let exponent = 0;
  let mantissa = 0;
  
  // Find the segment using standard G.711 segment boundaries
  // After adding bias, sample is at least 132
  if (sample >= 0x4000) {       // 16384
    exponent = 7;
    mantissa = (sample >> 10) & 0x0F;
  } else if (sample >= 0x2000) { // 8192
    exponent = 6;
    mantissa = (sample >> 9) & 0x0F;
  } else if (sample >= 0x1000) { // 4096
    exponent = 5;
    mantissa = (sample >> 8) & 0x0F;
  } else if (sample >= 0x0800) { // 2048
    exponent = 4;
    mantissa = (sample >> 7) & 0x0F;
  } else if (sample >= 0x0400) { // 1024
    exponent = 3;
    mantissa = (sample >> 6) & 0x0F;
  } else if (sample >= 0x0200) { // 512
    exponent = 2;
    mantissa = (sample >> 5) & 0x0F;
  } else if (sample >= 0x0100) { // 256
    exponent = 1;
    mantissa = (sample >> 4) & 0x0F;
  } else {                       // < 256
    exponent = 0;
    mantissa = (sample >> 3) & 0x0F;
  }
  
  // Step 5: Combine sign, exponent, mantissa and invert all bits
  const encoded = sign | (exponent << 4) | mantissa;
  return (~encoded) & 0xFF;
}

/**
 * Chunks μ-law audio into 20ms packets for Telnyx streaming.
 * At 8kHz sample rate, 20ms = 160 samples = 160 bytes (8-bit μ-law).
 *
 * @param mulawBuffer - 8-bit μ-law audio buffer (8kHz)
 * @returns Array of 20ms audio chunks
 */
export function chunkAudio(mulawBuffer: Buffer): Buffer[] {
  console.log("🔀 ========== AUDIO CHUNKING ==========");
  const SAMPLE_RATE = 8000;
  const CHUNK_DURATION_MS = 20;
  const CHUNK_SIZE = (SAMPLE_RATE / 1000) * CHUNK_DURATION_MS; // 160 bytes

  console.log("📊 Configuration:");
  console.log("   • Chunk size:", CHUNK_SIZE, "bytes (20ms @ 8kHz)");

  const chunks: Buffer[] = [];

  for (let i = 0; i < mulawBuffer.length; i += CHUNK_SIZE) {
    const chunk = mulawBuffer.slice(i, Math.min(i + CHUNK_SIZE, mulawBuffer.length));
    chunks.push(chunk);
  }

  const totalDurationMs = (mulawBuffer.length / SAMPLE_RATE) * 1000;

  console.log("📊 Results:");
  console.log("   • Total chunks:", chunks.length);
  console.log("   • Total duration:", totalDurationMs.toFixed(2), "ms");
  console.log("======================================");

  return chunks;
}
