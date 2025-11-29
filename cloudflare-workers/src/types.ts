/**
 * Type definitions for Cloudflare Workers
 */

export interface Env {
  // Secrets (set via wrangler secret put)
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  TELNYX_SIGNING_SECRET: string;
  TELNYX_API_KEY: string;

  // Queue bindings
  TELNYX_EVENTS: Queue;

  // KV namespace for idempotency
  IDEMPOTENCY?: KVNamespace;
}

export interface TelnyxWebhookPayload {
  data: {
    event_type: string;
    id: string;
    occurred_at: string;
    payload: {
      call_control_id: string;
      call_leg_id: string;
      call_session_id: string;
      client_state?: string;
      connection_id?: string;
      custom_headers?: Record<string, string>;
      direction?: 'incoming' | 'outgoing';
      from?: string;
      to?: string;
      state?: string;
      start_time?: string;
      answer_time?: string;
      end_time?: string;
      hangup_cause?: string;
      hangup_source?: string;
      [key: string]: any;
    };
    record_type: string;
  };
  meta?: {
    attempt: number;
    delivered_to: string;
  };
}

export interface NormalizedEvent {
  tenant_id: string;
  call_control_id: string;
  event_id: string;
  event_type: string;
  occurred_at: string;
  payload: Record<string, any>;
  client_state?: any;
}

export interface CallRecord {
  id: string;
  call_control_id?: string; // Current Telnyx call_control_id for active operations
  tenant_id: string;
  user_id: string; // Authenticated user ID from NextAuth
  direction: 'inbound' | 'outbound';
  from_e164: string;
  to_e164: string;
  status: string;
  started_at?: string;
  answered_at?: string;
  ended_at?: string;
  duration_sec?: number;
  billable_sec?: number;
  cost_usd?: number;
  goal?: string;
  goal_status?: string;
  recording_url?: string;
  transcript_status?: string;
  metadata?: Record<string, any>;
}

export interface CallEventRecord {
  id: string;
  call_id: string;
  tenant_id: string;
  type: string;
  occurred_at: string;
  payload: Record<string, any>;
}
