/**
 * Queue consumer for processing Telnyx events
 * Upserts calls and events into Supabase
 */

import type { Env, NormalizedEvent, CallRecord, CallEventRecord } from './types';
import { upsertCall, upsertCallEvent, publishRealtimeUpdate } from './utils/supabase';

/**
 * Process batch of events from queue
 */
export async function processEventBatch(
  batch: MessageBatch<NormalizedEvent>,
  env: Env
): Promise<void> {
  console.log(`Processing batch of ${batch.messages.length} events`);

  for (const message of batch.messages) {
    try {
      await processEvent(message.body, env);
      message.ack();
    } catch (error) {
      console.error('Error processing event:', error);
      message.retry();
    }
  }
}

/**
 * Process single normalized event
 */
async function processEvent(event: NormalizedEvent, env: Env): Promise<void> {
  const { tenant_id, call_control_id, event_id, event_type, occurred_at, payload, client_state } = event;

  console.log(`Processing ${event_type} for call ${call_control_id}`);

  // Extract user_id from client_state if available
  // client_state is set during initiateOutboundCall
  const user_id = client_state?.user_id || tenant_id;

  // Insert call event record
  const callEvent: CallEventRecord = {
    id: event_id,
    call_id: call_control_id,
    tenant_id,
    type: event_type,
    occurred_at,
    payload,
  };

  await upsertCallEvent(env, callEvent);

  // Update or create call record based on event type
  const callUpdate = mapEventToCallUpdate(event);

  if (callUpdate) {
    await upsertCall(env, {
      id: call_control_id,
      call_control_id, // Always store the current call_control_id for hangup operations
      tenant_id,
      user_id, // IMPORTANT: Pass the authenticated user_id
      ...callUpdate,
    });

    // Publish realtime update
    await publishRealtimeUpdate(env, tenant_id, 'call_updated', {
      call_id: call_control_id,
      event_type,
    });
  }

  console.log(`Successfully processed event ${event_id}`);
}

/**
 * Map Telnyx event to call record update
 */
function mapEventToCallUpdate(event: NormalizedEvent): Partial<CallRecord> | null {
  const { event_type, payload, occurred_at, client_state } = event;

  switch (event_type) {
    case 'call.initiated':
      return {
        direction: payload.direction === 'incoming' ? 'inbound' : 'outbound',
        from_e164: payload.from || 'unknown',
        to_e164: payload.to || 'unknown',
        status: 'initiated',
        started_at: payload.start_time || occurred_at,
        goal: client_state?.goal || null,
        goal_status: client_state?.goal ? 'pending' : null,
        assistant_id: client_state?.assistant_id || payload.assistant_id || null,
        assistant_name: client_state?.assistant_name || payload.assistant_name || null,
        transcript_status: 'none',
      };

    case 'call.ringing':
      return {
        status: 'ringing',
      };

    case 'call.answered':
      return {
        status: 'answered',
        answered_at: payload.answer_time || occurred_at,
      };

    case 'call.hangup':
      // Determine final status based on hangup cause
      let status = 'completed';
      if (payload.hangup_cause === 'no_answer') {
        status = 'no-answer';
      } else if (payload.hangup_cause === 'busy') {
        status = 'busy';
      } else if (payload.hangup_cause && payload.hangup_cause !== 'normal_clearing') {
        status = 'failed';
      }

      return {
        status,
        ended_at: payload.end_time || occurred_at,
        // Compute provisional duration if we have timestamps
        duration_sec: computeDuration(payload.start_time, payload.end_time || occurred_at),
        billable_sec: computeBillableDuration(payload.answer_time, payload.end_time || occurred_at),
      };

    case 'call.recording.saved':
      return {
        recording_url: payload.recording_url || payload.public_recording_url,
      };

    case 'call.transcription.completed':
      return {
        transcript_status: 'completed',
        transcript: payload.transcript_text || null,
        transcript_url: payload.transcript_url || null,
      };

    case 'call.machine_detection.ended':
      // Handle AI detection completion
      return {
        metadata: {
          machine_detection: payload.result,
        },
      };

    default:
      // Unknown event type, don't update call
      return null;
  }
}

/**
 * Compute call duration in seconds
 */
function computeDuration(startTime?: string, endTime?: string): number {
  if (!startTime || !endTime) return 0;

  try {
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    return Math.max(0, Math.floor((end - start) / 1000));
  } catch {
    return 0;
  }
}

/**
 * Compute billable duration (from answer to hangup)
 */
function computeBillableDuration(answerTime?: string, endTime?: string): number {
  if (!answerTime || !endTime) return 0;

  try {
    const answer = new Date(answerTime).getTime();
    const end = new Date(endTime).getTime();
    return Math.max(0, Math.floor((end - answer) / 1000));
  } catch {
    return 0;
  }
}
