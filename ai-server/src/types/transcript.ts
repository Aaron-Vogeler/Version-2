/**
 * Transcript Engine Types
 * Defines input/output formats for the transcript engine
 */

// =============================================================================
// INPUT TYPES
// =============================================================================

/**
 * Speaker type classification
 * - "human": caller, customer, rep, or any human speaker
 * - "assistant": AI assistant, bot, or automated voice
 * - "unknown": speaker type could not be determined
 */
export type SpeakerType = "human" | "assistant" | "unknown";

/**
 * Audio track direction
 * - "inbound": audio coming from the caller (typically human)
 * - "outbound": audio going to the caller (typically AI/TTS)
 * - null: direction unknown
 */
export type TrackDirection = "inbound" | "outbound" | null;

/**
 * A single transcript segment from Deepgram STT
 */
export interface TranscriptSegment {
  /** Unique identifier for this segment */
  id: string;
  /** The recognized text from Deepgram */
  text: string;
  /** Speaker classification */
  speaker_type: SpeakerType;
  /** Audio track direction */
  direction: TrackDirection;
  /** Start timestamp in milliseconds (from call start) */
  start_ms: number | null;
  /** End timestamp in milliseconds (from call start) */
  end_ms: number | null;
  /** Whether this is a final transcript (is_final=true from Deepgram) */
  is_final?: boolean;
  /** Whether this marks end of speech (speech_final from Deepgram) */
  speech_final?: boolean;
  /** Deepgram confidence score (0-1) */
  confidence?: number;
}

/**
 * Input payload for the transcript engine
 */
export interface TranscriptEngineInput {
  /** Processing mode: "live" for real-time, "final" for post-call */
  mode: "live" | "final";
  /** Unique call identifier (typically Telnyx call_control_id) */
  call_id: string;
  /** Array of transcript segments to process */
  segments: TranscriptSegment[];
  /** Existing transcript text to append to (for live mode) */
  existing_transcript_text?: string;
}

// =============================================================================
// OUTPUT TYPES
// =============================================================================

/**
 * Speaker utterance with metadata (for final mode)
 */
export interface SpeakerUtterance {
  /** Human-readable speaker label (e.g., "Caller", "Rep 1") */
  speaker_label: string;
  /** The speaker's words in order */
  utterance_text: string;
  /** Earliest start_ms for this utterance (or null) */
  start_ms: number | null;
  /** Latest end_ms for this utterance (or null) */
  end_ms: number | null;
}

/**
 * Output for live mode
 */
export interface TranscriptEngineLiveOutput {
  mode: "live";
  call_id: string;
  /** Full human-only transcript so far as a single string */
  transcript_text: string;
}

/**
 * Output for final mode
 */
export interface TranscriptEngineFinalOutput {
  mode: "final";
  call_id: string;
  /** Full human-only transcript, readable paragraphs */
  transcript_text: string;
  /** Utterances grouped by speaker */
  by_speaker: SpeakerUtterance[];
}

/**
 * Union type for transcript engine output
 */
export type TranscriptEngineOutput =
  | TranscriptEngineLiveOutput
  | TranscriptEngineFinalOutput;

// =============================================================================
// HELPER TYPE GUARDS
// =============================================================================

/**
 * Check if a speaker_type represents a human speaker
 */
export function isHumanSpeaker(
  speakerType: SpeakerType | string | undefined,
  direction: TrackDirection | string | undefined
): boolean {
  // Explicit human speaker types
  if (speakerType === "human") return true;
  if (["caller", "customer", "rep", "agent"].includes(speakerType || "")) {
    // "agent" could be human rep or AI - check direction
    if (direction === "inbound") return true;
    // If direction is outbound and speaker is "agent", it could be AI
    return false;
  }

  // Explicit assistant/AI speaker types - NOT human
  if (speakerType === "assistant") return false;
  if (["ai", "bot", "tts"].includes(speakerType || "")) return false;

  // Fall back to direction-based classification
  // Inbound audio is from the caller (human)
  if (direction === "inbound") return true;
  // Outbound audio is typically AI/TTS
  if (direction === "outbound") return false;

  // If we can't determine, err on the side of excluding (false)
  return false;
}

/**
 * Check if the output is live mode
 */
export function isLiveOutput(
  output: TranscriptEngineOutput
): output is TranscriptEngineLiveOutput {
  return output.mode === "live";
}

/**
 * Check if the output is final mode
 */
export function isFinalOutput(
  output: TranscriptEngineOutput
): output is TranscriptEngineFinalOutput {
  return output.mode === "final";
}
