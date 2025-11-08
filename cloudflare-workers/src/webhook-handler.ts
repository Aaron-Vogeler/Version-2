/**
 * Telnyx webhook receiver
 * Verifies signatures and enqueues events for processing
 */

import type { Env, TelnyxWebhookPayload, NormalizedEvent } from './types';
import { verifyTelnyxSignature } from './utils/crypto';

/**
 * Handle incoming Telnyx webhook
 */
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  // Only accept POST requests
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    // Get raw body for signature verification
    const rawBody = await request.text();
    const signatureHeader = request.headers.get('telnyx-signature-ed25519') ||
                           request.headers.get('telnyx-signature');

    // Verify webhook signature
    const isValid = await verifyTelnyxSignature(
      rawBody,
      signatureHeader,
      env.TELNYX_SIGNING_SECRET
    );

    if (!isValid) {
      console.error('Invalid webhook signature');
      return new Response('Unauthorized', { status: 401 });
    }

    // Parse webhook payload
    const payload: TelnyxWebhookPayload = JSON.parse(rawBody);
    const { data } = payload;

    // Extract tenant_id from custom headers or client_state
    const tenantId = extractTenantId(data.payload);

    if (!tenantId) {
      console.error('No tenant_id found in webhook payload');
      // Still return 200 to prevent retries, but log the error
      return new Response('OK', { status: 200 });
    }

    // Normalize the event
    const normalizedEvent: NormalizedEvent = {
      tenant_id: tenantId,
      call_control_id: data.payload.call_control_id,
      event_id: data.id,
      event_type: data.event_type,
      occurred_at: data.occurred_at,
      payload: data.payload,
      client_state: data.payload.client_state
        ? (typeof data.payload.client_state === 'string'
            ? JSON.parse(data.payload.client_state)
            : data.payload.client_state)
        : undefined,
    };

    // Check idempotency (if KV is available)
    if (env.IDEMPOTENCY) {
      const processed = await env.IDEMPOTENCY.get(`event:${data.id}`);
      if (processed) {
        console.log(`Event ${data.id} already processed (idempotent)`);
        return new Response('OK', { status: 200 });
      }
    }

    // Enqueue event for processing
    await env.TELNYX_EVENTS.send(normalizedEvent);

    // Mark as processed (if KV is available)
    if (env.IDEMPOTENCY) {
      await env.IDEMPOTENCY.put(`event:${data.id}`, '1', {
        expirationTtl: 86400, // 24 hours
      });
    }

    console.log(`Enqueued event ${data.id} for tenant ${tenantId}`);

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Webhook processing error:', error);

    // Return 200 to prevent Telnyx from retrying on our errors
    // Log to external service in production
    return new Response('OK', { status: 200 });
  }
}

/**
 * Extract tenant_id from webhook payload
 * Tries multiple locations: custom_headers, client_state, etc.
 */
function extractTenantId(payload: any): string | null {
  // Try custom headers first
  if (payload.custom_headers && payload.custom_headers['X-Tenant']) {
    return payload.custom_headers['X-Tenant'];
  }
  if (payload.custom_headers && payload.custom_headers['x-tenant']) {
    return payload.custom_headers['x-tenant'];
  }

  // Try client_state
  if (payload.client_state) {
    try {
      const clientState = typeof payload.client_state === 'string'
        ? JSON.parse(payload.client_state)
        : payload.client_state;

      if (clientState.tenant_id) {
        return clientState.tenant_id;
      }
      if (clientState.tenantId) {
        return clientState.tenantId;
      }
    } catch {
      // Ignore parse errors
    }
  }

  return null;
}
