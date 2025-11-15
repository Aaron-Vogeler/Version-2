/**
 * Handle POST /start-call endpoint
 * Receives authenticated user context from Next.js
 * Initiates Telnyx call and creates Supabase call record
 */

import type { Env } from './types';
import { initiateOutboundCall } from './utils/telnyx';
import { createSupabaseClient } from './utils/supabase';

export async function handleStartCall(request: Request, env: Env): Promise<Response> {
  // Only accept POST requests
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    // Parse request body
    const body = await request.json().catch(() => null);

    if (!body) {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Extract required fields
    const { user_id, goal, to_number } = body;

    // Validate required fields
    if (!user_id) {
      return new Response(JSON.stringify({ error: 'Missing user_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!to_number) {
      return new Response(JSON.stringify({ error: 'Missing to_number' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // For now, use user_id as tenant_id (adjust if you have multi-tenancy)
    const tenant_id = user_id;

    console.log(`Starting call for user ${user_id} to ${to_number}`);

    // Step 1: Initiate the Telnyx outbound call
    const telnyxResult = await initiateOutboundCall(env, {
      to_number,
      goal,
      user_id,
      tenant_id,
    });

    if (!telnyxResult.success) {
      console.error('Failed to initiate Telnyx call:', telnyxResult.error);
      return new Response(
        JSON.stringify({
          error: telnyxResult.error || 'Failed to initiate call',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const call_control_id = telnyxResult.call_control_id!;

    // Step 2: Create initial call record in Supabase
    const supabase = createSupabaseClient(env);

    const { error: insertError } = await supabase.from('calls').insert({
      id: call_control_id, // Use Telnyx call_control_id as the primary key
      tenant_id,
      user_id, // CRITICAL: Insert the authenticated user's ID
      direction: 'outbound',
      from_e164: process.env.TELNYX_FROM_NUMBER || '+18664001234',
      to_e164: to_number,
      status: 'initiated',
      goal: goal || null,
      goal_status: goal ? 'pending' : null,
      started_at: new Date().toISOString(),
      transcript_status: 'none',
    });

    if (insertError) {
      console.error('Error creating call record in Supabase:', insertError);
      return new Response(
        JSON.stringify({
          error: 'Failed to create call record',
          details: insertError.message,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Step 3: Return success response with call ID
    return new Response(
      JSON.stringify({
        success: true,
        call_id: call_control_id,
        message: `Call initiated for user ${user_id}`,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error: any) {
    console.error('Start call handler error:', error);
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        message: error.message,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
