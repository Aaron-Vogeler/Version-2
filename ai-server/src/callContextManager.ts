/**
 * Call-Level Context Management
 * =============================
 * Maintains within-call memory only: rolling summary + sliding window of recent turns.
 * Each call is scoped to a single Telnyx call ID and cleared on call end.
 * No cross-call memory is persisted.
 */

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
  shouldHangupAfterSpeak?: boolean; // Flag to hang up after TTS finishes speaking
}

/**
 * Configuration for context management
 */
export interface ContextConfig {
  maxTurnsInWindow: number; // Max recent turns to keep (e.g., 12)
  summaryUpdateIntervalTurns: number; // Update summary after this many new turns (e.g., 6)
  maxSummaryTokensHint: number; // Approximate max tokens for summary (e.g., 300)
}

// Default configuration
const defaultConfig: ContextConfig = {
  maxTurnsInWindow: 12,
  summaryUpdateIntervalTurns: 6,
  maxSummaryTokensHint: 300,
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
    });
  }
  return callContextStore.get(callId)!;
}

/**
 * Append a new turn to the CallContext.
 * Automatically trims old turns if the window exceeds maxTurnsInWindow.
 */
export function appendTurn(
  callId: string,
  turn: Turn,
  config: ContextConfig = defaultConfig
): void {
  const context = getOrCreateContext(callId, config);

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
 */
export function formatTurnsForSummary(turns: Turn[]): string {
  if (turns.length === 0) {
    return "(no new turns)";
  }
  return turns
    .map((turn) => {
      const speaker = turn.speaker.toUpperCase();
      return `[${turn.timestamp}] ${speaker}: ${turn.text}`;
    })
    .join("\n");
}

/**
 * Format recent turns as a message history for the LLM prompt.
 * Maps speakers to chat roles (caller/ivr -> user, assistant -> assistant).
 */
export function formatTurnsAsMessages(
  turns: Turn[]
): Array<{ role: "user" | "assistant"; content: string }> {
  return turns.map((turn) => {
    const role =
      turn.speaker === "assistant" ? "assistant" : ("user" as const);
    // Include speaker label for clarity when multiple parties are involved
    const speakerLabel =
      turn.speaker === "assistant"
        ? ""
        : `[${turn.speaker.toUpperCase()}] `;
    return {
      role,
      content: `${speakerLabel}${turn.text}`,
    };
  });
}

export { defaultConfig as DEFAULT_CONFIG };
