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
  pendingHangupAfterTts?: boolean; // Flag to hang up after TTS completes
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

// Get Fly.io machine ID from environment
const FLY_MACHINE_ID = process.env.FLY_ALLOC_ID || process.env.FLY_MACHINE_ID || null;

/**
 * Initialize Redis connection.
 * Call this at startup to check if Redis is available.
 */
export function initSharedState(): void {
  if (redisInitialized) return;
  redisInitialized = true;

  // Log machine ID for debugging multi-instance routing
  console.log(`[SharedState] FLY_MACHINE_ID: ${FLY_MACHINE_ID || 'NOT SET'}`);
  console.log(`[SharedState] FLY_ALLOC_ID env: ${process.env.FLY_ALLOC_ID || 'NOT SET'}`);
  console.log(`[SharedState] FLY_MACHINE_ID env: ${process.env.FLY_MACHINE_ID || 'NOT SET'}`);

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
      console.log(`[SharedState] Multi-instance observer routing: ${FLY_MACHINE_ID ? 'ENABLED' : 'DISABLED (no machine ID)'}`);
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
 * Set pending hangup flag (to hang up after TTS completes).
 * Called when "end" behavior or "Chow" is detected.
 */
export async function setPendingHangup(callControlId: string, pending: boolean): Promise<void> {
  await setTtsState(callControlId, {
    pendingHangupAfterTts: pending,
  });
}

/**
 * Check if there's a pending hangup for this call.
 * Returns true if we should hang up after TTS completes.
 */
export async function getPendingHangup(callControlId: string): Promise<boolean> {
  const state = await getTtsState(callControlId);
  return state?.pendingHangupAfterTts ?? false;
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

// =============================================================================
// CALL-TO-MACHINE ROUTING (for multi-instance observer support)
// =============================================================================

/**
 * Get Redis key for call-to-machine mapping.
 */
function getCallMachineKey(callControlId: string): string {
  return `call_machine:${callControlId}`;
}

/**
 * Get the current Fly.io machine ID.
 */
export function getCurrentMachineId(): string | null {
  return FLY_MACHINE_ID;
}

/**
 * Register this machine as the handler for a call.
 * Call this when a call context is created.
 */
export async function registerCallMachine(callControlId: string): Promise<void> {
  if (!redisEnabled || !redis || !FLY_MACHINE_ID) {
    console.log(`[SharedState] Cannot register call machine: redisEnabled=${redisEnabled}, redis=${!!redis}, FLY_MACHINE_ID=${FLY_MACHINE_ID || 'null'}`);
    return;
  }

  try {
    const key = getCallMachineKey(callControlId);
    await redis.setex(key, KEY_TTL_SECONDS, FLY_MACHINE_ID);
    console.log(`[SharedState] ✅ Registered call ${callControlId.slice(-8)} on machine ${FLY_MACHINE_ID.slice(0, 8)}...`);
  } catch (error) {
    console.error(
      "[SharedState] Error registering call machine:",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Get the machine ID that is handling a specific call.
 * Returns null if not found or Redis is disabled.
 */
export async function getCallMachine(callControlId: string): Promise<string | null> {
  if (!redisEnabled || !redis) {
    return null;
  }

  try {
    const key = getCallMachineKey(callControlId);
    const machineId = await redis.get<string>(key);
    return machineId;
  } catch (error) {
    console.error(
      "[SharedState] Error getting call machine:",
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * Clear the call-to-machine mapping when a call ends.
 */
export async function clearCallMachine(callControlId: string): Promise<void> {
  if (!redisEnabled || !redis) {
    return;
  }

  try {
    await redis.del(getCallMachineKey(callControlId));
  } catch (error) {
    console.error(
      "[SharedState] Error clearing call machine:",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Check if this machine is the one handling a call.
 * Returns: { isLocal: true } if we handle it locally
 *          { isLocal: false, machineId: string } if another machine handles it
 *          { isLocal: false, machineId: null } if unknown
 */
export async function checkCallMachine(callControlId: string): Promise<{
  isLocal: boolean;
  machineId: string | null;
}> {
  // If we don't have Redis or machine ID, assume local
  if (!redisEnabled || !redis || !FLY_MACHINE_ID) {
    return { isLocal: true, machineId: null };
  }

  try {
    const machineId = await getCallMachine(callControlId);

    if (!machineId) {
      // Call not registered - unknown
      return { isLocal: false, machineId: null };
    }

    if (machineId === FLY_MACHINE_ID) {
      // We handle this call
      return { isLocal: true, machineId };
    }

    // Another machine handles this call
    return { isLocal: false, machineId };
  } catch (error) {
    console.error(
      "[SharedState] Error checking call machine:",
      error instanceof Error ? error.message : error
    );
    return { isLocal: true, machineId: null };
  }
}

// =============================================================================
// MUSIC DETECTION STATE SYNC (for multi-instance barge-in coordination)
// =============================================================================

/**
 * Music detection state that needs to be synchronized across instances.
 */
export interface SyncedMusicState {
  musicDetected: boolean;
  musicStateChangedAt: number;
  confidence: number;
  floor: number;
  detectionMethod: "floor_rise" | "floor_drop" | "initial" | "transcript";
}

/**
 * Get Redis key for music detection state.
 */
function getMusicStateKey(callControlId: string): string {
  return `music:${callControlId}`;
}

/**
 * Get music detection state from Redis.
 * Returns null if not found or Redis is disabled.
 */
export async function getMusicState(callControlId: string): Promise<SyncedMusicState | null> {
  if (!redisEnabled || !redis) {
    return null;
  }

  try {
    const data = await redis.get<SyncedMusicState>(getMusicStateKey(callControlId));
    return data;
  } catch (error) {
    console.error(
      "[SharedState] Error reading music state:",
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * Set music detection state in Redis.
 * Does nothing if Redis is disabled.
 */
export async function setMusicState(
  callControlId: string,
  state: Partial<SyncedMusicState>
): Promise<void> {
  if (!redisEnabled || !redis) {
    return;
  }

  try {
    const key = getMusicStateKey(callControlId);

    // Get existing state and merge
    const existing = await redis.get<SyncedMusicState>(key);
    const merged: SyncedMusicState = {
      musicDetected: false,
      musicStateChangedAt: Date.now(),
      confidence: 0,
      floor: 0,
      detectionMethod: "initial",
      ...existing,
      ...state,
    };

    // Set with TTL
    await redis.setex(key, KEY_TTL_SECONDS, merged);
  } catch (error) {
    console.error(
      "[SharedState] Error writing music state:",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Update music detection state when music starts or stops.
 * Called from the energy floor tracker when state changes.
 */
export async function updateMusicDetection(
  callControlId: string,
  musicDetected: boolean,
  confidence: number,
  floor: number,
  detectionMethod: SyncedMusicState["detectionMethod"]
): Promise<void> {
  await setMusicState(callControlId, {
    musicDetected,
    musicStateChangedAt: Date.now(),
    confidence,
    floor,
    detectionMethod,
  });

  console.log(
    `[SharedState] Music state synced: ${musicDetected ? "MUSIC_DETECTED" : "MUSIC_STOPPED"} (confidence=${confidence.toFixed(2)}, floor=${floor.toFixed(4)})`
  );
}

/**
 * Clear music detection state when call ends.
 */
export async function clearMusicState(callControlId: string): Promise<void> {
  if (!redisEnabled || !redis) {
    return;
  }

  try {
    await redis.del(getMusicStateKey(callControlId));
  } catch (error) {
    console.error(
      "[SharedState] Error clearing music state:",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Sync local music state from Redis.
 * Call this before making barge-in decisions to ensure consistency.
 */
export async function syncMusicFromRedis(
  callControlId: string
): Promise<SyncedMusicState | null> {
  return getMusicState(callControlId);
}
