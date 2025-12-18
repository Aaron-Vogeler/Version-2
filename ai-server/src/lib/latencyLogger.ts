/**
 * Latency Logger
 *
 * Structured logging for tracking LLM→TTS latency in production (Fly.io).
 * Outputs JSON-formatted logs for easy parsing and analysis.
 *
 * Key metrics tracked:
 * - TTFT (Time to First Token): When first chunk arrives from LLM
 * - Time to behavior: When behavior field is extracted
 * - Time to speak ready: When speak field is complete (TTS can start)
 * - End-to-end: Total time from LLM start to TTS queued
 */

export interface LatencyMetrics {
  callId?: string;
  model: string;
  cached: boolean;

  // Timestamps (ms since epoch)
  startTime: number;
  firstChunkTime?: number;
  behaviorDetectedTime?: number;
  speakReadyTime?: number;
  ttsQueuedTime?: number;
  endTime?: number;

  // Computed latencies (ms)
  ttft?: number; // Time to first token
  timeToBehavior?: number;
  timeToSpeakReady?: number;
  ttsQueueLatency?: number; // Time from speak ready to TTS queued
  totalLatency?: number;

  // Response info
  behavior?: string;
  speakLength?: number;
  totalChunks?: number;
  totalChars?: number;

  // Error tracking
  error?: string;
}

/**
 * LatencyTracker - Tracks latency through the LLM→TTS pipeline
 */
export class LatencyTracker {
  private metrics: LatencyMetrics;
  private chunkCount = 0;

  constructor(model: string, cached: boolean, callId?: string) {
    this.metrics = {
      callId,
      model,
      cached,
      startTime: Date.now(),
      totalChunks: 0,
      totalChars: 0,
    };
  }

  /**
   * Mark when the first chunk arrives from the LLM
   */
  markFirstChunk(): void {
    if (!this.metrics.firstChunkTime) {
      this.metrics.firstChunkTime = Date.now();
      this.metrics.ttft = this.metrics.firstChunkTime - this.metrics.startTime;
      this.chunkCount = 1;

      this.logEvent('TTFT', {
        ttft_ms: this.metrics.ttft,
        cached: this.metrics.cached,
      });
    } else {
      this.chunkCount++;
    }
    this.metrics.totalChunks = this.chunkCount;
  }

  /**
   * Mark when behavior field is detected
   */
  markBehaviorDetected(behavior: string): void {
    if (!this.metrics.behaviorDetectedTime) {
      this.metrics.behaviorDetectedTime = Date.now();
      this.metrics.behavior = behavior;
      this.metrics.timeToBehavior = this.metrics.behaviorDetectedTime - this.metrics.startTime;

      this.logEvent('BEHAVIOR_DETECTED', {
        behavior,
        time_to_behavior_ms: this.metrics.timeToBehavior,
        chunks_so_far: this.chunkCount,
      });
    }
  }

  /**
   * Mark when speak field is complete and TTS can start
   */
  markSpeakReady(speakLength: number): void {
    if (!this.metrics.speakReadyTime) {
      this.metrics.speakReadyTime = Date.now();
      this.metrics.speakLength = speakLength;
      this.metrics.timeToSpeakReady = this.metrics.speakReadyTime - this.metrics.startTime;

      this.logEvent('SPEAK_READY', {
        time_to_speak_ready_ms: this.metrics.timeToSpeakReady,
        speak_length: speakLength,
        chunks_so_far: this.chunkCount,
      });
    }
  }

  /**
   * Mark when TTS has been queued (Telnyx API called)
   */
  markTtsQueued(): void {
    if (!this.metrics.ttsQueuedTime) {
      this.metrics.ttsQueuedTime = Date.now();
      if (this.metrics.speakReadyTime) {
        this.metrics.ttsQueueLatency = this.metrics.ttsQueuedTime - this.metrics.speakReadyTime;
      }

      this.logEvent('TTS_QUEUED', {
        time_from_speak_ready_ms: this.metrics.ttsQueueLatency,
        total_so_far_ms: this.metrics.ttsQueuedTime - this.metrics.startTime,
      });
    }
  }

  /**
   * Mark stream complete
   */
  markComplete(totalChars: number): void {
    this.metrics.endTime = Date.now();
    this.metrics.totalChars = totalChars;
    this.metrics.totalLatency = this.metrics.endTime - this.metrics.startTime;

    this.logEvent('STREAM_COMPLETE', {
      total_latency_ms: this.metrics.totalLatency,
      total_chunks: this.metrics.totalChunks,
      total_chars: totalChars,
    });
  }

  /**
   * Mark an error occurred
   */
  markError(error: string): void {
    this.metrics.error = error;
    this.metrics.endTime = Date.now();
    this.metrics.totalLatency = this.metrics.endTime - this.metrics.startTime;

    this.logEvent('ERROR', {
      error,
      elapsed_ms: this.metrics.totalLatency,
    });
  }

  /**
   * Add chunk character count
   */
  addChars(chars: number): void {
    this.metrics.totalChars = (this.metrics.totalChars || 0) + chars;
  }

  /**
   * Get all metrics (for logging or analysis)
   */
  getMetrics(): LatencyMetrics {
    return { ...this.metrics };
  }

  /**
   * Log a structured event (JSON format for Fly.io)
   */
  private logEvent(event: string, data: Record<string, any>): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      event: `LATENCY_${event}`,
      call_id: this.metrics.callId || 'unknown',
      model: this.metrics.model,
      cached: this.metrics.cached,
      ...data,
    };

    // Output as single-line JSON for Fly.io log aggregation
    console.log(`[LATENCY] ${JSON.stringify(logEntry)}`);
  }

  /**
   * Log a summary of the entire pipeline latency
   */
  logSummary(): void {
    const summary = {
      timestamp: new Date().toISOString(),
      event: 'LATENCY_SUMMARY',
      call_id: this.metrics.callId || 'unknown',
      model: this.metrics.model,
      cached: this.metrics.cached,
      ttft_ms: this.metrics.ttft,
      time_to_behavior_ms: this.metrics.timeToBehavior,
      time_to_speak_ready_ms: this.metrics.timeToSpeakReady,
      tts_queue_latency_ms: this.metrics.ttsQueueLatency,
      total_latency_ms: this.metrics.totalLatency,
      behavior: this.metrics.behavior,
      speak_length: this.metrics.speakLength,
      total_chunks: this.metrics.totalChunks,
      total_chars: this.metrics.totalChars,
      error: this.metrics.error,
    };

    console.log(`[LATENCY] ${JSON.stringify(summary)}`);
  }
}

/**
 * Simple structured log helper for one-off events
 */
export function logLatencyEvent(
  event: string,
  data: Record<string, any>,
  callId?: string
): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    event: `LATENCY_${event}`,
    call_id: callId || 'unknown',
    ...data,
  };

  console.log(`[LATENCY] ${JSON.stringify(logEntry)}`);
}
