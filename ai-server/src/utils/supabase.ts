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
 * Update live transcript with smart interim/final handling
 * - Interim results: Replace the current staging area (no duplicates)
 * - Final results: Commit to the permanent transcript
 * @param callId - The call control ID
 * @param speaker - Speaker identification ("caller" or "assistant")
 * @param text - The transcript text
 * @param isFinal - Whether this is a final result (true) or interim (false)
 * @returns Success/error result
 */
export async function updateLiveTranscript(
  callId: string,
  speaker: TranscriptSpeaker,
  text: string,
  isFinal: boolean = false
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: true };
  }

  const trimmedText = text.trim();
  if (!trimmedText) {
    return { success: true };
  }

  try {
    // Fetch existing live transcript
    const { data: existing } = await supabase
      .from("calls")
      .select("live_transcript")
      .eq("id", callId)
      .single();

    let existingTranscript = existing?.live_transcript || "";
    const speakerLabel = speaker === "caller" ? "Caller" : "Assistant";

    // Markers to identify interim sections
    const interimMarkerStart = `[INTERIM-${speaker.toUpperCase()}]`;
    const interimMarkerEnd = `[/INTERIM-${speaker.toUpperCase()}]`;

    // Remove any existing interim section for this speaker
    const interimRegex = new RegExp(`${interimMarkerStart}[\\s\\S]*?${interimMarkerEnd}`, 'g');
    const cleanTranscript = existingTranscript.replace(interimRegex, '').trim();

    let updatedTranscript: string;

    if (isFinal) {
      // Final result: Add to permanent transcript (no markers)
      const formattedBlock = `${speakerLabel}\n${trimmedText}`;
      updatedTranscript = cleanTranscript
        ? `${cleanTranscript}\n\n${formattedBlock}`
        : formattedBlock;
    } else {
      // Interim result: Add to staging area (with markers)
      const interimBlock = `${interimMarkerStart}\n${speakerLabel}\n${trimmedText}\n${interimMarkerEnd}`;
      updatedTranscript = cleanTranscript
        ? `${cleanTranscript}\n\n${interimBlock}`
        : interimBlock;
    }

    const { error } = await supabase
      .from("calls")
      .update({
        live_transcript: updatedTranscript,
        transcript_status: "processing",
        updated_at: new Date().toISOString(),
      })
      .eq("id", callId);

    if (error) {
      console.error("[Supabase] Error updating live transcript:", error.message);
      return { success: false, error: error.message };
    }

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
