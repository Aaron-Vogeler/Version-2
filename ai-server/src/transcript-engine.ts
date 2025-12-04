/**
 * Transcript Engine for Phone Calls
 *
 * Transforms Deepgram STT output into human-only transcripts.
 *
 * Key principles:
 * 1. NEVER invent words - only use text from Deepgram
 * 2. Filter out AI/assistant speech - only include human speakers
 * 3. Support "live" mode (fast, append-only) and "final" mode (polished)
 */

import type {
  TranscriptEngineInput,
  TranscriptEngineOutput,
  TranscriptEngineLiveOutput,
  TranscriptEngineFinalOutput,
  TranscriptSegment,
  SpeakerUtterance,
} from "./types/transcript";
import { isHumanSpeaker } from "./types/transcript";

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

/**
 * Process transcript segments and return human-only transcript
 * @param input - The transcript engine input payload
 * @returns The processed transcript output (live or final format)
 */
export function processTranscript(
  input: TranscriptEngineInput
): TranscriptEngineOutput {
  // Validate input
  if (!input.call_id) {
    throw new Error("call_id is required");
  }
  if (!Array.isArray(input.segments)) {
    throw new Error("segments must be an array");
  }

  // Route to appropriate handler based on mode
  if (input.mode === "live") {
    return processLiveTranscript(input);
  } else if (input.mode === "final") {
    return processFinalTranscript(input);
  } else {
    throw new Error(`Invalid mode: ${input.mode}. Must be "live" or "final".`);
  }
}

// =============================================================================
// LIVE MODE PROCESSING
// =============================================================================

/**
 * Process transcript for live/real-time mode
 * Prioritizes SPEED over polish
 *
 * @param input - The transcript engine input
 * @returns Live mode output with appended human speech
 */
function processLiveTranscript(
  input: TranscriptEngineInput
): TranscriptEngineLiveOutput {
  // Filter to human-only segments
  const humanSegments = input.segments.filter((seg) =>
    isHumanSpeaker(seg.speaker_type, seg.direction)
  );

  // If no human segments, return existing transcript or empty
  if (humanSegments.length === 0) {
    return {
      mode: "live",
      call_id: input.call_id,
      transcript_text: input.existing_transcript_text || "",
    };
  }

  // Extract text from human segments (minimal processing)
  const newHumanText = humanSegments
    .map((seg) => seg.text.trim())
    .filter((text) => text.length > 0)
    .join(" ");

  // Combine with existing transcript
  let fullTranscript: string;
  if (input.existing_transcript_text && input.existing_transcript_text.trim()) {
    // Add space between existing and new text
    fullTranscript = `${input.existing_transcript_text.trim()} ${newHumanText}`;
  } else {
    fullTranscript = newHumanText;
  }

  // Minimal punctuation cleanup (don't change words)
  fullTranscript = minimalPunctuationCleanup(fullTranscript);

  return {
    mode: "live",
    call_id: input.call_id,
    transcript_text: fullTranscript,
  };
}

// =============================================================================
// FINAL MODE PROCESSING
// =============================================================================

/**
 * Process transcript for final/post-call mode
 * Prioritizes ACCURACY + READABILITY
 *
 * @param input - The transcript engine input
 * @returns Final mode output with polished transcript and speaker breakdown
 */
function processFinalTranscript(
  input: TranscriptEngineInput
): TranscriptEngineFinalOutput {
  // Filter to human-only segments
  const humanSegments = input.segments.filter((seg) =>
    isHumanSpeaker(seg.speaker_type, seg.direction)
  );

  // If no human segments, return empty output
  if (humanSegments.length === 0) {
    return {
      mode: "final",
      call_id: input.call_id,
      transcript_text: "",
      by_speaker: [],
    };
  }

  // Group consecutive segments by speaker
  const utterances = groupBySpeaker(humanSegments);

  // Build readable transcript text
  const transcriptText = buildReadableTranscript(utterances);

  return {
    mode: "final",
    call_id: input.call_id,
    transcript_text: transcriptText,
    by_speaker: utterances,
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Group consecutive segments by the same speaker into utterances
 */
function groupBySpeaker(segments: TranscriptSegment[]): SpeakerUtterance[] {
  if (segments.length === 0) return [];

  const utterances: SpeakerUtterance[] = [];
  let currentSpeaker = deriveSpeakerLabel(segments[0]);
  let currentTexts: string[] = [];
  let currentStartMs: number | null = segments[0].start_ms;
  let currentEndMs: number | null = segments[0].end_ms;

  for (const seg of segments) {
    const speakerLabel = deriveSpeakerLabel(seg);

    if (speakerLabel === currentSpeaker) {
      // Same speaker - accumulate
      currentTexts.push(seg.text.trim());
      // Update end time
      if (seg.end_ms !== null) {
        currentEndMs = seg.end_ms;
      }
    } else {
      // Different speaker - flush current utterance
      if (currentTexts.length > 0) {
        utterances.push({
          speaker_label: currentSpeaker,
          utterance_text: formatUtteranceText(currentTexts),
          start_ms: currentStartMs,
          end_ms: currentEndMs,
        });
      }

      // Start new utterance
      currentSpeaker = speakerLabel;
      currentTexts = [seg.text.trim()];
      currentStartMs = seg.start_ms;
      currentEndMs = seg.end_ms;
    }
  }

  // Don't forget the last utterance
  if (currentTexts.length > 0) {
    utterances.push({
      speaker_label: currentSpeaker,
      utterance_text: formatUtteranceText(currentTexts),
      start_ms: currentStartMs,
      end_ms: currentEndMs,
    });
  }

  return utterances;
}

/**
 * Derive a human-readable speaker label from segment metadata
 */
function deriveSpeakerLabel(seg: TranscriptSegment): string {
  // Use speaker_type if it's a specific human type
  if (seg.speaker_type === "human") {
    // If direction is inbound, it's the caller
    if (seg.direction === "inbound") {
      return "Caller";
    }
    // Generic human
    return "Speaker";
  }

  // Check for specific speaker type strings
  const speakerType = seg.speaker_type as string;
  if (["caller", "customer"].includes(speakerType)) {
    return "Caller";
  }
  if (["rep", "agent"].includes(speakerType) && seg.direction === "inbound") {
    return "Rep";
  }

  // Fall back to direction-based labeling
  if (seg.direction === "inbound") {
    return "Caller";
  }

  // Default
  return "Speaker";
}

/**
 * Format utterance text with proper capitalization and punctuation
 * Does NOT add words, only fixes formatting
 */
function formatUtteranceText(texts: string[]): string {
  // Join all text fragments
  let combined = texts.filter((t) => t.length > 0).join(" ");

  // Apply formatting (no word changes)
  combined = fixCapitalization(combined);
  combined = fixPunctuation(combined);

  return combined;
}

/**
 * Build a readable paragraph-based transcript from utterances
 */
function buildReadableTranscript(utterances: SpeakerUtterance[]): string {
  if (utterances.length === 0) return "";

  // Each utterance becomes a paragraph
  return utterances
    .map((u) => u.utterance_text)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/**
 * Minimal punctuation cleanup for live mode (speed priority)
 * Only basic fixes, no changes to words
 */
function minimalPunctuationCleanup(text: string): string {
  // Remove duplicate spaces
  text = text.replace(/\s+/g, " ");

  // Ensure first letter is capitalized
  if (text.length > 0) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }

  return text.trim();
}

/**
 * Fix capitalization (first letter of sentences)
 * Does NOT change any words
 */
function fixCapitalization(text: string): string {
  if (text.length === 0) return text;

  // Capitalize first character
  let result = text.charAt(0).toUpperCase() + text.slice(1);

  // Capitalize after sentence-ending punctuation
  result = result.replace(/([.!?]\s+)([a-z])/g, (_, punct, letter) => {
    return punct + letter.toUpperCase();
  });

  // Capitalize "I" when standalone
  result = result.replace(/\bi\b/g, "I");

  return result;
}

/**
 * Fix punctuation (add periods at end, clean up spacing)
 * Does NOT add or change words
 */
function fixPunctuation(text: string): string {
  if (text.length === 0) return text;

  // Remove duplicate spaces
  text = text.replace(/\s+/g, " ");

  // Remove spaces before punctuation
  text = text.replace(/\s+([.,!?;:])/g, "$1");

  // Ensure space after punctuation (except at end)
  text = text.replace(/([.,!?;:])([^\s\d])/g, "$1 $2");

  // Add period at end if no sentence-ending punctuation
  const lastChar = text.charAt(text.length - 1);
  if (!["."].includes(lastChar) && !/[.!?]$/.test(text.trim())) {
    text = text.trim() + ".";
  }

  return text.trim();
}

// =============================================================================
// EXPORTS
// =============================================================================

export type {
  TranscriptEngineInput,
  TranscriptEngineOutput,
  TranscriptEngineLiveOutput,
  TranscriptEngineFinalOutput,
  TranscriptSegment,
  SpeakerUtterance,
};
