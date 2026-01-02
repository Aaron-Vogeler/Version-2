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
import { calculateDeepgramCost, calculateFlyioCost, DEEPGRAM_PRICING, FLYIO_PRICING, TELNYX_TTS_PRICING } from "./utils/supabase";

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
 * Accumulated stats for TTS (Text-to-Speech) usage within a single phone call
 * Used for Telnyx TTS cost estimation
 */
export interface TtsAccumulatedStats {
  // Character/word counts
  totalCharacters: number;
  totalWords: number;
  totalUtterances: number; // Number of speak() calls

  // Timing (estimated from characters)
  estimatedAudioDurationSec: number;

  // Cost tracking
  estimatedCostUsd: number;

  // Voice breakdown (voiceId -> stats)
  byVoice: Record<string, {
    utteranceCount: number;
    characters: number;
    words: number;
    estimatedCostUsd: number;
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
 * Represents a historical rolling summary snapshot.
 * Used for append-only message history - summaries are added at the end
 * and never moved or modified once placed.
 */
export interface SummaryHistoryEntry {
  summary: string;
  addedAtTurnIndex: number; // Turn index when this summary was generated
  createdAt: string; // ISO timestamp
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

  // ============================================================================
  // COMPREHENSIVE CALL COST TRACKING
  // ============================================================================
  /** Accumulated TTS usage stats (Telnyx TTS) */
  ttsStats?: TtsAccumulatedStats;
  /** Telnyx telephony cost (from call.cost webhook) */
  telnyxTelephonyCost?: number;
  /** Telnyx billed seconds (from call.cost webhook) */
  telnyxBilledSeconds?: number;

  // ============================================================================
  // APPEND-ONLY SUMMARY HISTORY (for stable message ordering / cache hits)
  // ============================================================================
  /**
   * History of rolling summaries - each summary is appended when generated
   * and never moved or modified. This enables stable message prefixes for caching.
   */
  summaryHistory?: SummaryHistoryEntry[];
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

// Temporary store for ended calls awaiting cost webhook (TTL: 60 seconds)
// Stores essential data needed for end-of-call summary after context is cleared
interface EndedCallData {
  callId: string;
  initiatedAt?: string;
  grokCallStats?: GrokCallAccumulatedStats;
  ttsStats?: TtsAccumulatedStats;
  deepgramDurationSec?: number;
  endedAt: number; // Date.now() when call ended
  summaryLogged: boolean; // Whether summary was already logged
}
const endedCallsCache = new Map<string, EndedCallData>();

// Clean up old entries from endedCallsCache (runs every 60 seconds)
const ENDED_CALL_CACHE_TTL_MS = 60000; // 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [callId, data] of endedCallsCache.entries()) {
    if (now - data.endedAt > ENDED_CALL_CACHE_TTL_MS) {
      // Log summary if we never received cost webhook
      if (!data.summaryLogged) {
        logEndOfCallCostSummaryFromCache(callId, data);
      }
      endedCallsCache.delete(callId);
    }
  }
}, 30000); // Check every 30 seconds

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
      // Append-only summary history for stable message ordering
      summaryHistory: [],
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
 *
 * APPEND-ONLY BEHAVIOR: Each new summary is added to summaryHistory and never
 * moved or modified. This enables stable message prefixes for prompt caching.
 */
export function updateSummary(
  callId: string,
  newSummary: string,
  newLastSummaryUpdateTurnIndex: number
): void {
  const context = getOrCreateContext(callId);

  // Update current rolling summary (for backwards compatibility)
  context.rollingSummary = newSummary;
  context.lastSummaryUpdateTurnIndex = newLastSummaryUpdateTurnIndex;

  // APPEND-ONLY: Add to summary history - summaries are never moved or removed
  if (!context.summaryHistory) {
    context.summaryHistory = [];
  }
  context.summaryHistory.push({
    summary: newSummary,
    addedAtTurnIndex: newLastSummaryUpdateTurnIndex,
    createdAt: new Date().toISOString(),
  });

  console.log(`[CONTEXT] Summary #${context.summaryHistory.length} added to history at turn ${newLastSummaryUpdateTurnIndex}`);
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
    // Calculate Deepgram duration before clearing
    let deepgramDurationSec: number | undefined;
    if (context.deepgramStartedAt) {
      deepgramDurationSec = (Date.now() - context.deepgramStartedAt) / 1000;
    }

    // LOG THE COST SUMMARY IMMEDIATELY - don't wait for webhook
    logEndOfCallCostSummary(callId, deepgramDurationSec);

    // Also save to cache in case call.cost webhook arrives later (for updating)
    endedCallsCache.set(callId, {
      callId,
      initiatedAt: context.initiatedAt,
      grokCallStats: context.grokCallStats,
      ttsStats: context.ttsStats,
      deepgramDurationSec,
      endedAt: Date.now(),
      summaryLogged: true, // Already logged above
    });

    // Log detailed Grok breakdown
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
 * Format recent turns as a message history for the LLM prompt.
 * Maps speakers to chat roles (caller/ivr -> user, assistant -> assistant).
 * Uses [RECEIVER] label since the AI assistant is making an outbound call to them.
 *
 * IMPORTANT: Messages are append-only - never reorder or modify existing messages.
 * This is critical for xAI prompt caching (prefix matching).
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
    return {
      role,
      content: `${speakerLabel}${turn.text}`,
    };
  });
}

/**
 * Get the summary history for a call.
 * Returns all historical summaries in the order they were added (append-only).
 */
export function getSummaryHistory(callId: string): SummaryHistoryEntry[] {
  const context = getContext(callId);
  return context?.summaryHistory || [];
}

/**
 * Format summary history as messages for the LLM prompt.
 * Each historical summary becomes a user message with context label.
 *
 * IMPORTANT: Summaries are returned in the order they were added and should
 * be appended to the message list WITHOUT reordering existing content.
 */
export function formatSummaryHistoryAsMessages(
  summaryHistory: SummaryHistoryEntry[]
): Array<{ role: "user"; content: string }> {
  return summaryHistory.map((entry, index) => ({
    role: "user" as const,
    content: `[CALL SUMMARY #${index + 1}]\n${entry.summary}`,
  }));
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

// ============================================================================
// TTS CALL STATS FUNCTIONS
// ============================================================================

/**
 * Accumulate stats from a single TTS speak call into the call's running totals.
 * Called after each TTS speak request.
 */
export function accumulateTtsStats(
  callId: string,
  text: string,
  voiceId: string,
  costUsd: number
): void {
  const context = getContext(callId);
  if (!context) {
    console.warn(`[TTS-STATS] Cannot accumulate stats - context not found for ${callId.slice(-8)}`);
    return;
  }

  // Initialize TTS stats if not exists
  if (!context.ttsStats) {
    context.ttsStats = {
      totalCharacters: 0,
      totalWords: 0,
      totalUtterances: 0,
      estimatedAudioDurationSec: 0,
      estimatedCostUsd: 0,
      byVoice: {},
    };
  }

  const stats = context.ttsStats;
  const chars = text.length;
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  // Estimate duration: ~750 chars/minute = 12.5 chars/sec
  const durationSec = chars / 12.5;

  // Update totals
  stats.totalCharacters += chars;
  stats.totalWords += words;
  stats.totalUtterances += 1;
  stats.estimatedAudioDurationSec += durationSec;
  stats.estimatedCostUsd += costUsd;

  // Update per-voice breakdown
  if (!stats.byVoice[voiceId]) {
    stats.byVoice[voiceId] = {
      utteranceCount: 0,
      characters: 0,
      words: 0,
      estimatedCostUsd: 0,
    };
  }
  const voiceStats = stats.byVoice[voiceId];
  voiceStats.utteranceCount += 1;
  voiceStats.characters += chars;
  voiceStats.words += words;
  voiceStats.estimatedCostUsd += costUsd;

  // Log running total
  console.log(
    `[TTS-STATS] 🎤 Utterance ${stats.totalUtterances} | Running Total: ${stats.totalCharacters.toLocaleString()} chars, ` +
    `~${stats.estimatedAudioDurationSec.toFixed(1)}s audio, $${stats.estimatedCostUsd.toFixed(6)}`
  );
}

/**
 * Set Telnyx telephony cost from webhook (call.cost event).
 * If context still exists, updates it. Otherwise, checks the ended calls cache
 * and logs the comprehensive cost summary.
 */
export function setTelnyxTelephonyCost(
  callId: string,
  costUsd: number,
  billedSeconds: number
): void {
  // First try to update the active context
  const context = getContext(callId);
  if (context) {
    context.telnyxTelephonyCost = costUsd;
    context.telnyxBilledSeconds = billedSeconds;
    const costStr = typeof costUsd === 'number' && !isNaN(costUsd) ? `$${costUsd.toFixed(6)}` : 'N/A';
    console.log(`[TELNYX-COST] 📞 Telephony cost set: ${costStr}, ${billedSeconds}s billed`);
    return;
  }

  // Context already cleared - check the ended calls cache
  const cachedData = endedCallsCache.get(callId);
  if (cachedData && !cachedData.summaryLogged) {
    // Ensure we have valid numbers
    const costNum = typeof costUsd === 'number' && !isNaN(costUsd) ? costUsd : 0;
    const billedNum = typeof billedSeconds === 'number' && !isNaN(billedSeconds) ? billedSeconds : 0;
    console.log(`[TELNYX-COST] 📞 Received telephony cost after call ended: $${costNum.toFixed(6)}, ${billedNum}s billed`);

    // Log the comprehensive summary with the telephony cost
    logEndOfCallCostSummaryFromCache(callId, cachedData, costNum, billedNum);

    // Mark as logged and clean up
    cachedData.summaryLogged = true;
    endedCallsCache.delete(callId);
    return;
  }

  // Neither context nor cache found
  console.warn(`[TELNYX-COST] Cannot set cost - no context or cache for ${callId.slice(-8)}`);
}

/**
 * Log comprehensive end-of-call summary for all Grok usage.
 * Called when clearContext is invoked (call ends).
 *
 * Includes: call duration, token breakdown with costs, caching stats,
 * performance metrics, and per-model breakdown.
 */
export function logGrokEndOfCallSummary(callId: string): void {
  const context = getContext(callId);
  if (!context || !context.grokCallStats || context.grokCallStats.grokCallCount === 0) {
    return; // No Grok calls made during this call
  }

  const stats = context.grokCallStats;
  const callIdShort = callId.slice(-8);
  const endTime = new Date();

  // Calculate call duration
  let callDurationMs = 0;
  let callDurationStr = "N/A";
  if (context.initiatedAt) {
    const startTime = new Date(context.initiatedAt);
    callDurationMs = endTime.getTime() - startTime.getTime();
    const durationSecs = Math.floor(callDurationMs / 1000);
    const mins = Math.floor(durationSecs / 60);
    const secs = durationSecs % 60;
    callDurationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  // Calculate input/output costs separately (using Grok 4.1 fast pricing: $2/1M input, $10/1M output)
  const INPUT_PRICE_PER_M = 2.0;
  const OUTPUT_PRICE_PER_M = 10.0;
  const CACHED_DISCOUNT = 0.75; // 75% discount for cached tokens

  const uncachedPromptTokens = stats.totalPromptTokens - stats.totalCachedTokens;
  const inputCostFull = (uncachedPromptTokens / 1_000_000) * INPUT_PRICE_PER_M;
  const inputCostCached = (stats.totalCachedTokens / 1_000_000) * INPUT_PRICE_PER_M * (1 - CACHED_DISCOUNT);
  const totalInputCost = inputCostFull + inputCostCached;
  const outputCost = (stats.totalCompletionTokens / 1_000_000) * OUTPUT_PRICE_PER_M;

  // Calculate tokens per minute
  const tokensPerMin = callDurationMs > 0
    ? Math.round((stats.totalTokens / callDurationMs) * 60000)
    : 0;
  const promptTokensPerMin = callDurationMs > 0
    ? Math.round((stats.totalPromptTokens / callDurationMs) * 60000)
    : 0;
  const completionTokensPerMin = callDurationMs > 0
    ? Math.round((stats.totalCompletionTokens / callDurationMs) * 60000)
    : 0;

  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║              GROK GRANT CALL - END OF CALL TOKEN/COST SUMMARY                  ║");
  console.log("╠════════════════════════════════════════════════════════════════════════════════╣");
  console.log(`║  Call ID: ...${callIdShort.padEnd(12)} │ Conv ID: ${(context.grokConversationId || "N/A").slice(0, 8)}...              ║`);
  console.log(`║  Duration: ${callDurationStr.padEnd(10)}       │ Ended: ${endTime.toISOString().slice(11, 19)} UTC                 ║`);
  console.log("╠════════════════════════════════════════════════════════════════════════════════╣");

  // TOKEN BREAKDOWN TABLE
  console.log("║                              TOKEN BREAKDOWN                                   ║");
  console.log("╟────────────────────────────────────────────────────────────────────────────────╢");
  console.log("║  Category          │    Tokens    │  Cost ($)  │  $/1K Tokens  │  Tokens/Min  ║");
  console.log("╟────────────────────┼──────────────┼────────────┼───────────────┼──────────────╢");

  const formatRow = (label: string, tokens: number, cost: number, perMin: number): string => {
    const tokensStr = tokens.toLocaleString().padStart(10);
    const costStr = cost.toFixed(6).padStart(10);
    const per1kStr = tokens > 0 ? ((cost / tokens) * 1000).toFixed(4).padStart(11) : "N/A".padStart(11);
    const perMinStr = perMin.toLocaleString().padStart(10);
    return `║  ${label.padEnd(17)} │ ${tokensStr} │ ${costStr} │ ${per1kStr}   │ ${perMinStr} ║`;
  };

  console.log(formatRow("Prompt (Input)", stats.totalPromptTokens, totalInputCost, promptTokensPerMin));
  console.log(formatRow("  - Uncached", uncachedPromptTokens, inputCostFull, 0));
  console.log(formatRow("  - Cached", stats.totalCachedTokens, inputCostCached, 0));
  console.log(formatRow("Completion (Out)", stats.totalCompletionTokens, outputCost, completionTokensPerMin));
  console.log("╟────────────────────┼──────────────┼────────────┼───────────────┼──────────────╢");
  console.log(formatRow("TOTAL", stats.totalTokens, stats.totalCostUsd, tokensPerMin));
  console.log("╠════════════════════════════════════════════════════════════════════════════════╣");

  // CACHING PERFORMANCE
  console.log("║                            CACHING PERFORMANCE                                 ║");
  console.log("╟────────────────────────────────────────────────────────────────────────────────╢");
  const cacheHitRate = stats.grokCallCount > 0
    ? (stats.cacheHitCount / stats.grokCallCount * 100).toFixed(1)
    : "0.0";
  const tokenCacheRate = stats.totalPromptTokens > 0
    ? (stats.totalCachedTokens / stats.totalPromptTokens * 100).toFixed(1)
    : "0.0";
  const wouldHavePaid = stats.totalCostUsd + stats.costSavedFromCaching;
  const savingsPercent = wouldHavePaid > 0
    ? (stats.costSavedFromCaching / wouldHavePaid * 100).toFixed(1)
    : "0.0";

  console.log(`║  Cache Hit Rate:    ${cacheHitRate.padStart(6)}% of calls (${stats.cacheHitCount}/${stats.grokCallCount})                               ║`);
  console.log(`║  Token Cache Rate:  ${tokenCacheRate.padStart(6)}% of prompt tokens cached                            ║`);
  console.log(`║  Cost Without Cache: $${wouldHavePaid.toFixed(6).padStart(10)}                                          ║`);
  console.log(`║  Cost With Cache:    $${stats.totalCostUsd.toFixed(6).padStart(10)}                                          ║`);
  console.log(`║  SAVINGS:            $${stats.costSavedFromCaching.toFixed(6).padStart(10)} (${savingsPercent}%)                                 ║`);
  console.log("╠════════════════════════════════════════════════════════════════════════════════╣");

  // API CALL STATS
  console.log("║                              API CALL STATS                                    ║");
  console.log("╟────────────────────────────────────────────────────────────────────────────────╢");
  console.log(`║  Total API Calls:   ${stats.grokCallCount.toString().padStart(6)}                                                    ║`);
  console.log(`║  Total Latency:     ${stats.totalLatencyMs.toLocaleString().padStart(6)}ms                                                ║`);
  console.log(`║  Avg Latency:       ${stats.avgLatencyMs.toFixed(0).padStart(6)}ms                                                ║`);
  console.log(`║  Min Latency:       ${(stats.minLatencyMs === Infinity ? 'N/A' : stats.minLatencyMs + 'ms').padStart(6)}                                                ║`);
  console.log(`║  Max Latency:       ${(stats.maxLatencyMs + 'ms').padStart(6)}                                                ║`);
  const avgTokensPerSecond = stats.totalLatencyMs > 0
    ? (stats.totalCompletionTokens / (stats.totalLatencyMs / 1000)).toFixed(1)
    : "0.0";
  console.log(`║  Avg Output Speed:  ${avgTokensPerSecond.padStart(6)} tokens/sec                                       ║`);

  // SUMMARY HISTORY
  const summaryCount = context.summaryHistory?.length || 0;
  if (summaryCount > 0) {
    console.log("╠════════════════════════════════════════════════════════════════════════════════╣");
    console.log("║                            ROLLING SUMMARIES                                   ║");
    console.log("╟────────────────────────────────────────────────────────────────────────────────╢");
    console.log(`║  Summaries Generated: ${summaryCount.toString().padStart(4)}                                                     ║`);
    console.log(`║  Turn Count:          ${context.turns.length.toString().padStart(4)}                                                     ║`);
  }

  // PER-MODEL BREAKDOWN
  const modelNames = Object.keys(stats.byModel);
  if (modelNames.length > 0) {
    console.log("╠════════════════════════════════════════════════════════════════════════════════╣");
    console.log("║                            PER-MODEL BREAKDOWN                                 ║");
    console.log("╟────────────────────────────────────────────────────────────────────────────────╢");
    for (const modelName of modelNames) {
      const m = stats.byModel[modelName];
      const modelShort = modelName.length > 30 ? modelName.slice(0, 27) + "..." : modelName;
      console.log(`║  ${modelShort.padEnd(30)}                                             ║`);
      console.log(`║    Calls: ${m.callCount.toString().padStart(4)} │ Tokens: ${m.totalTokens.toLocaleString().padStart(8)} │ Cost: $${m.costUsd.toFixed(4).padStart(8)} │ Latency: ${(m.latencyMs / m.callCount).toFixed(0).padStart(5)}ms  ║`);
    }
  }

  console.log("╠════════════════════════════════════════════════════════════════════════════════╣");
  console.log("║                               FINAL TOTALS                                     ║");
  console.log("╟────────────────────────────────────────────────────────────────────────────────╢");
  console.log(`║   ${stats.grokCallCount} API calls │ ${stats.totalTokens.toLocaleString()} tokens │ $${stats.totalCostUsd.toFixed(4)} spent │ $${stats.costSavedFromCaching.toFixed(4)} saved     ║`);
  console.log("╚════════════════════════════════════════════════════════════════════════════════╝");
  console.log("\n");
}

// ============================================================================
// COMPREHENSIVE CALL COST SUMMARY
// ============================================================================

/**
 * Log comprehensive end-of-call cost summary for ALL services.
 * Called when clearContext is invoked (call ends).
 *
 * Includes costs for:
 * 1. Fly.io server (compute time)
 * 2. Telnyx Telephony (from webhook)
 * 3. Deepgram STT (from duration)
 * 4. Grok LLM (tokens)
 * 5. Telnyx TTS (characters)
 */
export function logEndOfCallCostSummary(callId: string, deepgramDurationSec?: number): void {
  const context = getContext(callId);
  if (!context) {
    return;
  }

  const callIdShort = callId.slice(-8);
  const endTime = new Date();

  // Calculate call duration
  let callDurationMs = 0;
  let callDurationSec = 0;
  let callDurationStr = "N/A";
  if (context.initiatedAt) {
    const startTime = new Date(context.initiatedAt);
    callDurationMs = endTime.getTime() - startTime.getTime();
    callDurationSec = callDurationMs / 1000;
    const mins = Math.floor(callDurationSec / 60);
    const secs = Math.floor(callDurationSec % 60);
    callDurationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  // Calculate all costs
  // 1. Fly.io compute cost (based on call duration)
  const flyioCost = calculateFlyioCost(callDurationSec);

  // 2. Telnyx telephony cost (from webhook, stored in context)
  const telnyxTelephonyCost = context.telnyxTelephonyCost || 0;
  const telnyxBilledSec = context.telnyxBilledSeconds || 0;

  // 3. Deepgram STT cost (from passed duration or estimate from call duration)
  const sttDurationSec = deepgramDurationSec || callDurationSec;
  const deepgramCost = calculateDeepgramCost(sttDurationSec, config.deepgram?.model || "nova-2");

  // 4. Grok LLM cost (from accumulated stats)
  const grokStats = context.grokCallStats;
  const grokCost = grokStats?.totalCostUsd || 0;
  const grokTokens = grokStats?.totalTokens || 0;
  const grokCalls = grokStats?.grokCallCount || 0;
  const grokSavings = grokStats?.costSavedFromCaching || 0;

  // 5. Telnyx TTS cost (from accumulated stats)
  const ttsStats = context.ttsStats;
  const ttsCost = ttsStats?.estimatedCostUsd || 0;
  const ttsChars = ttsStats?.totalCharacters || 0;
  const ttsUtterances = ttsStats?.totalUtterances || 0;

  // Calculate totals
  const totalCost = flyioCost + telnyxTelephonyCost + deepgramCost + grokCost + ttsCost;
  const totalSavings = grokSavings;

  // Skip summary if no costs recorded
  if (totalCost === 0 && grokCalls === 0 && ttsUtterances === 0) {
    return;
  }

  console.log("\n");
  console.log("╔══════════════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                        END OF CALL - COMPREHENSIVE COST SUMMARY                          ║");
  console.log("╠══════════════════════════════════════════════════════════════════════════════════════════╣");
  console.log(`║  Call ID: ...${callIdShort.padEnd(12)} │ Duration: ${callDurationStr.padEnd(10)} │ Ended: ${endTime.toISOString().slice(11, 19)} UTC       ║`);
  console.log("╠══════════════════════════════════════════════════════════════════════════════════════════╣");

  // COST BREAKDOWN TABLE
  console.log("║                                    COST BREAKDOWN                                        ║");
  console.log("╟──────────────────────────────────────────────────────────────────────────────────────────╢");
  console.log("║  Service             │   Cost ($)   │   Usage                  │  Rate                   ║");
  console.log("╟──────────────────────┼──────────────┼──────────────────────────┼─────────────────────────╢");

  const formatCostRow = (service: string, cost: number, usage: string, rate: string): string => {
    const costStr = `$${cost.toFixed(6)}`.padStart(12);
    return `║  ${service.padEnd(19)} │ ${costStr} │ ${usage.padEnd(24)} │ ${rate.padEnd(23)} ║`;
  };

  // 1. Fly.io Server
  console.log(formatCostRow(
    "Fly.io Server",
    flyioCost,
    `${callDurationSec.toFixed(1)}s compute`,
    `$${FLYIO_PRICING.sharedCpu1xWith1GbPerHour.toFixed(4)}/hr`
  ));

  // 2. Telnyx Telephony
  console.log(formatCostRow(
    "Telnyx Telephony",
    telnyxTelephonyCost,
    telnyxBilledSec > 0 ? `${telnyxBilledSec}s billed` : "N/A (pending)",
    "Per-minute billing"
  ));

  // 3. Deepgram STT
  console.log(formatCostRow(
    "Deepgram STT",
    deepgramCost,
    `${sttDurationSec.toFixed(1)}s audio`,
    `$${DEEPGRAM_PRICING.default.toFixed(4)}/min`
  ));

  // 4. Grok LLM
  console.log(formatCostRow(
    "Grok LLM (xAI)",
    grokCost,
    grokTokens > 0 ? `${grokTokens.toLocaleString()} tokens` : "No calls",
    grokCalls > 0 ? `${grokCalls} API calls` : "N/A"
  ));

  // 5. Telnyx TTS
  console.log(formatCostRow(
    "Telnyx TTS",
    ttsCost,
    ttsChars > 0 ? `${ttsChars.toLocaleString()} chars` : "No TTS",
    `$${TELNYX_TTS_PRICING.pricePerThousandChars}/1K chars`
  ));

  console.log("╟──────────────────────┼──────────────┼──────────────────────────┼─────────────────────────╢");

  // TOTALS ROW
  const totalStr = `$${totalCost.toFixed(6)}`.padStart(12);
  console.log(`║  TOTAL               │ ${totalStr} │                          │                         ║`);

  // SAVINGS (if any)
  if (totalSavings > 0) {
    const savingsStr = `$${totalSavings.toFixed(6)}`.padStart(12);
    console.log(`║  Cache Savings       │ ${savingsStr} │ From Grok prompt caching │                         ║`);
  }

  console.log("╠══════════════════════════════════════════════════════════════════════════════════════════╣");

  // PERCENTAGE BREAKDOWN
  console.log("║                                  COST DISTRIBUTION                                       ║");
  console.log("╟──────────────────────────────────────────────────────────────────────────────────────────╢");

  const calcPercent = (cost: number): string => {
    if (totalCost === 0) return "0.0%";
    return `${((cost / totalCost) * 100).toFixed(1)}%`;
  };

  const formatBarRow = (service: string, cost: number): string => {
    const percent = totalCost > 0 ? (cost / totalCost) * 100 : 0;
    const barLength = Math.round(percent / 2); // Max 50 chars for 100%
    const bar = "█".repeat(barLength) + "░".repeat(50 - barLength);
    return `║  ${service.padEnd(17)} ${calcPercent(cost).padStart(6)} ${bar}  ║`;
  };

  console.log(formatBarRow("Fly.io", flyioCost));
  console.log(formatBarRow("Telephony", telnyxTelephonyCost));
  console.log(formatBarRow("Deepgram STT", deepgramCost));
  console.log(formatBarRow("Grok LLM", grokCost));
  console.log(formatBarRow("Telnyx TTS", ttsCost));

  console.log("╠══════════════════════════════════════════════════════════════════════════════════════════╣");
  console.log("║                                    QUICK STATS                                           ║");
  console.log("╟──────────────────────────────────────────────────────────────────────────────────────────╢");

  // Cost per minute
  const costPerMin = callDurationSec > 0 ? (totalCost / (callDurationSec / 60)) : 0;
  console.log(`║  Cost per minute:     $${costPerMin.toFixed(4).padStart(10)}                                                      ║`);
  console.log(`║  Total call cost:     $${totalCost.toFixed(6).padStart(10)}                                                      ║`);
  if (totalSavings > 0) {
    const effectiveCost = totalCost - totalSavings;
    console.log(`║  Effective cost:      $${effectiveCost.toFixed(6).padStart(10)} (after cache savings)                              ║`);
  }

  console.log("╚══════════════════════════════════════════════════════════════════════════════════════════╝");
  console.log("\n");
}

/**
 * Log comprehensive end-of-call cost summary from cached data.
 * Used when call.cost webhook arrives after context is cleared.
 */
function logEndOfCallCostSummaryFromCache(
  callId: string,
  cachedData: EndedCallData,
  telnyxTelephonyCost: number = 0,
  telnyxBilledSeconds: number = 0
): void {
  const callIdShort = callId.slice(-8);
  const endTime = new Date();

  // Calculate call duration from cached data
  let callDurationMs = 0;
  let callDurationSec = 0;
  let callDurationStr = "N/A";
  if (cachedData.initiatedAt) {
    const startTime = new Date(cachedData.initiatedAt);
    callDurationMs = cachedData.endedAt - startTime.getTime();
    callDurationSec = callDurationMs / 1000;
    const mins = Math.floor(callDurationSec / 60);
    const secs = Math.floor(callDurationSec % 60);
    callDurationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  // Calculate all costs
  // 1. Fly.io compute cost (based on call duration)
  const flyioCost = calculateFlyioCost(callDurationSec);

  // 2. Telnyx telephony cost (from webhook parameter)

  // 3. Deepgram STT cost
  const sttDurationSec = cachedData.deepgramDurationSec || callDurationSec;
  const deepgramCost = calculateDeepgramCost(sttDurationSec, config.deepgram?.model || "nova-2");

  // 4. Grok LLM cost (from cached stats)
  const grokStats = cachedData.grokCallStats;
  const grokCost = grokStats?.totalCostUsd || 0;
  const grokTokens = grokStats?.totalTokens || 0;
  const grokCalls = grokStats?.grokCallCount || 0;
  const grokSavings = grokStats?.costSavedFromCaching || 0;

  // 5. Telnyx TTS cost (from cached stats)
  const ttsStats = cachedData.ttsStats;
  const ttsCost = ttsStats?.estimatedCostUsd || 0;
  const ttsChars = ttsStats?.totalCharacters || 0;

  // Calculate totals
  const totalCost = flyioCost + telnyxTelephonyCost + deepgramCost + grokCost + ttsCost;
  const totalSavings = grokSavings;

  console.log("\n");
  console.log("╔══════════════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                        END OF CALL - COMPREHENSIVE COST SUMMARY                          ║");
  console.log("╠══════════════════════════════════════════════════════════════════════════════════════════╣");
  console.log(`║  Call ID: ...${callIdShort.padEnd(12)} │ Duration: ${callDurationStr.padEnd(10)} │ Ended: ${endTime.toISOString().slice(11, 19)} UTC       ║`);
  console.log("╠══════════════════════════════════════════════════════════════════════════════════════════╣");

  // COST BREAKDOWN TABLE
  console.log("║                                    COST BREAKDOWN                                        ║");
  console.log("╟──────────────────────────────────────────────────────────────────────────────────────────╢");
  console.log("║  Service             │   Cost ($)   │   Usage                  │  Rate                   ║");
  console.log("╟──────────────────────┼──────────────┼──────────────────────────┼─────────────────────────╢");

  const formatCostRow = (service: string, cost: number, usage: string, rate: string): string => {
    const costStr = `$${cost.toFixed(6)}`.padStart(12);
    return `║  ${service.padEnd(19)} │ ${costStr} │ ${usage.padEnd(24)} │ ${rate.padEnd(23)} ║`;
  };

  // 1. Fly.io Server
  console.log(formatCostRow(
    "Fly.io Server",
    flyioCost,
    `${callDurationSec.toFixed(1)}s compute`,
    `$${FLYIO_PRICING.sharedCpu1xWith1GbPerHour.toFixed(4)}/hr`
  ));

  // 2. Telnyx Telephony
  console.log(formatCostRow(
    "Telnyx Telephony",
    telnyxTelephonyCost,
    telnyxBilledSeconds > 0 ? `${telnyxBilledSeconds}s billed` : "N/A",
    "Per-minute billing"
  ));

  // 3. Deepgram STT
  console.log(formatCostRow(
    "Deepgram STT",
    deepgramCost,
    `${sttDurationSec.toFixed(1)}s audio`,
    `$${DEEPGRAM_PRICING.default.toFixed(4)}/min`
  ));

  // 4. Grok LLM
  console.log(formatCostRow(
    "Grok LLM (xAI)",
    grokCost,
    grokTokens > 0 ? `${grokTokens.toLocaleString()} tokens` : "No calls",
    grokCalls > 0 ? `${grokCalls} API calls` : "N/A"
  ));

  // 5. Telnyx TTS
  console.log(formatCostRow(
    "Telnyx TTS",
    ttsCost,
    ttsChars > 0 ? `${ttsChars.toLocaleString()} chars` : "No TTS",
    `$${TELNYX_TTS_PRICING.pricePerThousandChars}/1K chars`
  ));

  console.log("╟──────────────────────┼──────────────┼──────────────────────────┼─────────────────────────╢");

  // TOTALS ROW
  const totalStr = `$${totalCost.toFixed(6)}`.padStart(12);
  console.log(`║  TOTAL               │ ${totalStr} │                          │                         ║`);

  // SAVINGS (if any)
  if (totalSavings > 0) {
    const savingsStr = `$${totalSavings.toFixed(6)}`.padStart(12);
    console.log(`║  Cache Savings       │ ${savingsStr} │ From Grok prompt caching │                         ║`);
  }

  console.log("╠══════════════════════════════════════════════════════════════════════════════════════════╣");

  // PERCENTAGE BREAKDOWN
  console.log("║                                  COST DISTRIBUTION                                       ║");
  console.log("╟──────────────────────────────────────────────────────────────────────────────────────────╢");

  const calcPercent = (cost: number): string => {
    if (totalCost === 0) return "0.0%";
    return `${((cost / totalCost) * 100).toFixed(1)}%`;
  };

  const formatBarRow = (service: string, cost: number): string => {
    const percent = totalCost > 0 ? (cost / totalCost) * 100 : 0;
    const barLength = Math.round(percent / 2); // Max 50 chars for 100%
    const bar = "█".repeat(barLength) + "░".repeat(50 - barLength);
    return `║  ${service.padEnd(17)} ${calcPercent(cost).padStart(6)} ${bar}  ║`;
  };

  console.log(formatBarRow("Fly.io", flyioCost));
  console.log(formatBarRow("Telephony", telnyxTelephonyCost));
  console.log(formatBarRow("Deepgram STT", deepgramCost));
  console.log(formatBarRow("Grok LLM", grokCost));
  console.log(formatBarRow("Telnyx TTS", ttsCost));

  console.log("╠══════════════════════════════════════════════════════════════════════════════════════════╣");
  console.log("║                                    QUICK STATS                                           ║");
  console.log("╟──────────────────────────────────────────────────────────────────────────────────────────╢");

  // Cost per minute
  const costPerMin = callDurationSec > 0 ? (totalCost / (callDurationSec / 60)) : 0;
  console.log(`║  Cost per minute:     $${costPerMin.toFixed(4).padStart(10)}                                                      ║`);
  console.log(`║  Total call cost:     $${totalCost.toFixed(6).padStart(10)}                                                      ║`);
  if (totalSavings > 0) {
    const effectiveCost = totalCost - totalSavings;
    console.log(`║  Effective cost:      $${effectiveCost.toFixed(6).padStart(10)} (after cache savings)                              ║`);
  }

  console.log("╚══════════════════════════════════════════════════════════════════════════════════════════╝");
  console.log("\n");
}

export { defaultConfig as DEFAULT_CONFIG };
