/**
 * Shared State Storage for Multi-Instance Support
 * ================================================
 *
 * This module provides Redis-backed state synchronization for critical TTS state
 * that needs to be consistent across multiple Fly.io instances.
 *
 * The Problem:
 * - Telnyx WebSocket streams are sticky to one instance
 * - Telnyx webhooks (call.speak.started, call.speak.ended) hit any instance
 * - This causes TTS state to be out of sync across instances
 *
 * The Solution:
 * - Store TTS state in Redis (keyed by callControlId)
 * - Webhooks update Redis
 * - Transcript handlers read from Redis before making barge-in decisions
 *
 * Fallback:
 * - If Redis is not configured, falls back to local state (single-instance mode)
 * - Logs a warning at startup if multi-instance mode is detected without Redis
 */

import { Redis } from "@upstash/redis";

// TTS State that needs to be synchronized across instances
export interface SyncedTtsState {
  ttsState: "idle" | "speaking" | "stopping";
  speakStartedAt?: number;
  speakWasInterrupted?: boolean;
  turnSeq: number;
  currentSpeakText?: string;
}

// Default state for new calls
const DEFAULT_TTS_STATE: SyncedTtsState = {
  ttsState: "idle",
  turnSeq: 0,
};

// Redis client (initialized lazily)
let redis: Redis | null = null;
let redisEnabled = false;
let redisInitialized = false;

// TTL for Redis keys (1 hour - calls should not last longer)
const KEY_TTL_SECONDS = 3600;

/**
 * Initialize Redis connection.
 * Call this at startup to check if Redis is available.
 */
export function initSharedState(): void {
  if (redisInitialized) return;
  redisInitialized = true;

  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (upstashUrl && upstashToken) {
    try {
      redis = new Redis({
        url: upstashUrl,
        token: upstashToken,
      });
      redisEnabled = true;
      console.log("[SharedState] Redis enabled for multi-instance TTS state sync");
    } catch (error) {
      console.warn(
        "[SharedState] Failed to initialize Redis:",
        error instanceof Error ? error.message : error
      );
      console.warn("[SharedState] Falling back to local-only state (single-instance mode)");
    }
  } else {
    console.log("[SharedState] Redis not configured (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set)");
    console.log("[SharedState] Running in single-instance mode. For multi-instance deployment, configure Upstash Redis.");
  }
}

/**
 * Check if Redis is enabled for shared state.
 */
export function isRedisEnabled(): boolean {
  return redisEnabled;
}

/**
 * Get Redis key for TTS state.
 */
function getTtsStateKey(callControlId: string): string {
  return `tts:${callControlId}`;
}

/**
 * Get TTS state from Redis.
 * Returns null if not found or Redis is disabled.
 */
export async function getTtsState(callControlId: string): Promise<SyncedTtsState | null> {
  if (!redisEnabled || !redis) {
    return null;
  }

  try {
    const data = await redis.get<SyncedTtsState>(getTtsStateKey(callControlId));
    return data;
  } catch (error) {
    console.error(
      "[SharedState] Error reading TTS state:",
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * Set TTS state in Redis.
 * Does nothing if Redis is disabled.
 */
export async function setTtsState(
  callControlId: string,
  state: Partial<SyncedTtsState>
): Promise<void> {
  if (!redisEnabled || !redis) {
    return;
  }

  try {
    const key = getTtsStateKey(callControlId);

    // Get existing state and merge
    const existing = await redis.get<SyncedTtsState>(key);
    const merged: SyncedTtsState = {
      ...DEFAULT_TTS_STATE,
      ...existing,
      ...state,
    };

    // Set with TTL
    await redis.setex(key, KEY_TTL_SECONDS, merged);
  } catch (error) {
    console.error(
      "[SharedState] Error writing TTS state:",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Update TTS state to 'speaking' when TTS starts.
 * Called from both the TTS API call and the call.speak.started webhook.
 */
export async function markTtsSpeaking(
  callControlId: string,
  speakText?: string
): Promise<void> {
  await setTtsState(callControlId, {
    ttsState: "speaking",
    speakStartedAt: Date.now(),
    speakWasInterrupted: false,
    currentSpeakText: speakText,
  });
}

/**
 * Update TTS state to 'idle' when TTS ends.
 * Called from the call.speak.ended webhook.
 */
export async function markTtsIdle(callControlId: string): Promise<void> {
  await setTtsState(callControlId, {
    ttsState: "idle",
    speakStartedAt: undefined,
  });
}

/**
 * Mark current speech as interrupted by barge-in.
 */
export async function markTtsInterrupted(callControlId: string): Promise<void> {
  await setTtsState(callControlId, {
    speakWasInterrupted: true,
    ttsState: "stopping",
  });
}

/**
 * Increment turn sequence (for barge-in invalidation).
 */
export async function incrementTurnSeq(callControlId: string): Promise<number> {
  if (!redisEnabled || !redis) {
    return 0;
  }

  try {
    const key = getTtsStateKey(callControlId);
    const existing = await redis.get<SyncedTtsState>(key);
    const newSeq = ((existing?.turnSeq || 0) + 1);

    await setTtsState(callControlId, { turnSeq: newSeq });
    return newSeq;
  } catch (error) {
    console.error(
      "[SharedState] Error incrementing turn sequence:",
      error instanceof Error ? error.message : error
    );
    return 0;
  }
}

/**
 * Delete TTS state when call ends.
 */
export async function clearTtsState(callControlId: string): Promise<void> {
  if (!redisEnabled || !redis) {
    return;
  }

  try {
    await redis.del(getTtsStateKey(callControlId));
  } catch (error) {
    console.error(
      "[SharedState] Error clearing TTS state:",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Sync local CallContext with Redis state.
 * Call this before making barge-in decisions.
 * Returns the Redis state if available, null otherwise.
 */
export async function syncFromRedis(
  callControlId: string
): Promise<SyncedTtsState | null> {
  return getTtsState(callControlId);
}

/**
 * Sync local CallContext to Redis.
 * Call this after updating local TTS state.
 */
export async function syncToRedis(
  callControlId: string,
  localState: {
    ttsState?: "idle" | "speaking" | "stopping";
    speakStartedAt?: number;
    speakWasInterrupted?: boolean;
    turnSeq?: number;
    currentSpeakText?: string;
  }
): Promise<void> {
  await setTtsState(callControlId, localState);
}
