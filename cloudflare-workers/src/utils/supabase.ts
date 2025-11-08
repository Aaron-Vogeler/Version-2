/**
 * Supabase client utilities for Cloudflare Workers
 */

import { createClient } from '@supabase/supabase-js';
import type { Env, CallRecord, CallEventRecord } from '../types';

/**
 * Create Supabase client with service role key
 */
export function createSupabaseClient(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Upsert call event (idempotent)
 */
export async function upsertCallEvent(
  env: Env,
  event: CallEventRecord
): Promise<{ success: boolean; error?: string }> {
  const supabase = createSupabaseClient(env);

  const { error } = await supabase
    .from('call_events')
    .upsert(event, { onConflict: 'id', ignoreDuplicates: true });

  if (error) {
    console.error('Error upserting call event:', error);
    return { success: false, error: error.message };
  }

  return { success: true };
}

/**
 * Upsert call record with status transitions
 */
export async function upsertCall(
  env: Env,
  call: Partial<CallRecord> & { id: string; tenant_id: string }
): Promise<{ success: boolean; error?: string }> {
  const supabase = createSupabaseClient(env);

  // Fetch existing call if it exists
  const { data: existing } = await supabase
    .from('calls')
    .select('*')
    .eq('id', call.id)
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
      }
    : call;

  const { error } = await supabase
    .from('calls')
    .upsert(merged, { onConflict: 'id' });

  if (error) {
    console.error('Error upserting call:', error);
    return { success: false, error: error.message };
  }

  return { success: true };
}

/**
 * Publish realtime update to tenant channel
 */
export async function publishRealtimeUpdate(
  env: Env,
  tenantId: string,
  event: string,
  payload: any
): Promise<void> {
  const supabase = createSupabaseClient(env);

  // Supabase Realtime works via database changes
  // The RLS policies and realtime publication handle broadcasting
  // No explicit publish needed - just ensure the change is written to DB
  console.log(`Realtime update for tenant ${tenantId}: ${event}`);
}
