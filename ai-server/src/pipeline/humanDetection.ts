/**
 * IVR vs Human Detection Module
 * ==============================
 * Implements a sophisticated state machine for detecting whether the receiver
 * of an outbound call is a human or an IVR/automated system.
 *
 * State Machine:
 * - UNKNOWN: Initial state at call start
 * - CHECKING: Actively analyzing receiver type
 * - LIKELY_IVR: High confidence receiver is automated system
 * - LIKELY_HUMAN: High confidence receiver is a human
 * - HOLD: Detected hold pattern (music/silence/tones)
 *
 * Detection Flow:
 * 1. Start of call: First classification after 0.5s non-speech
 * 2. Throughout call: Monitor for hold patterns and transfers
 * 3. After hold ends: Re-check receiver type
 */

import type { CallContext } from "../callContextManager";
import config from "../config";

/**
 * Receiver detection states
 */
export type ReceiverState = "UNKNOWN" | "CHECKING" | "LIKELY_IVR" | "LIKELY_HUMAN" | "HOLD";

/**
 * Result from LLM receiver classification
 */
export type ReceiverType = "human" | "ivr" | "unsure";

/**
 * Result of LLM classification request
 */
export interface ReceiverClassification {
  receiver: ReceiverType;
  confidence?: number;
  reason?: string;
}

/**
 * Hold detection indicators
 */
export interface HoldIndicators {
  hasMusic: boolean;
  hasTones: boolean;
  hasBeeps: boolean;
  hasSilence: boolean;
  hasHoldMessage: boolean;
}

/**
 * VAD (Voice Activity Detection) state
 */
export interface VadState {
  isSpeaking: boolean;
  lastSpeechAt: number;
  lastSilenceAt: number;
  silenceDurationMs: number;
  speechDurationMs: number;
}

/**
 * Extended call context fields for human detection
 * These should be added to CallContext interface
 */
export interface HumanDetectionState {
  /** Current receiver detection state */
  receiverState: ReceiverState;
  /** Transcript buffer for classification */
  transcriptBuffer: string[];
  /** Number of utterances collected since last check */
  utteranceCount: number;
  /** Timestamp of last receiver check */
  lastReceiverCheckAt?: number;
  /** Number of human turns confirmed after hold */
  humanTurnsAfterHold: number;
  /** VAD state tracking */
  vadState: VadState;
  /** Whether hold was just exited (needs fresh check) */
  justExitedHold: boolean;
  /** Timestamp when current state was entered */
  stateEnteredAt: number;
  /** Count of consecutive unsure classifications */
  unsureCount: number;
  /** Last classification result */
  lastClassification?: ReceiverClassification;
}

/**
 * Per-call human detection settings interface
 * Matches the fields in CallContext for per-call overrides
 */
export interface PerCallHumanDetectionSettings {
  humanDetectionEnabled?: boolean | null;
  humanDetectionUtteranceFlushMs?: number | null;
  humanDetectionHumanWaitMs?: number | null;
  humanDetectionIvrWaitMs?: number | null;
  humanDetectionMinUtterances?: number | null;
  humanDetectionHoldSilenceMs?: number | null;
  humanDetectionHumanTurnsAfterHold?: number | null;
  humanDetectionMaxUnsure?: number | null;
  humanDetectionClassificationPrompt?: string | null;
}

/**
 * Get human detection config with per-call overrides
 * @param perCallSettings - Optional per-call settings from CallContext
 * @returns Merged config with per-call overrides taking precedence
 */
export function getHumanDetectionConfig(perCallSettings?: PerCallHumanDetectionSettings | null) {
  return {
    /** Non-speech duration to trigger utterance flush (ms) */
    utteranceFlushMs: perCallSettings?.humanDetectionUtteranceFlushMs ?? config.humanDetection?.utteranceFlushMs ?? 500,
    /** Wait time for human receiver before responding (ms) */
    humanWaitMs: perCallSettings?.humanDetectionHumanWaitMs ?? config.humanDetection?.humanWaitMs ?? 1500,
    /** Wait time for IVR/unsure receiver before responding (ms) */
    ivrWaitMs: perCallSettings?.humanDetectionIvrWaitMs ?? config.humanDetection?.ivrWaitMs ?? 3000,
    /** Minimum utterances needed for initial classification */
    minUtterancesForCheck: perCallSettings?.humanDetectionMinUtterances ?? config.humanDetection?.minUtterancesForCheck ?? 1,
    /** Extended silence threshold for hold detection (ms) */
    holdSilenceThresholdMs: perCallSettings?.humanDetectionHoldSilenceMs ?? config.humanDetection?.holdSilenceThresholdMs ?? 5000,
    /** Human turns required after hold to confirm human */
    humanTurnsRequiredAfterHold: perCallSettings?.humanDetectionHumanTurnsAfterHold ?? config.humanDetection?.humanTurnsRequiredAfterHold ?? 1,
    /** Maximum unsure classifications before defaulting to IVR */
    maxUnsureBeforeIvr: perCallSettings?.humanDetectionMaxUnsure ?? config.humanDetection?.maxUnsureBeforeIvr ?? 3,
    /** Whether human detection is enabled */
    enabled: perCallSettings?.humanDetectionEnabled ?? config.humanDetection?.enabled ?? true,
    /** Custom classification prompt (null uses default) */
    classificationPrompt: perCallSettings?.humanDetectionClassificationPrompt ?? null,
  };
}

/**
 * Default timing configuration for human detection (for backwards compatibility)
 */
export const HUMAN_DETECTION_CONFIG = {
  /** Non-speech duration to trigger utterance flush (ms) */
  utteranceFlushMs: 500,
  /** Wait time for human receiver before responding (ms) */
  humanWaitMs: 1500,
  /** Wait time for IVR/unsure receiver before responding (ms) */
  ivrWaitMs: 3000,
  /** Minimum utterances needed for initial classification */
  minUtterancesForCheck: 1,
  /** Extended silence threshold for hold detection (ms) */
  holdSilenceThresholdMs: 5000,
  /** Human turns required after hold to confirm human */
  humanTurnsRequiredAfterHold: 1,
  /** Maximum unsure classifications before defaulting to IVR */
  maxUnsureBeforeIvr: 3,
};

/**
 * Hold sound patterns to detect
 */
const HOLD_PATTERNS = {
  /** Music indicator patterns */
  music: [
    /hold music/i,
    /♪|♫|🎵|🎶/,
    /\[music\]/i,
    /\[instrumental\]/i,
  ],
  /** Hold message patterns */
  holdMessage: [
    /please (hold|wait|stay on the line)/i,
    /your call is (important|being|in queue)/i,
    /all (of our )?(agents?|representatives?|operators?) are/i,
    /estimated wait time/i,
    /you are (caller )?(number|position)/i,
    /next available/i,
    /thank you for (waiting|holding|your patience)/i,
  ],
  /** Transfer/connecting patterns */
  transfer: [
    /transferring (you|your call)/i,
    /connecting (you|your call)/i,
    /please hold while/i,
    /one moment (please|while)/i,
  ],
};

/**
 * Patterns that strongly indicate IVR
 */
const IVR_PATTERNS = [
  /press (\d+|one|two|three|four|five|six|seven|eight|nine|zero|star|pound)/i,
  /for .+,? press/i,
  /dial (\d+|one|two)/i,
  /say (yes|no|agent|representative|operator)/i,
  /enter your/i,
  /invalid (entry|selection|input)/i,
  /main menu/i,
  /option (\d+|one|two|three)/i,
];

/**
 * Patterns that strongly indicate human
 */
const HUMAN_PATTERNS = [
  /how (can|may) i help/i,
  /what can i (do|help)/i,
  /(hi|hey|hello),? (this is|my name is|i'm|i am)/i,  // "hi this is", "hey this is", "hello this is"
  /this is \w+[,.]? how/i,  // "this is jenny, how can i help"
  /speaking/i,
  /let me (check|look|see|find)/i,
  /give me (a )?(moment|second|sec)/i,
  /sorry (about|for) (that|the wait)/i,
  /what('s| is) your name/i,
  /who am i speaking (with|to)/i,
  /can i (get|have) your/i,
  /ok,? (so|and|let me)/i,
  /um+|uh+|hmm+/i,
  /actually|basically|honestly/i,
  /good (morning|afternoon|evening)/i,
  /thanks for (calling|holding|waiting)/i,  // Human saying thanks, not IVR "thank you for calling"
];

/**
 * Initialize human detection state for a new call
 */
export function initializeHumanDetectionState(): HumanDetectionState {
  return {
    receiverState: "UNKNOWN",
    transcriptBuffer: [],
    utteranceCount: 0,
    humanTurnsAfterHold: 0,
    vadState: {
      isSpeaking: false,
      lastSpeechAt: 0,
      lastSilenceAt: Date.now(),
      silenceDurationMs: 0,
      speechDurationMs: 0,
    },
    justExitedHold: false,
    stateEnteredAt: Date.now(),
    unsureCount: 0,
  };
}

/**
 * Update VAD state based on speech/non-speech detection
 */
export function updateVadState(
  state: HumanDetectionState,
  isSpeaking: boolean
): void {
  const now = Date.now();
  const vadState = state.vadState;

  if (isSpeaking && !vadState.isSpeaking) {
    // Speech started
    vadState.isSpeaking = true;
    vadState.lastSpeechAt = now;
    vadState.silenceDurationMs = vadState.lastSilenceAt > 0
      ? now - vadState.lastSilenceAt
      : 0;
  } else if (!isSpeaking && vadState.isSpeaking) {
    // Speech ended
    vadState.isSpeaking = false;
    vadState.lastSilenceAt = now;
    vadState.speechDurationMs = vadState.lastSpeechAt > 0
      ? now - vadState.lastSpeechAt
      : 0;
  } else if (!isSpeaking) {
    // Ongoing silence - update duration
    vadState.silenceDurationMs = vadState.lastSilenceAt > 0
      ? now - vadState.lastSilenceAt
      : now - state.stateEnteredAt;
  }
}

/**
 * Check if utterance should be flushed based on non-speech duration
 */
export function shouldFlushUtterance(
  state: HumanDetectionState,
  customFlushMs?: number,
  perCallSettings?: PerCallHumanDetectionSettings | null
): boolean {
  const cfg = getHumanDetectionConfig(perCallSettings);
  const flushMs = customFlushMs ?? cfg.utteranceFlushMs;
  return !state.vadState.isSpeaking && state.vadState.silenceDurationMs >= flushMs;
}

/**
 * Add transcript to buffer for classification
 */
export function addToTranscriptBuffer(
  state: HumanDetectionState,
  transcript: string
): void {
  if (transcript && transcript.trim()) {
    state.transcriptBuffer.push(transcript.trim());
    state.utteranceCount++;
  }
}

/**
 * Get recent transcript for classification
 */
export function getRecentTranscript(
  state: HumanDetectionState,
  maxLength: number = 500
): string {
  const fullText = state.transcriptBuffer.join(" ");
  if (fullText.length <= maxLength) {
    return fullText;
  }
  // Return the most recent portion
  return fullText.slice(-maxLength);
}

/**
 * Clear transcript buffer (after classification)
 */
export function clearTranscriptBuffer(state: HumanDetectionState): void {
  state.transcriptBuffer = [];
}

/**
 * Check if we have enough data for classification
 */
export function canClassify(
  state: HumanDetectionState,
  perCallSettings?: PerCallHumanDetectionSettings | null
): boolean {
  const cfg = getHumanDetectionConfig(perCallSettings);
  const transcript = getRecentTranscript(state);
  // Only check utterance count - transcript length check removed
  return state.utteranceCount >= cfg.minUtterancesForCheck && transcript.length > 0;
}

/**
 * Quick pattern-based pre-check before LLM classification
 * Returns a strong signal if patterns are very clear, null otherwise
 */
export function quickPatternCheck(transcript: string): ReceiverType | null {
  const text = transcript.toLowerCase();

  // Count IVR pattern matches
  let ivrMatches = 0;
  for (const pattern of IVR_PATTERNS) {
    if (pattern.test(text)) {
      ivrMatches++;
    }
  }

  // Count human pattern matches
  let humanMatches = 0;
  for (const pattern of HUMAN_PATTERNS) {
    if (pattern.test(text)) {
      humanMatches++;
    }
  }

  // Strong IVR signal (2+ IVR patterns, no human patterns)
  if (ivrMatches >= 2 && humanMatches === 0) {
    return "ivr";
  }

  // Strong human signal (2+ human patterns, no IVR patterns)
  if (humanMatches >= 2 && ivrMatches === 0) {
    return "human";
  }

  // No strong signal - needs LLM classification
  return null;
}

/**
 * Detect hold indicators in transcript
 */
export function detectHoldIndicators(transcript: string): HoldIndicators {
  const text = transcript.toLowerCase();

  let hasMusic = false;
  for (const pattern of HOLD_PATTERNS.music) {
    if (pattern.test(text)) {
      hasMusic = true;
      break;
    }
  }

  let hasHoldMessage = false;
  for (const pattern of HOLD_PATTERNS.holdMessage) {
    if (pattern.test(text)) {
      hasHoldMessage = true;
      break;
    }
  }

  return {
    hasMusic,
    hasTones: false, // Would need audio analysis
    hasBeeps: false, // Would need audio analysis
    hasSilence: false, // Checked separately via VAD
    hasHoldMessage,
  };
}

/**
 * Check if we're likely on hold based on indicators
 */
export function isLikelyOnHold(
  state: HumanDetectionState,
  transcript?: string,
  perCallSettings?: PerCallHumanDetectionSettings | null
): boolean {
  const cfg = getHumanDetectionConfig(perCallSettings);
  // Extended silence is a hold indicator
  const extendedSilence = state.vadState.silenceDurationMs >= cfg.holdSilenceThresholdMs;

  // Check transcript for hold patterns
  if (transcript) {
    const indicators = detectHoldIndicators(transcript);
    if (indicators.hasHoldMessage || indicators.hasMusic) {
      return true;
    }
  }

  return extendedSilence;
}

/**
 * Transition to a new receiver state
 */
export function transitionState(
  state: HumanDetectionState,
  newState: ReceiverState,
  reason?: string
): void {
  const oldState = state.receiverState;
  if (oldState !== newState) {
    state.receiverState = newState;
    state.stateEnteredAt = Date.now();
    console.log(`[HUMAN-DETECT] State transition: ${oldState} -> ${newState}${reason ? ` (${reason})` : ""}`);

    // Reset counters on major transitions
    if (newState === "CHECKING") {
      state.unsureCount = 0;
    }
    if (newState === "HOLD") {
      state.humanTurnsAfterHold = 0;
    }
  }
}

/**
 * Process classification result and update state
 */
export function processClassification(
  state: HumanDetectionState,
  classification: ReceiverClassification,
  perCallSettings?: PerCallHumanDetectionSettings | null
): void {
  const cfg = getHumanDetectionConfig(perCallSettings);
  state.lastClassification = classification;
  state.lastReceiverCheckAt = Date.now();

  switch (classification.receiver) {
    case "human":
      if (state.justExitedHold) {
        // After hold, need to confirm with human turns
        state.humanTurnsAfterHold++;
        if (state.humanTurnsAfterHold >= cfg.humanTurnsRequiredAfterHold) {
          transitionState(state, "LIKELY_HUMAN", "confirmed after hold");
          state.justExitedHold = false;
        } else {
          transitionState(state, "CHECKING", "waiting for more human turns after hold");
        }
      } else {
        transitionState(state, "LIKELY_HUMAN", "LLM classification");
      }
      state.unsureCount = 0;
      break;

    case "ivr":
      transitionState(state, "LIKELY_IVR", "LLM classification");
      state.unsureCount = 0;
      state.justExitedHold = false;
      break;

    case "unsure":
      state.unsureCount++;
      if (state.unsureCount >= cfg.maxUnsureBeforeIvr) {
        // Too many unsure results - default to IVR behavior (safer, longer waits)
        transitionState(state, "LIKELY_IVR", `${state.unsureCount} consecutive unsure classifications`);
      } else {
        transitionState(state, "CHECKING", "unsure, collecting more data");
      }
      break;
  }
}

/**
 * Handle hold entry
 */
export function enterHold(state: HumanDetectionState, reason?: string): void {
  transitionState(state, "HOLD", reason || "hold detected");
  // Clear transcript buffer - hold transcripts shouldn't count for classification
  clearTranscriptBuffer(state);
}

/**
 * Handle hold exit
 */
export function exitHold(state: HumanDetectionState): void {
  state.justExitedHold = true;
  state.humanTurnsAfterHold = 0;
  transitionState(state, "CHECKING", "hold ended, re-checking receiver");
  // Clear transcript buffer - start fresh after hold
  clearTranscriptBuffer(state);
}

/**
 * Get appropriate wait time based on current state
 */
export function getWaitTimeMs(
  state: HumanDetectionState,
  perCallSettings?: PerCallHumanDetectionSettings | null
): number {
  const cfg = getHumanDetectionConfig(perCallSettings);
  switch (state.receiverState) {
    case "LIKELY_HUMAN":
      return cfg.humanWaitMs;
    case "LIKELY_IVR":
    case "CHECKING":
    case "UNKNOWN":
    case "HOLD":
    default:
      return cfg.ivrWaitMs;
  }
}

/**
 * Check if we should respond (not talk) based on current state
 */
export function shouldStaySilent(state: HumanDetectionState): boolean {
  // Don't talk while on hold
  if (state.receiverState === "HOLD") {
    return true;
  }
  // Don't talk if we're in the middle of checking (wait for classification)
  if (state.receiverState === "CHECKING" && !canClassify(state)) {
    return true;
  }
  return false;
}

/**
 * Default classification prompt template
 * Uses {{TRANSCRIPT}} as placeholder for the actual transcript
 */
export const DEFAULT_CLASSIFICATION_PROMPT = `Analyze this phone call transcript to determine if the speaker is a human or an IVR/automated system.

TRANSCRIPT:
"{{TRANSCRIPT}}"

CLASSIFICATION CRITERIA:

IVR/Automated System indicators:
- Menu prompts: "Press 1 for...", "For sales, press...", "Dial 2"
- Scripted greetings: "Thank you for calling...", "Your call is important"
- Hold messages: "Please hold", "Your estimated wait time", "All agents are busy"
- Input requests: "Enter your account number", "followed by pound"
- Error responses: "Invalid entry", "I didn't understand that"
- Robotic/scripted speech with no natural variation

Human indicators:
- Natural conversational patterns with filler words (um, uh, like, actually)
- Personal introductions: "Hi, this is John", "How can I help you?"
- Responsive questions about the caller
- Natural speech variations and pauses
- Informal language and varied sentence structure
- Emotional responses or empathy

Respond with ONLY valid JSON in this exact format:
{"receiver": "human" | "ivr" | "unsure", "confidence": 0.0-1.0, "reason": "brief explanation"}

Examples:
{"receiver": "ivr", "confidence": 0.95, "reason": "menu prompt with press options"}
{"receiver": "human", "confidence": 0.85, "reason": "natural greeting with personal introduction"}
{"receiver": "unsure", "confidence": 0.5, "reason": "too short to determine"}`;

/**
 * Build the LLM prompt for receiver classification
 * Returns a prompt that asks for JSON response: { receiver: human | ivr | unsure }
 * @param transcript - The transcript to classify
 * @param customPrompt - Optional custom prompt template (uses {{TRANSCRIPT}} placeholder)
 */
export function buildClassificationPrompt(transcript: string, customPrompt?: string | null): string {
  const template = customPrompt || DEFAULT_CLASSIFICATION_PROMPT;
  return template.replace(/\{\{TRANSCRIPT\}\}/g, transcript);
}

/**
 * Parse LLM classification response
 */
export function parseClassificationResponse(response: string): ReceiverClassification {
  try {
    // Try to extract JSON from response
    const jsonMatch = response.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.receiver && ["human", "ivr", "unsure"].includes(parsed.receiver)) {
        return {
          receiver: parsed.receiver as ReceiverType,
          confidence: parsed.confidence,
          reason: parsed.reason,
        };
      }
    }
  } catch (e) {
    // Parsing failed, try simpler extraction
    const lowerResponse = response.toLowerCase();
    if (lowerResponse.includes('"receiver"') || lowerResponse.includes("'receiver'")) {
      if (lowerResponse.includes('"human"') || lowerResponse.includes("'human'")) {
        return { receiver: "human", reason: "extracted from response" };
      }
      if (lowerResponse.includes('"ivr"') || lowerResponse.includes("'ivr'")) {
        return { receiver: "ivr", reason: "extracted from response" };
      }
    }
  }

  // Default to unsure if we can't parse
  return { receiver: "unsure", reason: "failed to parse LLM response" };
}

/**
 * Log human detection state for debugging
 */
export function logState(state: HumanDetectionState, prefix: string = ""): void {
  const vadInfo = state.vadState.isSpeaking
    ? `speaking for ${Date.now() - state.vadState.lastSpeechAt}ms`
    : `silent for ${state.vadState.silenceDurationMs}ms`;

  console.log(`[HUMAN-DETECT]${prefix ? ` ${prefix}:` : ""} state=${state.receiverState}, ` +
    `utterances=${state.utteranceCount}, vad=${vadInfo}, ` +
    `unsureCount=${state.unsureCount}` +
    (state.justExitedHold ? `, humanTurnsAfterHold=${state.humanTurnsAfterHold}` : ""));
}
