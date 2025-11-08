/**
 * Cloudflare Worker entry point
 * Handles webhook requests, queue processing, and scheduled jobs
 */

import type { Env, NormalizedEvent } from './types';
import { handleWebhook } from './webhook-handler';
import { processEventBatch } from './queue-consumer';
import { runScheduledJob } from './scheduled-job';

export default {
  /**
   * HTTP request handler
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Webhook endpoint
    if (url.pathname === '/telnyx/webhook') {
      return handleWebhook(request, env);
    }

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },

  /**
   * Queue consumer handler
   */
  async queue(batch: MessageBatch<NormalizedEvent>, env: Env): Promise<void> {
    await processEventBatch(batch, env);
  },

  /**
   * Scheduled/cron handler
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledJob(env));
  },
};
