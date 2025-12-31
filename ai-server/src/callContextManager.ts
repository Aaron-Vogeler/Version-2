/**
 * Call-Level Context Management
 * =============================
 * Maintains within-call memory only: rolling summary + sliding window of recent turns.
 * Each call is scoped to a single Telnyx call ID and cleared on call end.
 * No cross-call memory is persisted.
 */
import config from "./config";
import { randomUUID } from "crypto";
import type { HumanDetectionState, ReceiverState } from "./pipeline/humanDetection";
import { initializeHumanDetectionState } from "./pipeline/humanDetection";
import type { MusicDetectionState, EnergyFloorConfig } from "./pipeline/energy-floor";
import { EnergyFloorTracker } from "./pipeline/energy-floor";

// ============================================================================
// GROK CALL STATS - Accumulated token/cost tracking per call
// ============================================================================

/**
 * Accumulated stats for Grok calls within a single phone call
 */
export interface GrokCallAccumulatedStats {
  // Token counts
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCachedTokens: number;

  // Cost tracking
  totalCostUsd: number;
  costSavedFromCaching: number;

  // Call counts
  grokCallCount: number;
  cacheHitCount: number; // Number of calls with cache hits

  // Timing
  totalLatencyMs: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;

  // Model breakdown (model -> stats)
  byModel: Record<string, {
    callCount: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    costUsd: number;
    latencyMs: number;
  }>;
}

/**
 * Represents a single turn in the conversation.
 */
export interface Turn {
  speaker: "caller" | "agent" | "assistant" | "ivr";
  text: string;
  timestamp: string; // ISO timestamp
}

/**
 * Within-call context manager that maintains a rolling summary and sliding window.
 */
export interface CallContext {
  // Call identification
  callId: string;
  callControlId?: string;
  streamId?: string;
  userId?: string;
  goal?: string;
  additionalContext?: string; // Additional context to inject into system prompt (above goal)
  assistantName?: string;
  userName?: string;
  systemPrompt?: string; // Custom system prompt passed from frontend
  rollingSummaryPrompt?: string; // Custom rolling summary prompt template passed from frontend
  geminiCachedPrompt?: string; // Custom Gemini cached system prompt (for streaming, bypasses default cache)
  model?: string; // Model to use for this call (overrides config default)
  temperature?: number; // Temperature for LLM calls (overrides default)
  maxTokens?: number; // Max tokens for LLM calls (overrides default)
  topP?: number; // Top P for LLM calls (overrides default)
  reasoning?: 'low' | 'medium' | 'high'; // Reasoning effort for LLM calls
  stream?: boolean; // Enable streaming for LLM calls
  jsonMode?: boolean; // Enable JSON mode for LLM calls
  chunkFirstTurnByPunctuation?: boolean; // Split first AI response at punctuation for faster TTS
  manualMode?: boolean; // Manual mode - disable auto AI, allow manual TTS
  initiatedAt?: string;

  // Rolling summary and turn tracking
  rollingSummary: string; // Natural language summary of entire call so far
  turns: Turn[]; // Bounded sliding window of recent turns
  lastSummaryUpdateTurnIndex: number; // Index of last turn included in summary

  // Call state tracking
  isCallActive?: boolean;
  lastUserTranscript?: string;
  lastTranscriptAt?: number;
  ttsDebounceTimer?: any; // NodeJS.Timeout | ReturnType<typeof setTimeout>
  deepgramSocket?: any;
  deepgramStartedAt?: number; // Timestamp when Deepgram stream started (for billing)

  // TTS settings
  ttsVoiceId?: string; // Custom Telnyx TTS voice ID (overrides config default)

  // TTS playback state (authoritative, driven by Telnyx webhooks)
  ttsState?: "idle" | "speaking" | "stopping";
  // Turn sequence number for cancelling stale LLM/TTS responses
  turnSeq?: number;
  // Barge-in cooldown to prevent spamming stop endpoint
  bargeInCooldownUntil?: number;

  // Assistant speech tracking (for logging actual spoken text, including partial)
  currentSpeakText?: string; // Text currently being spoken by TTS
  speakStartedAt?: number; // Timestamp when TTS playback actually started (from call.speak.started webhook)
  speakWasInterrupted?: boolean; // Flag indicating if current speech was interrupted by barge-in

  // Transcript logging state (insert-only, final-only approach)
  callerFinalBuf?: string[]; // Buffer of final transcript chunks awaiting utterance flush
  callerFinalFlushTimer?: any; // Timer for flushing buffered caller utterance (NodeJS.Timeout | ReturnType<typeof setTimeout>)
  lastCallerUtterance?: string; // Last flushed caller utterance (for deduplication)
  assistantFinalBuf?: string[]; // Buffer of final assistant utterances (if outbound STT enabled)
  assistantFinalFlushTimer?: any; // Timer for flushing buffered assistant utterance (NodeJS.Timeout | ReturnType<typeof setTimeout>)

  // Accumulated turn text - collects ALL utterances from callee until AI responds
  // This ensures the full callee turn is sent to the LLM, not just the last segment
  accumulatedTurnText?: string[];

  // Custom recording buffers for self-hosted dual-channel recording
  recordingBuffers?: {
    inbound: Buffer[]; // μ-law bytes from caller (Telnyx media payloads)
    outbound: Buffer[]; // μ-law bytes from assistant (Telnyx media payloads)
    startedAtMs: number; // Date.now() when buffering begins
  };
  // Flag to disable custom recording if size limit exceeded (fallback to Telnyx native)
  customRecordingDisabledDueToSize?: boolean;

  // Flag to hang up after current TTS completes (triggered by "end" behavior or "Chow" signal)
  pendingHangupAfterTts?: boolean;

  // Hold state tracking (triggered by "hold" behavior)
  isOnHold?: boolean; // Whether the AI is currently waiting on hold
  holdStartedAt?: number; // Timestamp when hold started (Date.now())
  holdCheckInCount?: number; // Number of check-ins performed while on hold
  holdCheckInTimer?: any; // Timer for next hold check-in (NodeJS.Timeout | ReturnType<typeof setTimeout>)

  // Per-call hold settings (overrides config defaults if provided)
  holdCheckInIntervalMs?: number; // Custom check-in interval for this call
  holdMaxCheckIns?: number; // Custom max check-ins for this call

  // Per-call timing settings (overrides config defaults if provided)
  ttsDebounceMs?: number; // Custom TTS debounce (silence before AI responds) for this call
  bargeInCooldownMs?: number; // Custom barge-in cooldown for this call
  callerUtteranceFlushMs?: number; // Custom utterance flush time for this call

  // IVR/Phone Tree Navigation State
  isIvrMode?: boolean; // Whether we're currently interacting with an automated system
  ivrConfidence?: number; // Confidence level (0-1) that we're in IVR mode
  lastIvrPrompt?: string; // The last IVR prompt we heard (for context)
  ivrMenuOptions?: string[]; // Detected menu options from the IVR
  ivrNavigationHistory?: string[]; // History of DTMF inputs sent during this call
  lastDtmfSentAt?: number; // Timestamp of last DTMF sent (for pacing)
  humanDetectedAt?: number; // Timestamp when human was detected (exits IVR mode)

  // Per-call IVR settings (overrides config defaults if provided)
  ivrDebounceMs?: number; // Custom IVR debounce time for this call
  ivrUtteranceFlushMs?: number; // Custom IVR utterance flush time for this call
  ivrDtmfMinPauseMs?: number; // Custom minimum pause between DTMF sends
  ivrDtmfDurationMs?: number; // Custom DTMF tone duration
  ivrAutoDetectThreshold?: number; // Custom IVR auto-detection confidence threshold
  ivrResponseTimeoutMs?: number; // Custom timeout before IVR retry
  ivrMaxDtmfRetries?: number; // Custom max DTMF retry attempts
  ivrDisableBargeInGracePeriod?: boolean; // Custom barge-in grace period setting for IVR

  // Per-call Human Detection settings (overrides config defaults if provided)
  humanDetectionEnabled?: boolean; // Enable/disable human detection state machine
  humanDetectionUtteranceFlushMs?: number; // Non-speech duration to trigger utterance flush
  humanDetectionHumanWaitMs?: number; // Wait time for human receiver before AI responds
  humanDetectionIvrWaitMs?: number; // Wait time for IVR/unsure receiver before AI responds
  humanDetectionMinUtterances?: number; // Minimum utterances before first classification
  humanDetectionHoldSilenceMs?: number; // Extended silence threshold for hold detection
  humanDetectionHumanTurnsAfterHold?: number; // Human turns required after hold to confirm
  humanDetectionMaxUnsure?: number; // Max consecutive unsure before defaulting to IVR
  humanDetectionClassificationModel?: string; // Model to use for receiver classification
  humanDetectionClassificationPrompt?: string; // Custom prompt for receiver classification

  // LLM-based party type detection (human vs IVR/robotic)
  detectedPartyType?: "human" | "robotic"; // Result of LLM party detection
  partyDetectionComplete?: boolean; // Whether initial party detection has been done
  partyDetectionTimestamp?: number; // When party detection occurred

  // ============================================================================
  // ENHANCED HUMAN DETECTION STATE (IVR vs Human State Machine)
  // ============================================================================
  /** Human detection state machine */
  humanDetection?: HumanDetectionState;
  /** Current receiver state for quick access */
  receiverState?: ReceiverState;
  /** Timer for classification after utterance flush silence */
  classificationTimer?: ReturnType<typeof setTimeout>;

  // ============================================================================
  // MUSIC DETECTION STATE (Energy Floor Detection)
  // ============================================================================
  /** Energy floor tracker instance (processes audio packets) */
  energyFloorTracker?: EnergyFloorTracker;
  /** Current music detection state (for quick access) */
  musicDetectionState?: MusicDetectionState;
  /** Is music currently playing? (shortcut to musicDetectionState.musicDetected) */
  musicDetected?: boolean;
  /** Timestamp when music state last changed */
  musicStateChangedAt?: number;
  /** Confidence in current music detection (0-1) */
  musicConfidence?: number;

  // Per-call Music Detection settings (overrides config defaults if provided)
  musicDetectionEnabled?: boolean;
  musicDetectionWindowSize?: number;
  musicDetectionFloorPercentile?: number;
  musicDetectionMusicThreshold?: number;
  musicDetectionSilenceThreshold?: number;
  musicDetectionHysteresisMs?: number;
  musicDetectionAuditLogging?: boolean;
  musicDetectionUseTranscriptPatterns?: boolean;

  // ============================================================================
  // DIARIZATION STATE (Speaker Change Detection)
  // ============================================================================
  /** Enable diarization for this call (overrides config) */
  diarizationEnabled?: boolean;
  /** Primary speaker ID (first speaker detected after call starts) */
  primarySpeakerId?: number;
  /** Current speaker ID from latest diarization */
  currentSpeakerId?: number;
  /** Previous speaker ID (for change detection) */
  previousSpeakerId?: number;
  /** Number of speaker changes detected */
  speakerChangeCount?: number;
  /** Timestamp of last speaker change */
  lastSpeakerChangeAt?: number;
  /** Debounce timer for speaker change events */
  speakerChangeDebounceUntil?: number;
  /** Per-call diarization debounce (ms) */
  diarizationDebounceMs?: number;
  /** Per-call diarization confidence threshold */
  diarizationMinConfidence?: number;
  /** Per-call audit logging for diarization */
  diarizationAuditLogging?: boolean;

  // ============================================================================
  // GROK API OPTIMIZATION - x-grok-conv-id for caching & call stats
  // ============================================================================
  /** UUID4 conversation ID for x-grok-conv-id header (improves cache hit rate) */
  grokConversationId?: string;
  /** Accumulated stats for all Grok calls during this phone call */
  grokCallStats?: GrokCallAccumulatedStats;
}

/**
 * Configuration for context management
 */
export interface ContextConfig {
  maxTurnsInWindow: number; // Max recent turns to keep (e.g., 12)
  summaryUpdateIntervalTurns: number; // Update summary after this many new turns (e.g., 6)
  maxSummaryTokensHint: number; // Approximate max tokens for summary (e.g., 300)
}

// Default configuration - uses values from main config
const defaultConfig: ContextConfig = {
  maxTurnsInWindow: config.context.maxTurnsInWindow,
  summaryUpdateIntervalTurns: config.context.summaryUpdateIntervalTurns,
  maxSummaryTokensHint: config.context.maxSummaryTokensHint,
};

// In-memory store: Map of callId -> CallContext
const callContextStore = new Map<string, CallContext>();

/**
 * Get or create a CallContext for a given call ID.
 */
export function getOrCreateContext(
  callId: string,
  config: ContextConfig = defaultConfig
): CallContext {
  if (!callContextStore.has(callId)) {
    callContextStore.set(callId, {
      callId,
      rollingSummary: "",
      turns: [],
      lastSummaryUpdateTurnIndex: -1,
      isCallActive: false,
      lastUserTranscript: "",
      lastTranscriptAt: 0,
      ttsState: "idle",
      turnSeq: 0,
      bargeInCooldownUntil: 0,
      callerFinalBuf: [],
      lastCallerUtterance: "",
      assistantFinalBuf: [],
      accumulatedTurnText: [], // Accumulates all callee utterances until AI responds
      // IVR state initialization
      isIvrMode: false,
      ivrConfidence: 0,
      ivrMenuOptions: [],
      ivrNavigationHistory: [],
      // Party detection initialization
      partyDetectionComplete: false,
      detectedPartyType: undefined,
      // Human detection state machine
      humanDetection: initializeHumanDetectionState(),
      receiverState: "UNKNOWN",
      // Music detection state (tracker initialized when call starts with audio)
      musicDetected: false,
      musicConfidence: 0,
      // Diarization state (speaker change detection)
      speakerChangeCount: 0,
      // Grok API optimization - generate unique conversation ID for caching
      grokConversationId: randomUUID(),
      // Grok call stats accumulator
      grokCallStats: {
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        totalCachedTokens: 0,
        totalCostUsd: 0,
        costSavedFromCaching: 0,
        grokCallCount: 0,
        cacheHitCount: 0,
        totalLatencyMs: 0,
        avgLatencyMs: 0,
        minLatencyMs: Infinity,
        maxLatencyMs: 0,
        byModel: {},
      },
    });
    console.log(`[CONTEXT] Created new context for ${callId.slice(-8)} with grokConversationId: ${callContextStore.get(callId)!.grokConversationId}`);
  }
  return callContextStore.get(callId)!;
}

/**
 * Initialize music detection tracker for a call.
 * Called when audio streaming starts and we have per-call settings.
 */
export function initializeMusicDetection(
  callId: string,
  perCallSettings?: {
    enabled?: boolean;
    windowSize?: number;
    floorPercentile?: number;
    musicThreshold?: number;
    silenceThreshold?: number;
    hysteresisMs?: number;
    auditLogging?: boolean;
  }
): EnergyFloorTracker | null {
  const context = getOrCreateContext(callId);

  // Check if music detection is enabled (per-call or global config)
  const enabled = perCallSettings?.enabled ?? config.musicDetection?.enabled ?? true;
  if (!enabled) {
    console.log(`[MUSIC-DETECT] [${callId.slice(-8)}] Music detection disabled`);
    return null;
  }

  // Build config from per-call settings and global config
  const trackerConfig: Partial<import("./pipeline/energy-floor").EnergyFloorConfig> = {
    windowSize: perCallSettings?.windowSize ?? config.musicDetection?.windowSize ?? 50,
    floorPercentile: perCallSettings?.floorPercentile ?? config.musicDetection?.floorPercentile ?? 0.10,
    musicThreshold: perCallSettings?.musicThreshold ?? config.musicDetection?.musicThreshold ?? 0.035,
    silenceThreshold: perCallSettings?.silenceThreshold ?? config.musicDetection?.silenceThreshold ?? 0.015,
    hysteresisMs: perCallSettings?.hysteresisMs ?? config.musicDetection?.hysteresisMs ?? 500,
    auditLogging: perCallSettings?.auditLogging ?? config.musicDetection?.auditLogging ?? true,
    logIntervalPackets: config.musicDetection?.logIntervalPackets ?? 50,
  };

  // Create tracker
  const tracker = new EnergyFloorTracker(callId, trackerConfig);
  context.energyFloorTracker = tracker;

  console.log(`[MUSIC-DETECT] [${callId.slice(-8)}] Tracker initialized with config:`, trackerConfig);

  return tracker;
}

/**
 * Append a new turn to the CallContext.
 * If the last turn is from the same speaker (caller), UPDATE it instead of adding new.
 * This prevents duplicate turns when multiple speech segments arrive before AI responds.
 * Automatically trims old turns if the window exceeds maxTurnsInWindow.
 */
export function appendTurn(
  callId: string,
  turn: Turn,
  config: ContextConfig = defaultConfig
): void {
  const context = getOrCreateContext(callId, config);

  // Check if the last turn is from the same speaker - if so, UPDATE instead of APPEND
  // This handles the case where multiple speech_final events fire before AI responds
  const lastTurn = context.turns[context.turns.length - 1];
  if (lastTurn && lastTurn.speaker === turn.speaker && turn.speaker === "caller") {
    // Update the existing turn with the new (accumulated) text
    console.log(`[CONTEXT] Updating last ${turn.speaker} turn instead of appending (${lastTurn.text.length} -> ${turn.text.length} chars)`);
    lastTurn.text = turn.text;
    lastTurn.timestamp = turn.timestamp;
    return; // Don't add a new turn, just updated existing
  }

  // Add the new turn
  context.turns.push(turn);

  // Trim turns that are older than the window and have been included in the summary
  // Keep all turns that haven't been summarized yet
  const turnsToKeepFromSummary =
    context.turns.length - (context.lastSummaryUpdateTurnIndex + 1);
  const maxTurnsToKeepForRecency = config.maxTurnsInWindow;
  const minTurnsToKeep = Math.max(turnsToKeepFromSummary, maxTurnsToKeepForRecency);

  if (context.turns.length > minTurnsToKeep) {
    const excessTurns = context.turns.length - minTurnsToKeep;
    context.turns = context.turns.slice(excessTurns);
    // Adjust the summary index since we've removed turns from the beginning
    context.lastSummaryUpdateTurnIndex = Math.max(
      -1,
      context.lastSummaryUpdateTurnIndex - excessTurns
    );
  }
}

/**
 * Update the rolling summary after a new batch of turns.
 * Call this after generating a new summary from the LLM.
 */
export function updateSummary(
  callId: string,
  newSummary: string,
  newLastSummaryUpdateTurnIndex: number
): void {
  const context = getOrCreateContext(callId);
  context.rollingSummary = newSummary;
  context.lastSummaryUpdateTurnIndex = newLastSummaryUpdateTurnIndex;
}

/**
 * Get the current turns that have NOT been included in the summary yet.
 */
export function getNewTurnsForSummary(callId: string): Turn[] {
  const context = getOrCreateContext(callId);
  const startIndex = context.lastSummaryUpdateTurnIndex + 1;
  return context.turns.slice(startIndex);
}

/**
 * Check if we should update the summary.
 * Returns true if enough new turns have accumulated.
 */
export function shouldUpdateSummary(
  callId: string,
  config: ContextConfig = defaultConfig
): boolean {
  const newTurns = getNewTurnsForSummary(callId);
  return newTurns.length >= config.summaryUpdateIntervalTurns;
}

/**
 * Get the last N turns from the window (for LLM prompt context).
 */
export function getRecentTurns(callId: string, maxTurns: number = 12): Turn[] {
  const context = getOrCreateContext(callId);
  if (context.turns.length <= maxTurns) {
    return context.turns;
  }
  return context.turns.slice(-maxTurns);
}

/**
 * Get the current CallContext by ID.
 */
export function getContext(callId: string): CallContext | undefined {
  return callContextStore.get(callId);
}

/**
 * Clear a CallContext (call cleanup).
 */
export function clearContext(callId: string): void {
  const context = callContextStore.get(callId);
  if (context) {
    // Log Grok end-of-call summary BEFORE clearing
    logGrokEndOfCallSummary(callId);

    // Clean up timers
    if (context.ttsDebounceTimer) {
      clearTimeout(context.ttsDebounceTimer);
    }
    // Clean up hold check-in timer
    if (context.holdCheckInTimer) {
      clearTimeout(context.holdCheckInTimer);
    }
    // Clean up classification timer
    if (context.classificationTimer) {
      clearTimeout(context.classificationTimer);
    }
    // Reset TTS state
    context.ttsState = "idle";
    // Reset hold state
    context.isOnHold = false;
    // Reset IVR state
    context.isIvrMode = false;
    context.ivrConfidence = 0;
    context.ivrMenuOptions = [];
    context.ivrNavigationHistory = [];
    // Reset party detection state
    context.partyDetectionComplete = false;
    context.detectedPartyType = undefined;
    // Reset human detection state
    context.humanDetection = initializeHumanDetectionState();
    context.receiverState = "UNKNOWN";
    // Reset music detection state
    if (context.energyFloorTracker) {
      // Log final audit summary before reset
      console.log(`[MUSIC-DETECT] [${callId.slice(-8)}] Final audit log (last 10 entries):`);
      console.log(context.energyFloorTracker.getFormattedAuditLog(10));
      context.energyFloorTracker.reset();
      context.energyFloorTracker = undefined;
    }
    context.musicDetected = false;
    context.musicConfidence = 0;
    context.musicDetectionState = undefined;
    context.musicStateChangedAt = undefined;
    // Reset diarization state
    context.primarySpeakerId = undefined;
    context.currentSpeakerId = undefined;
    context.previousSpeakerId = undefined;
    context.speakerChangeCount = 0;
    context.lastSpeakerChangeAt = undefined;
    context.speakerChangeDebounceUntil = undefined;
    // Close Deepgram if needed
    if (context.deepgramSocket) {
      try {
        if (typeof context.deepgramSocket.finish === "function") {
          context.deepgramSocket.finish();
        }
        if (typeof context.deepgramSocket.close === "function") {
          context.deepgramSocket.close(1000, "Call ended");
        }
      } catch (error) {
        console.warn("Error closing Deepgram in clearContext:", error);
      }
    }
    // Clear recording buffers to free memory
    if (context.recordingBuffers) {
      context.recordingBuffers.inbound = [];
      context.recordingBuffers.outbound = [];
      context.recordingBuffers = undefined;
    }
  }
  callContextStore.delete(callId);
}

/**
 * Get all active call IDs (for monitoring/cleanup).
 */
export function getActiveCallIds(): string[] {
  return Array.from(callContextStore.keys());
}

/**
 * Format turns as a text block for LLM summary generation.
 * Used in the summarization prompt to show the LLM what needs to be summarized.
 * Uses "RECEIVER" for caller since the AI assistant is making an outbound call.
 */
export function formatTurnsForSummary(turns: Turn[]): string {
  if (turns.length === 0) {
    return "(no new turns)";
  }
  return turns
    .map((turn) => {
      // Map "caller" to "RECEIVER" since AI is making outbound call to them
      const speaker = turn.speaker === "caller" ? "RECEIVER" : turn.speaker.toUpperCase();
      return `[${turn.timestamp}] ${speaker}: ${turn.text}`;
    })
    .join("\n");
}

/**
 * Normalize transcript text for consistent formatting (improves cache hits).
 * - Trims leading/trailing whitespace
 * - Collapses multiple spaces to single space
 * - Normalizes line endings
 * - Lowercases for consistency (transcripts are typically lowercase anyway)
 */
function normalizeTranscriptText(text: string): string {
  if (!text) return "";
  return text
    .trim()                           // Remove leading/trailing whitespace
    .replace(/\s+/g, " ")             // Collapse multiple spaces/newlines to single space
    .toLowerCase();                    // Consistent casing (transcripts are usually lowercase)
}

/**
 * Format recent turns as a message history for the LLM prompt.
 * Maps speakers to chat roles (caller/ivr -> user, assistant -> assistant).
 * Uses [RECEIVER] label since the AI assistant is making an outbound call to them.
 *
 * IMPORTANT: Text is normalized for consistent formatting to improve xAI cache hits.
 * The prefix (system + early turns) should remain stable for cache to work.
 */
export function formatTurnsAsMessages(
  turns: Turn[]
): Array<{ role: "user" | "assistant"; content: string }> {
  return turns.map((turn) => {
    const role =
      turn.speaker === "assistant" ? "assistant" : ("user" as const);
    // Include speaker label for clarity when multiple parties are involved
    // Use "RECEIVER" since the AI assistant (Ferguson) is making an outbound call to them
    const speakerLabel =
      turn.speaker === "assistant"
        ? ""
        : "[RECEIVER] ";

    // Normalize caller transcripts for consistent formatting (helps with prompt caching)
    // Only normalize caller/ivr text (from STT), preserve assistant responses as-is
    const text = turn.speaker === "assistant"
      ? turn.text  // Keep assistant responses exactly as generated
      : normalizeTranscriptText(turn.text);  // Normalize STT transcripts

    return {
      role,
      content: `${speakerLabel}${text}`,
    };
  });
}

// ============================================================================
// GROK CALL STATS FUNCTIONS
// ============================================================================

/**
 * Accumulate stats from a single Grok API call into the call's running totals.
 * Called after each Grok call completes.
 */
export function accumulateGrokCallStats(
  callId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  costUsd: number,
  latencyMs: number
): void {
  const context = getContext(callId);
  if (!context || !context.grokCallStats) {
    console.warn(`[GROK-STATS] Cannot accumulate stats - context not found for ${callId.slice(-8)}`);
    return;
  }

  const stats = context.grokCallStats;

  // Update totals
  stats.totalPromptTokens += promptTokens;
  stats.totalCompletionTokens += completionTokens;
  stats.totalTokens += promptTokens + completionTokens;
  stats.totalCachedTokens += cachedTokens;
  stats.totalCostUsd += costUsd;
  stats.grokCallCount += 1;

  // Track cache hits
  if (cachedTokens > 0) {
    stats.cacheHitCount += 1;
    // Calculate cost saved: cached tokens are 75% cheaper
    // Full price would be (cachedTokens / 1M) * inputPrice
    // Cached price is (cachedTokens / 1M) * inputPrice * 0.25
    // Savings = full - cached = (cachedTokens / 1M) * inputPrice * 0.75
    const inputPricePerM = 2.0; // Default Grok pricing
    const savings = (cachedTokens / 1_000_000) * inputPricePerM * 0.75;
    stats.costSavedFromCaching += savings;
  }

  // Update latency stats
  stats.totalLatencyMs += latencyMs;
  stats.avgLatencyMs = stats.totalLatencyMs / stats.grokCallCount;
  if (latencyMs < stats.minLatencyMs) stats.minLatencyMs = latencyMs;
  if (latencyMs > stats.maxLatencyMs) stats.maxLatencyMs = latencyMs;

  // Update per-model breakdown
  if (!stats.byModel[model]) {
    stats.byModel[model] = {
      callCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      latencyMs: 0,
    };
  }
  const modelStats = stats.byModel[model];
  modelStats.callCount += 1;
  modelStats.promptTokens += promptTokens;
  modelStats.completionTokens += completionTokens;
  modelStats.totalTokens += promptTokens + completionTokens;
  modelStats.cachedTokens += cachedTokens;
  modelStats.costUsd += costUsd;
  modelStats.latencyMs += latencyMs;

  // Log running total
  console.log(
    `[GROK-STATS] 📊 Call ${stats.grokCallCount} | Running Total: ${stats.totalTokens.toLocaleString()} tokens, ` +
    `$${stats.totalCostUsd.toFixed(6)} | Cached: ${stats.totalCachedTokens.toLocaleString()} (${stats.cacheHitCount} hits)`
  );
}

/**
 * Log comprehensive end-of-call summary for all Grok usage.
 * Called when clearContext is invoked (call ends).
 */
export function logGrokEndOfCallSummary(callId: string): void {
  const context = getContext(callId);
  if (!context || !context.grokCallStats || context.grokCallStats.grokCallCount === 0) {
    return; // No Grok calls made during this call
  }

  const stats = context.grokCallStats;
  const callIdShort = callId.slice(-8);

  console.log("\n" + "█".repeat(80));
  console.log(`[GROK-GRANT] 🏁 END OF CALL SUMMARY - Call ID: ...${callIdShort}`);
  console.log(`[GROK-GRANT] 📅 ${new Date().toISOString()}`);
  console.log(`[GROK-GRANT] 🔑 Conversation ID: ${context.grokConversationId}`);
  console.log("█".repeat(80));

  // -------------------------------------------------------------------------
  // OVERALL TOTALS
  // -------------------------------------------------------------------------
  console.log("\n" + "─".repeat(60));
  console.log("[GROK-GRANT] 📊 OVERALL TOTALS");
  console.log("─".repeat(60));
  console.log(`[GROK-GRANT] 📞 Total Grok API Calls: ${stats.grokCallCount}`);
  console.log(`[GROK-GRANT] 🔢 Total Tokens Used: ${stats.totalTokens.toLocaleString()}`);
  console.log(`[GROK-GRANT]    ➡️  Prompt Tokens: ${stats.totalPromptTokens.toLocaleString()}`);
  console.log(`[GROK-GRANT]    ⬅️  Completion Tokens: ${stats.totalCompletionTokens.toLocaleString()}`);

  // -------------------------------------------------------------------------
  // CACHING STATS
  // -------------------------------------------------------------------------
  console.log("\n" + "─".repeat(60));
  console.log("[GROK-GRANT] 💾 CACHING PERFORMANCE");
  console.log("─".repeat(60));
  const cacheHitRate = stats.grokCallCount > 0
    ? (stats.cacheHitCount / stats.grokCallCount * 100).toFixed(1)
    : "0.0";
  const tokenCacheRate = stats.totalPromptTokens > 0
    ? (stats.totalCachedTokens / stats.totalPromptTokens * 100).toFixed(1)
    : "0.0";
  console.log(`[GROK-GRANT] 💾 Cached Tokens: ${stats.totalCachedTokens.toLocaleString()}`);
  console.log(`[GROK-GRANT] 📈 Cache Hit Rate: ${cacheHitRate}% of calls (${stats.cacheHitCount}/${stats.grokCallCount})`);
  console.log(`[GROK-GRANT] 📈 Token Cache Rate: ${tokenCacheRate}% of prompt tokens`);
  console.log(`[GROK-GRANT] 💵 Cost Saved from Caching: $${stats.costSavedFromCaching.toFixed(6)}`);

  // -------------------------------------------------------------------------
  // COST BREAKDOWN
  // -------------------------------------------------------------------------
  console.log("\n" + "─".repeat(60));
  console.log("[GROK-GRANT] 💰 COST BREAKDOWN");
  console.log("─".repeat(60));
  console.log(`[GROK-GRANT] 💵 Total Cost: $${stats.totalCostUsd.toFixed(6)}`);
  const avgCostPerCall = stats.grokCallCount > 0
    ? (stats.totalCostUsd / stats.grokCallCount).toFixed(6)
    : "0.000000";
  console.log(`[GROK-GRANT] 📊 Avg Cost Per Call: $${avgCostPerCall}`);
  const costPerThousandTokens = stats.totalTokens > 0
    ? (stats.totalCostUsd / (stats.totalTokens / 1000)).toFixed(6)
    : "0.000000";
  console.log(`[GROK-GRANT] 📊 Cost Per 1K Tokens: $${costPerThousandTokens}`);

  // What we would have paid without caching
  const wouldHavePaid = stats.totalCostUsd + stats.costSavedFromCaching;
  const savingsPercent = wouldHavePaid > 0
    ? (stats.costSavedFromCaching / wouldHavePaid * 100).toFixed(1)
    : "0.0";
  console.log(`[GROK-GRANT] 💸 Would Have Paid (no cache): $${wouldHavePaid.toFixed(6)}`);
  console.log(`[GROK-GRANT] 🎉 Total Savings: $${stats.costSavedFromCaching.toFixed(6)} (${savingsPercent}%)`);

  // -------------------------------------------------------------------------
  // PERFORMANCE STATS
  // -------------------------------------------------------------------------
  console.log("\n" + "─".repeat(60));
  console.log("[GROK-GRANT] ⚡ PERFORMANCE STATS");
  console.log("─".repeat(60));
  console.log(`[GROK-GRANT] ⏱️  Total Latency: ${stats.totalLatencyMs.toLocaleString()}ms`);
  console.log(`[GROK-GRANT] 📊 Avg Latency: ${stats.avgLatencyMs.toFixed(0)}ms`);
  console.log(`[GROK-GRANT] ⚡ Min Latency: ${stats.minLatencyMs === Infinity ? 'N/A' : stats.minLatencyMs + 'ms'}`);
  console.log(`[GROK-GRANT] 🐌 Max Latency: ${stats.maxLatencyMs}ms`);
  const avgTokensPerSecond = stats.totalLatencyMs > 0
    ? (stats.totalCompletionTokens / (stats.totalLatencyMs / 1000)).toFixed(1)
    : "0.0";
  console.log(`[GROK-GRANT] 🚀 Avg Output Speed: ${avgTokensPerSecond} tokens/sec`);

  // -------------------------------------------------------------------------
  // PER-MODEL BREAKDOWN
  // -------------------------------------------------------------------------
  const modelNames = Object.keys(stats.byModel);
  if (modelNames.length > 0) {
    console.log("\n" + "─".repeat(60));
    console.log("[GROK-GRANT] 🤖 PER-MODEL BREAKDOWN");
    console.log("─".repeat(60));
    for (const modelName of modelNames) {
      const m = stats.byModel[modelName];
      console.log(`\n[GROK-GRANT] 📌 ${modelName}:`);
      console.log(`[GROK-GRANT]    📞 Calls: ${m.callCount}`);
      console.log(`[GROK-GRANT]    🔢 Tokens: ${m.totalTokens.toLocaleString()} (prompt: ${m.promptTokens.toLocaleString()}, completion: ${m.completionTokens.toLocaleString()})`);
      console.log(`[GROK-GRANT]    💾 Cached: ${m.cachedTokens.toLocaleString()}`);
      console.log(`[GROK-GRANT]    💵 Cost: $${m.costUsd.toFixed(6)}`);
      console.log(`[GROK-GRANT]    ⏱️  Avg Latency: ${(m.latencyMs / m.callCount).toFixed(0)}ms`);
    }
  }

  // -------------------------------------------------------------------------
  // FINAL SUMMARY BOX
  // -------------------------------------------------------------------------
  console.log("\n" + "█".repeat(80));
  console.log(`[GROK-GRANT] 📋 FINAL SUMMARY: ${stats.grokCallCount} calls | ${stats.totalTokens.toLocaleString()} tokens | $${stats.totalCostUsd.toFixed(4)} total | $${stats.costSavedFromCaching.toFixed(4)} saved`);
  console.log("█".repeat(80) + "\n");
}

export { defaultConfig as DEFAULT_CONFIG };
