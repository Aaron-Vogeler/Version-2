/**
 * Energy Floor Music Detection Module
 * ====================================
 * Detects music start/stop by monitoring the "floor" (minimum energy level)
 * of audio packets over a sliding window.
 *
 * Core Concept:
 * - Music fills gaps between speech with continuous audio energy
 * - Human speech has true silence between words (near-zero energy)
 * - By tracking the minimum energy (floor), we detect environmental changes
 *
 * Detection Logic:
 * - Floor > MUSIC_THRESHOLD → Music is playing (even during speech)
 * - Floor < SILENCE_THRESHOLD → No music (true silence in gaps)
 * - Hysteresis prevents flickering between states
 *
 * @see https://en.wikipedia.org/wiki/Voice_activity_detection
 */

/**
 * μ-law decode table for converting 8-bit μ-law to 16-bit linear PCM.
 * Pre-computed for performance (avoids per-sample math).
 */
const MULAW_DECODE_TABLE: Int16Array = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    // Invert all bits
    const mulaw = ~i & 0xff;
    // Extract sign, exponent, mantissa
    const sign = mulaw & 0x80;
    const exponent = (mulaw >> 4) & 0x07;
    const mantissa = mulaw & 0x0f;
    // Compute linear value
    let linear = ((mantissa << 3) + 0x84) << exponent;
    linear -= 0x84; // Remove bias
    table[i] = sign ? -linear : linear;
  }
  return table;
})();

/**
 * Decode μ-law audio to 16-bit linear PCM.
 * @param mulawData - μ-law encoded audio buffer
 * @returns Int16Array of decoded PCM samples
 */
export function decodeMulaw(mulawData: Buffer): Int16Array {
  const pcm = new Int16Array(mulawData.length);
  for (let i = 0; i < mulawData.length; i++) {
    pcm[i] = MULAW_DECODE_TABLE[mulawData[i]];
  }
  return pcm;
}

/**
 * Configuration for energy floor detection.
 */
export interface EnergyFloorConfig {
  /** Number of packets in sliding window (~1 second at 50 packets/sec) */
  windowSize: number;
  /** Percentile for floor calculation (0.10 = 10th percentile) */
  floorPercentile: number;
  /** Floor above this = music detected (0-1 normalized) */
  musicThreshold: number;
  /** Floor below this = no music (0-1 normalized) */
  silenceThreshold: number;
  /** Minimum time before state change (ms) */
  hysteresisMs: number;
  /** Enable detailed audit logging */
  auditLogging: boolean;
  /** Log every N packets (for periodic status) */
  logIntervalPackets: number;
}

/**
 * Default configuration values.
 */
export const DEFAULT_ENERGY_FLOOR_CONFIG: EnergyFloorConfig = {
  windowSize: 50, // ~1 second at 20ms/packet
  floorPercentile: 0.10, // 10th percentile (robust to outliers)
  musicThreshold: 0.035, // Floor above this = music
  silenceThreshold: 0.015, // Floor below this = no music
  hysteresisMs: 500, // Must be stable for 500ms
  auditLogging: true,
  logIntervalPackets: 50, // Log every ~1 second
};

/**
 * Current state of music detection.
 */
export interface MusicDetectionState {
  /** Current energy floor value (0-1 normalized) */
  floor: number;
  /** Current packet energy (0-1 normalized) */
  currentEnergy: number;
  /** Is music currently detected? */
  musicDetected: boolean;
  /** Timestamp when music state last changed */
  musicStateChangedAt: number;
  /** How long music has been in current state (ms) */
  musicStateDurationMs: number;
  /** Confidence in current detection (0-1) */
  confidence: number;
  /** Detection method that triggered current state */
  detectionMethod: "floor_rise" | "floor_drop" | "initial" | "transcript";
  /** Total packets processed */
  packetsProcessed: number;
  /** Average energy over window */
  averageEnergy: number;
  /** Energy variance over window */
  energyVariance: number;
}

/**
 * Audit log entry for troubleshooting.
 */
export interface EnergyFloorAuditEntry {
  timestamp: number;
  packetNumber: number;
  energy: number;
  floor: number;
  averageEnergy: number;
  musicDetected: boolean;
  confidence: number;
  stateChange: "MUSIC_STARTED" | "MUSIC_STOPPED" | null;
  reason?: string;
}

/**
 * Energy Floor Tracker - Main class for music detection.
 *
 * Usage:
 * ```typescript
 * const tracker = new EnergyFloorTracker(callId, config);
 * // On each audio packet:
 * const state = tracker.process(mulawData);
 * if (state.musicDetected !== previousState) {
 *   // Music state changed!
 * }
 * ```
 */
export class EnergyFloorTracker {
  private callId: string;
  private config: EnergyFloorConfig;

  // Rolling window of energy values
  private energyHistory: number[] = [];

  // Floor tracking for confidence calculation
  private floorHistory: number[] = [];

  // Current state
  private musicDetected = false;
  private lastStateChangeAt = 0;
  private packetsProcessed = 0;

  // Hysteresis tracking
  private timeAboveThreshold = 0;
  private timeBelowThreshold = 0;
  private lastProcessTime = 0;

  // Audit log (circular buffer)
  private auditLog: EnergyFloorAuditEntry[] = [];
  private readonly MAX_AUDIT_ENTRIES = 500;

  constructor(callId: string, config: Partial<EnergyFloorConfig> = {}) {
    this.callId = callId;
    this.config = { ...DEFAULT_ENERGY_FLOOR_CONFIG, ...config };
    this.lastStateChangeAt = Date.now();
    this.lastProcessTime = Date.now();

    this.log("INFO", `EnergyFloorTracker initialized`, {
      config: this.config,
    });
  }

  /**
   * Process a single audio packet and return current state.
   * @param mulawData - μ-law encoded audio buffer (8kHz, 20ms = 160 bytes)
   * @returns Current music detection state
   */
  process(mulawData: Buffer): MusicDetectionState {
    const now = Date.now();
    const deltaMs = now - this.lastProcessTime;
    this.lastProcessTime = now;
    this.packetsProcessed++;

    // 1. Decode μ-law to PCM
    const pcmData = decodeMulaw(mulawData);

    // 2. Calculate RMS energy for this packet
    const energy = this.calculateRMS(pcmData);

    // 3. Update rolling window
    this.energyHistory.push(energy);
    if (this.energyHistory.length > this.config.windowSize) {
      this.energyHistory.shift();
    }

    // 4. Calculate floor using percentile
    const floor = this.calculateFloor();

    // 5. Calculate average and variance for diagnostics
    const { average: averageEnergy, variance: energyVariance } = this.calculateStats();

    // 6. Track floor stability for confidence
    this.floorHistory.push(floor);
    if (this.floorHistory.length > 10) {
      this.floorHistory.shift();
    }

    // 7. Update hysteresis timers
    this.updateHysteresis(floor, deltaMs);

    // 8. Determine music state with hysteresis
    const previousState = this.musicDetected;
    const stateChange = this.updateMusicState(floor, now);

    // 9. Calculate confidence based on floor stability
    const confidence = this.calculateConfidence();

    // 10. Create audit entry
    const auditEntry: EnergyFloorAuditEntry = {
      timestamp: now,
      packetNumber: this.packetsProcessed,
      energy,
      floor,
      averageEnergy,
      musicDetected: this.musicDetected,
      confidence,
      stateChange,
      reason: stateChange
        ? `Floor ${stateChange === "MUSIC_STARTED" ? "rose above" : "dropped below"} threshold`
        : undefined,
    };

    // 11. Log audit entry
    if (this.config.auditLogging) {
      this.addAuditEntry(auditEntry);

      // Periodic status log
      if (this.packetsProcessed % this.config.logIntervalPackets === 0) {
        this.log("DEBUG", `Periodic status`, {
          packets: this.packetsProcessed,
          floor: floor.toFixed(4),
          avg: averageEnergy.toFixed(4),
          music: this.musicDetected,
          confidence: confidence.toFixed(2),
        });
      }
    }

    // 12. Log state changes
    if (stateChange) {
      this.log("INFO", `Music ${stateChange}`, {
        floor: floor.toFixed(4),
        threshold: stateChange === "MUSIC_STARTED"
          ? this.config.musicThreshold
          : this.config.silenceThreshold,
        confidence: confidence.toFixed(2),
        packetsProcessed: this.packetsProcessed,
      });
    }

    return {
      floor,
      currentEnergy: energy,
      musicDetected: this.musicDetected,
      musicStateChangedAt: this.lastStateChangeAt,
      musicStateDurationMs: now - this.lastStateChangeAt,
      confidence,
      detectionMethod: stateChange
        ? stateChange === "MUSIC_STARTED"
          ? "floor_rise"
          : "floor_drop"
        : "initial",
      packetsProcessed: this.packetsProcessed,
      averageEnergy,
      energyVariance,
    };
  }

  /**
   * Force music detection from transcript pattern (e.g., "[music]" tag).
   * This boosts confidence when Deepgram detects music.
   */
  setMusicFromTranscript(detected: boolean): void {
    if (detected && !this.musicDetected) {
      this.log("INFO", `Music detected from transcript pattern`, {
        previousState: this.musicDetected,
      });
      this.musicDetected = true;
      this.lastStateChangeAt = Date.now();
    }
  }

  /**
   * Get the current music detection state without processing new audio.
   */
  getCurrentState(): MusicDetectionState {
    const now = Date.now();
    const floor = this.calculateFloor();
    const { average: averageEnergy, variance: energyVariance } = this.calculateStats();
    const confidence = this.calculateConfidence();

    return {
      floor,
      currentEnergy: this.energyHistory[this.energyHistory.length - 1] || 0,
      musicDetected: this.musicDetected,
      musicStateChangedAt: this.lastStateChangeAt,
      musicStateDurationMs: now - this.lastStateChangeAt,
      confidence,
      detectionMethod: "initial",
      packetsProcessed: this.packetsProcessed,
      averageEnergy,
      energyVariance,
    };
  }

  /**
   * Get recent audit log entries for troubleshooting.
   */
  getAuditLog(limit: number = 100): EnergyFloorAuditEntry[] {
    return this.auditLog.slice(-limit);
  }

  /**
   * Get formatted audit log as string for logging.
   */
  getFormattedAuditLog(limit: number = 20): string {
    const entries = this.getAuditLog(limit);
    const lines = entries.map((e) => {
      const time = new Date(e.timestamp).toISOString().slice(11, 23);
      const state = e.musicDetected ? "MUSIC" : "QUIET";
      const change = e.stateChange ? ` [${e.stateChange}]` : "";
      return `${time} | pkt=${e.packetNumber.toString().padStart(5)} | E=${e.energy.toFixed(4)} | F=${e.floor.toFixed(4)} | ${state} (${(e.confidence * 100).toFixed(0)}%)${change}`;
    });
    return lines.join("\n");
  }

  /**
   * Reset the tracker (e.g., when call ends).
   */
  reset(): void {
    this.energyHistory = [];
    this.floorHistory = [];
    this.musicDetected = false;
    this.lastStateChangeAt = Date.now();
    this.packetsProcessed = 0;
    this.timeAboveThreshold = 0;
    this.timeBelowThreshold = 0;
    this.auditLog = [];

    this.log("INFO", `EnergyFloorTracker reset`);
  }

  /**
   * Get configuration (for audit/debugging).
   */
  getConfig(): EnergyFloorConfig {
    return { ...this.config };
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(updates: Partial<EnergyFloorConfig>): void {
    const oldConfig = { ...this.config };
    this.config = { ...this.config, ...updates };

    this.log("INFO", `Configuration updated`, {
      changes: Object.keys(updates),
      oldConfig,
      newConfig: this.config,
    });
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Calculate RMS (Root Mean Square) energy of audio samples.
   * Returns normalized value between 0 and 1.
   */
  private calculateRMS(pcmData: Int16Array): number {
    let sumSquares = 0;
    for (let i = 0; i < pcmData.length; i++) {
      const normalized = pcmData[i] / 32768; // Normalize to -1 to 1
      sumSquares += normalized * normalized;
    }
    return Math.sqrt(sumSquares / pcmData.length);
  }

  /**
   * Calculate floor using percentile (more robust than min).
   */
  private calculateFloor(): number {
    if (this.energyHistory.length === 0) return 0;

    const sorted = [...this.energyHistory].sort((a, b) => a - b);
    const index = Math.floor(sorted.length * this.config.floorPercentile);
    return sorted[index] || sorted[0];
  }

  /**
   * Calculate average and variance of energy history.
   */
  private calculateStats(): { average: number; variance: number } {
    if (this.energyHistory.length === 0) {
      return { average: 0, variance: 0 };
    }

    const sum = this.energyHistory.reduce((a, b) => a + b, 0);
    const average = sum / this.energyHistory.length;

    const squaredDiffs = this.energyHistory.map((e) => Math.pow(e - average, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / this.energyHistory.length;

    return { average, variance };
  }

  /**
   * Update hysteresis timers based on current floor.
   */
  private updateHysteresis(floor: number, deltaMs: number): void {
    if (floor > this.config.musicThreshold) {
      this.timeAboveThreshold += deltaMs;
      this.timeBelowThreshold = 0;
    } else if (floor < this.config.silenceThreshold) {
      this.timeBelowThreshold += deltaMs;
      this.timeAboveThreshold = 0;
    } else {
      // In dead zone - reset both timers
      this.timeAboveThreshold = Math.max(0, this.timeAboveThreshold - deltaMs * 0.5);
      this.timeBelowThreshold = Math.max(0, this.timeBelowThreshold - deltaMs * 0.5);
    }
  }

  /**
   * Update music detection state with hysteresis.
   * Returns state change event or null.
   */
  private updateMusicState(floor: number, now: number): "MUSIC_STARTED" | "MUSIC_STOPPED" | null {
    if (!this.musicDetected) {
      // Currently NO music - check if music started
      if (
        floor > this.config.musicThreshold &&
        this.timeAboveThreshold >= this.config.hysteresisMs
      ) {
        this.musicDetected = true;
        this.lastStateChangeAt = now;
        this.timeAboveThreshold = 0;
        return "MUSIC_STARTED";
      }
    } else {
      // Currently HAS music - check if music stopped
      if (
        floor < this.config.silenceThreshold &&
        this.timeBelowThreshold >= this.config.hysteresisMs
      ) {
        this.musicDetected = false;
        this.lastStateChangeAt = now;
        this.timeBelowThreshold = 0;
        return "MUSIC_STOPPED";
      }
    }

    return null;
  }

  /**
   * Calculate confidence based on floor stability.
   * Stable floor = high confidence, fluctuating = low confidence.
   */
  private calculateConfidence(): number {
    if (this.floorHistory.length < 3) return 0.5;

    const mean =
      this.floorHistory.reduce((a, b) => a + b, 0) / this.floorHistory.length;
    const variance =
      this.floorHistory.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
      this.floorHistory.length;
    const stdDev = Math.sqrt(variance);

    // Low variance = high confidence
    // Map stdDev: 0 -> 1.0, 0.02+ -> 0.5
    const confidence = Math.max(0.5, 1 - (stdDev / 0.02) * 0.5);
    return Math.min(1, confidence);
  }

  /**
   * Add entry to audit log (circular buffer).
   */
  private addAuditEntry(entry: EnergyFloorAuditEntry): void {
    this.auditLog.push(entry);
    if (this.auditLog.length > this.MAX_AUDIT_ENTRIES) {
      this.auditLog.shift();
    }
  }

  /**
   * Structured logging helper.
   */
  private log(
    level: "DEBUG" | "INFO" | "WARN" | "ERROR",
    message: string,
    data?: Record<string, any>
  ): void {
    const timestamp = new Date().toISOString();
    const prefix = `[MUSIC-DETECT] [${this.callId.slice(-8)}]`;
    const dataStr = data ? ` ${JSON.stringify(data)}` : "";

    switch (level) {
      case "DEBUG":
        console.log(`${prefix} ${message}${dataStr}`);
        break;
      case "INFO":
        console.log(`${prefix} ${message}${dataStr}`);
        break;
      case "WARN":
        console.warn(`${prefix} ⚠️ ${message}${dataStr}`);
        break;
      case "ERROR":
        console.error(`${prefix} ❌ ${message}${dataStr}`);
        break;
    }
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if a transcript contains music indicators from Deepgram.
 * Deepgram sometimes emits [music], [instrumental], etc.
 */
export function transcriptContainsMusicIndicator(transcript: string): boolean {
  const musicPatterns = [
    /\[music\]/i,
    /\[instrumental\]/i,
    /\[hold music\]/i,
    /♪|♫|🎵|🎶/,
  ];

  return musicPatterns.some((pattern) => pattern.test(transcript));
}

/**
 * Serialize music detection state for Redis sync.
 */
export function serializeMusicState(state: MusicDetectionState): string {
  return JSON.stringify({
    musicDetected: state.musicDetected,
    musicStateChangedAt: state.musicStateChangedAt,
    confidence: state.confidence,
    floor: state.floor,
    detectionMethod: state.detectionMethod,
  });
}

/**
 * Deserialize music detection state from Redis.
 */
export function deserializeMusicState(
  json: string
): Partial<MusicDetectionState> | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
