/**
 * Call-Level Context Management
 * =============================
 * Maintains within-call memory only: rolling summary + sliding window of recent turns.
 * Each call is scoped to a single Telnyx call ID and cleared on call end.
 * No cross-call memory is persisted.
 */
import config from "./config";
import type { HumanDetectionState, ReceiverState } from "./pipeline/humanDetection";
import { initializeHumanDetectionState } from "./pipeline/humanDetection";

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
  model?: string; // Model to use for this call (overrides config default)
  temperature?: number; // Temperature for LLM calls (overrides default)
  maxTokens?: number; // Max tokens for LLM calls (overrides default)
  topP?: number; // Top P for LLM calls (overrides default)
  reasoning?: 'low' | 'medium' | 'high'; // Reasoning effort for LLM calls
  stream?: boolean; // Enable streaming for LLM calls
  jsonMode?: boolean; // Enable JSON mode for LLM calls
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
    });
  }
  return callContextStore.get(callId)!;
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
    // Clean up timers
    if (context.ttsDebounceTimer) {
      clearTimeout(context.ttsDebounceTimer);
    }
    // Clean up hold check-in timer
    if (context.holdCheckInTimer) {
      clearTimeout(context.holdCheckInTimer);
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

export { defaultConfig as DEFAULT_CONFIG };
