/**
 * Supabase client utilities for AI Server call logging
 * Mirrors the functionality previously in Cloudflare Workers
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import config from "../config";

// Singleton Supabase client
let supabaseClient: SupabaseClient | null = null;

/**
 * Check if Supabase is configured
 */
export function isSupabaseConfigured(): boolean {
  return !!(config.supabase.url && config.supabase.serviceRoleKey);
}

/**
 * Get or create Supabase client (singleton)
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) {
    return null;
  }

  if (!supabaseClient) {
    supabaseClient = createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );
  }

  return supabaseClient;
}

/**
 * Call record interface matching Supabase schema
 */
export interface CallRecord {
  id: string; // call_control_id
  user_id: string;
  tenant_id?: string;
  direction: "inbound" | "outbound";
  from_e164: string;
  to_e164: string;
  status: string;
  goal?: string;
  live_transcript?: string;
  transcript_status?: string;
  recording_url?: string;
  started_at?: string;
  answered_at?: string;
  ended_at?: string;
  duration_sec?: number;
  cost_usd?: number;
  metadata?: Record<string, any>;
  created_at?: string;
  updated_at?: string;
}

/**
 * Call event record interface
 */
export interface CallEventRecord {
  id: string;
  call_id: string;
  event_type: string;
  occurred_at: string;
  payload?: Record<string, any>;
}

/**
 * Transcript speaker type: 'caller' or 'assistant'
 */
export type TranscriptSpeaker = "caller" | "assistant";

/**
 * Transcript track type: 'inbound' (caller) or 'outbound' (assistant)
 */
export type TranscriptTrack = "inbound" | "outbound";

/**
 * Transcript segment record for insert-only logging
 */
export interface TranscriptSegment {
  call_id: string;
  speaker: TranscriptSpeaker;
  track: TranscriptTrack;
  text: string;
  confidence?: number;
  created_at?: string;
}

/**
 * Upsert a call record (create or update)
 */
export async function upsertCall(
  call: Partial<CallRecord> & { id: string }
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.log("[Supabase] Not configured, skipping call upsert");
    return { success: true };
  }

  try {
    // Fetch existing call if it exists
    const { data: existing } = await supabase
      .from("calls")
      .select("*")
      .eq("id", call.id)
      .single();

    // Merge with existing data, preserving important fields
    const merged = existing
      ? {
          ...existing,
          ...call,
          // Don't overwrite timestamps with null values
          started_at: call.started_at || existing.started_at,
          answered_at: call.answered_at || existing.answered_at,
          ended_at: call.ended_at || existing.ended_at,
          updated_at: new Date().toISOString(),
        }
      : {
          ...call,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

    const { error } = await supabase
      .from("calls")
      .upsert(merged, { onConflict: "id" });

    if (error) {
      console.error("[Supabase] Error upserting call:", error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    console.error("[Supabase] Exception upserting call:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Update specific fields on a call record
 */
export async function updateCall(
  callId: string,
  fields: Partial<CallRecord>
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.log("[Supabase] Not configured, skipping call update");
    return { success: true };
  }

  try {
    const { error } = await supabase
      .from("calls")
      .update({
        ...fields,
        updated_at: new Date().toISOString(),
      })
      .eq("id", callId);

    if (error) {
      console.error("[Supabase] Error updating call:", error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    console.error("[Supabase] Exception updating call:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Upsert a call event (idempotent)
 */
export async function upsertCallEvent(
  event: CallEventRecord
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.log("[Supabase] Not configured, skipping event upsert");
    return { success: true };
  }

  try {
    const { error } = await supabase
      .from("call_events")
      .upsert(event, { onConflict: "id", ignoreDuplicates: true });

    if (error) {
      console.error("[Supabase] Error upserting call event:", error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    console.error("[Supabase] Exception upserting call event:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Append transcript text with speaker identification
 * Mirrors the Cloudflare worker appendTranscript functionality
 * @deprecated Use insertTranscriptSegment instead for robust, insert-only logging
 */
export async function appendTranscript(
  callId: string,
  newChunk: string,
  status: string,
  speakerName: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: true };
  }

  try {
    // Fetch existing transcript
    const { data: existing } = await supabase
      .from("calls")
      .select("live_transcript")
      .eq("id", callId)
      .single();

    const existingTranscript = existing?.live_transcript || "";

    // Format: Speaker Name (newline) Text
    const formattedBlock = `${speakerName}\n${newChunk}`;

    // Add double newline for clean separation
    const updatedTranscript = existingTranscript
      ? `${existingTranscript}\n\n${formattedBlock}`
      : formattedBlock;

    const { error } = await supabase
      .from("calls")
      .update({
        live_transcript: updatedTranscript,
        transcript_status: status,
        updated_at: new Date().toISOString(),
      })
      .eq("id", callId);

    if (error) {
      console.error("[Supabase] Error appending transcript:", error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    console.error("[Supabase] Exception appending transcript:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Insert a transcript segment (insert-only, no reads)
 * Robust logging for only final/confirmed speech from caller or assistant
 * @param segment - The transcript segment to insert
 * @returns Success/error result
 */
export async function insertTranscriptSegment(
  segment: TranscriptSegment
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.log("[Supabase] Not configured, skipping transcript segment insert");
    return { success: true };
  }

  // Validate required fields
  if (!segment.call_id || !segment.text || !segment.speaker || !segment.track) {
    return {
      success: false,
      error: "Missing required fields: call_id, text, speaker, track",
    };
  }

  // Skip empty text
  const trimmedText = segment.text.trim();
  if (trimmedText.length === 0) {
    return { success: true };
  }

  // Safety: Cap text length to prevent runaway inserts (e.g., 2000 chars per segment)
  const MAX_TEXT_LENGTH = 2000;
  const cappedText = trimmedText.length > MAX_TEXT_LENGTH
    ? trimmedText.substring(0, MAX_TEXT_LENGTH)
    : trimmedText;

  try {
    const insertRecord = {
      call_id: segment.call_id,
      speaker: segment.speaker,
      track: segment.track,
      text: cappedText,
      confidence: segment.confidence,
      created_at: segment.created_at || new Date().toISOString(),
    };

    const { error } = await supabase
      .from("call_transcript_segments")
      .insert(insertRecord);

    if (error) {
      console.error("[Supabase] Error inserting transcript segment:", error.message);
      return { success: false, error: error.message };
    }

    // Debug-level logging: show speaker, text length, call_id suffix for tracing
    const callIdSuffix = segment.call_id.substring(Math.max(0, segment.call_id.length - 8));
    console.log(
      `[Supabase] Transcript segment inserted (${segment.speaker}/${segment.track}, ${cappedText.length} chars, call: ...${callIdSuffix})`
    );
    return { success: true };
  } catch (error) {
    console.error("[Supabase] Exception inserting transcript segment:", error instanceof Error ? error.message : error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Update the live_transcript field for real-time browser display
 * This is the human-only transcript text that the frontend subscribes to
 * @param callId - The call ID (call_control_id)
 * @param transcriptText - The full human-only transcript text
 * @returns Success/error result
 */
export async function updateLiveTranscript(
  callId: string,
  transcriptText: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.log("[Supabase] Not configured, skipping live transcript update");
    return { success: true };
  }

  if (!callId) {
    return { success: false, error: "callId is required" };
  }

  try {
    const { error } = await supabase
      .from("calls")
      .update({
        live_transcript: transcriptText,
        transcript_status: "processing",
        updated_at: new Date().toISOString(),
      })
      .eq("id", callId);

    if (error) {
      console.error("[Supabase] Error updating live transcript:", error.message);
      return { success: false, error: error.message };
    }

    // Debug logging (truncated for long transcripts)
    const displayText = transcriptText.length > 100
      ? `${transcriptText.substring(0, 100)}...`
      : transcriptText;
    console.log(`[Supabase] Live transcript updated (${transcriptText.length} chars): "${displayText}"`);

    return { success: true };
  } catch (error) {
    console.error("[Supabase] Exception updating live transcript:", error instanceof Error ? error.message : error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Finalize the transcript when the call ends
 * Copies live_transcript to final transcript field and marks status as completed
 * @param callId - The call ID (call_control_id)
 * @param finalTranscriptText - Optional final processed transcript (if not provided, uses live_transcript)
 * @returns Success/error result
 */
export async function finalizeTranscript(
  callId: string,
  finalTranscriptText?: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.log("[Supabase] Not configured, skipping transcript finalization");
    return { success: true };
  }

  if (!callId) {
    return { success: false, error: "callId is required" };
  }

  try {
    // If no final text provided, fetch the current live_transcript
    let transcript = finalTranscriptText;
    if (!transcript) {
      const { data } = await supabase
        .from("calls")
        .select("live_transcript")
        .eq("id", callId)
        .single();
      transcript = data?.live_transcript || "";
    }

    const { error } = await supabase
      .from("calls")
      .update({
        transcript: transcript,
        transcript_status: "completed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", callId);

    if (error) {
      console.error("[Supabase] Error finalizing transcript:", error.message);
      return { success: false, error: error.message };
    }

    console.log(`[Supabase] Transcript finalized for call ${callId.substring(callId.length - 8)}`);
    return { success: true };
  } catch (error) {
    console.error("[Supabase] Exception finalizing transcript:", error instanceof Error ? error.message : error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Terminal status check - prevents status regressions
 */
export function isTerminalStatus(status: string | undefined): boolean {
  return ["completed", "failed", "canceled", "busy", "no_answer"].includes(
    (status || "").toLowerCase()
  );
}

/**
 * Safe status update that prevents terminal status regressions
 */
export async function safeUpdateStatus(
  callId: string,
  newStatus: string,
  extraFields: Partial<CallRecord> = {}
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: true };
  }

  try {
    // Check current status
    const { data: existing } = await supabase
      .from("calls")
      .select("status")
      .eq("id", callId)
      .single();

    const currentStatus = existing?.status;

    // If already terminal, don't downgrade
    if (isTerminalStatus(currentStatus) && !isTerminalStatus(newStatus)) {
      console.log(
        `[Supabase] Skipping status downgrade ${currentStatus} → ${newStatus} for ${callId}`
      );
      return { success: true };
    }

    return updateCall(callId, { status: newStatus, ...extraFields });
  } catch (error) {
    console.error("[Supabase] Exception in safeUpdateStatus:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
