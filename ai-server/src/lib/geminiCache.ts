/**
 * Gemini Cache Module
 *
 * Implements explicit cache management for Gemini system prompts using Supabase
 * for cache metadata storage. Enables cost-efficient repeated calls with the same
 * system prompt by caching it server-side via Gemini's cachedContent API.
 *
 * Key features:
 * - Shared cache pointer stored in Supabase (gemini_prompt_cache table)
 * - Automatic cache refresh when expired or about to expire
 * - 1024 token minimum for Gemini 2.5 Flash models
 * - JSON-only output via responseMimeType
 * - Retry logic for cache expiry edge cases
 * - Streaming support with early TTS callback for low latency
 */

import { GoogleGenAI, createUserContent, createPartFromText, Type } from "@google/genai";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import config from "../config";
import { StreamingJsonParser } from "../pipeline/streamingJsonParser";
import { LatencyTracker } from "./latencyLogger";

// =============================================================================
// CONSTANTS
// =============================================================================

const PROMPT_VERSION = "ferguson-system-v2";
const TTL_SECONDS = config.gemini.cacheTtlSeconds || 3600;
const MODEL_NAME = config.gemini.cacheModel || "gemini-2.5-flash-lite";
const CACHE_EXPIRY_BUFFER_MS = 10_000; // 10 seconds buffer before expiry
const MIN_CACHE_TOKENS = 1024; // Minimum tokens required for Gemini 2.5 Flash caching

/**
 * Ferguson system prompt for caching (static part only).
 * Dynamic parts (assistant name, user name, goal, introduction) are passed at runtime via contents.
 * This prompt meets Gemini 2.5 Flash's 1024 token minimum for caching.
 */
const SYSTEM_PROMPT = `IDENTITY
You are Ferguson, a professional AI assistant calling on behalf of Aaron. You sound like a competent, warm human secretary.

ABSOLUTE OUTPUT RULE (MUST ALWAYS HOLD)

* You MUST output ONLY ONE valid JSON object on every turn. No markdown. No extra text. No brackets like [DTMF: 1].
* If you ever start to output anything other than a JSON object, STOP and output a corrected single JSON object instead.

CORE PRINCIPLES

1. GOAL IS EVERYTHING
   Your goal defines what you're trying to accomplish. Read it carefully.
   Every response should move toward completing it — nothing more, nothing less.

2. YOU ONLY KNOW WHAT YOU'RE TOLD
   Your GOAL and CONTEXT are your complete universe of facts.

* If it's not written there, you don't know it.
* You cannot invent times, prices, dates, names, numbers, or details.
* You cannot promise actions Aaron will take.
* You cannot offer alternatives not given to you.

INFORMATION DIRECTIONALITY

* Details about Aaron (his schedule, preferences, plans) → only you could know these (but ONLY if provided).
* Details about them (stock, hours, policies, requirements) → only they would know these.
* Never ask them for information only Aaron's side would have.
* Never offer them information only Aaron's side would have.

WHEN ASKED FOR SOMETHING YOU DON'T HAVE (AARON-SIDE DETAIL)
Use this exact two-step pattern:

STEP A (ONE attempt to proceed without it):
"I wasn't given that detail, unfortunately. Is there any way to proceed without it?"

STEP B (If they say it IS required / they cannot proceed):
"Understood — I don't have that detail. I'll pass that along to Aaron and we'll follow up. Thanks for your help."
Then END the call.

IMPORTANT LIMITS

* Do NOT repeat Step A more than once in the entire call.
* If they give a vague answer (e.g., "kinda sort of"), ask ONLY ONE yes/no clarification:
  "Just to confirm — do you need an exact pickup time to place the hold?"

  * If YES → do Step B and END.
  * If NO → proceed with the goal.

4. GRACEFUL FAILURE IS SUCCESS
   If the goal can't be completed, that's a valid outcome. Thank them and end. Don't invent workarounds.

5. BE GENTLY PERSISTENT (BUT DON'T LOOP)
   Don't give up on the first obstacle or rejection.

* If they resist, politely restate the request once OR ask a single policy-based question that is on THEIR side.
  Example: "Is there any way to hold it without a pickup time?"
* Only one "soft pushback" attempt per obstacle.
* If they hold firm after your attempt, accept it gracefully and end.

6. CONFIRM BEFORE CLOSING (ONLY IF YOU ACTUALLY HAVE CONFIRMABLE FACTS)
   When the goal appears complete:

* Confirm the key details once in plain language (only what THEY confirmed).
* Then end after they confirm.

7. KNOW WHEN TO END (IMPASSE DETECTOR)
   End immediately when any of these are true:

* Goal achieved and confirmed.
* Goal impossible after one soft pushback.
* They require a missing Aaron-side detail you don't have (after Step A/one clarification).
* They are uncooperative/hostile.
* diversion_count >= 5.

8. WAIT WHEN TOLD
   If they say "hold on," "one moment," "let me check" — go silent and wait.

9. STAY BRIEF AND HUMAN
   1–2 sentences per turn. Use natural phrases: "Great," "Perfect," "Got it," "No problem."

10. BE HONEST
    If asked whether you're AI, say yes.

11. DTMF (IVR)
    If confronted with IVR, listen to options. Choose whichever is most likely to progress toward the goal.
    If you should press, press the option most likely to route correctly. If you should wait, then wait.

12. DTMF (IVR)
    Once goal is completed, thank them and end call.

---

OUTPUT FORMAT
You must output ONLY a valid JSON object. Do not output markdown blocks (\`\`\`json).

{
"speak": "Text to say to a human (or null)",
"behavior": "speak" | "wait" | "hold" | "end" | "dtmf",
"dtmf": "0-9*#" (only if behavior is "dtmf", otherwise null),
"internal": "Brief reasoning",
"diversion_count": 0-5
}

DIVERSION COUNT RULES (TRACK IMPASSES)

Based on the context of what's going on, decide if they're intentionally "leading you on" or being "mischevious".
* If diversion_count >= 5 → end.

BEHAVIOR GUIDE

* "speak": Talking to humans. Under 2 sentences. One question max.
* "wait": Short pauses or IVR menu still playing.
* "hold": Transfers or long waits (hold music, "please hold").
* "dtmf": Press buttons ONLY for IVR menus.
* "end": When done, impossible, or impasse rules trigger.

ENDING SCRIPT (DEFAULT)
Use when ending for any reason:
"Thanks for your help — I appreciate it. Have a good day."

MENTAL MODEL
You are a professional courier. You deliver exactly what's in the envelope. You don't add to it.
You confirm delivery and leave. If the door seems closed, you knock once more politely before walking away.`;

// =============================================================================
// TYPES
// =============================================================================

interface CacheMetadata {
  prompt_version: string;
  cache_name: string;
  expires_at: string;
  updated_at: string;
  last_error: string | null;
}

// =============================================================================
// SUPABASE CLIENT
// =============================================================================

let supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient | null {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
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

// =============================================================================
// GEMINI CLIENT
// =============================================================================

let genaiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI | null {
  if (!config.gemini.apiKey) {
    return null;
  }

  if (!genaiClient) {
    genaiClient = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  }

  return genaiClient;
}

// =============================================================================
// CACHE MANAGEMENT
// =============================================================================

/**
 * Read cache metadata from Supabase for a given prompt version.
 */
async function readCacheMetadata(promptVersion: string): Promise<CacheMetadata | null> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    debugLog("Supabase not configured, cannot read cache metadata");
    return null;
  }

  try {
    const { data, error } = await supabase
      .from("gemini_prompt_cache")
      .select("prompt_version, cache_name, expires_at, updated_at, last_error")
      .eq("prompt_version", promptVersion)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        // No rows returned - cache doesn't exist yet
        debugLog(`No cache found for ${promptVersion}`);
        return null;
      }
      console.error("[GeminiCache] Error reading cache metadata:", error.message);
      return null;
    }

    return data as CacheMetadata;
  } catch (err) {
    console.error("[GeminiCache] Exception reading cache metadata:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Upsert cache metadata in Supabase.
 */
async function upsertCacheMetadata(
  promptVersion: string,
  cacheName: string,
  expiresAt: Date,
  lastError: string | null = null
): Promise<boolean> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    debugLog("Supabase not configured, cannot upsert cache metadata");
    return false;
  }

  try {
    const { error } = await supabase
      .from("gemini_prompt_cache")
      .upsert({
        prompt_version: promptVersion,
        cache_name: cacheName,
        expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
        last_error: lastError,
      }, { onConflict: "prompt_version" });

    if (error) {
      console.error("[GeminiCache] Error upserting cache metadata:", error.message);
      return false;
    }

    debugLog(`Cache metadata upserted for ${promptVersion}: ${cacheName}`);
    return true;
  } catch (err) {
    console.error("[GeminiCache] Exception upserting cache metadata:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Update last_error in cache metadata.
 */
async function updateCacheError(promptVersion: string, errorMessage: string): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    await supabase
      .from("gemini_prompt_cache")
      .update({
        last_error: errorMessage.substring(0, 500), // Truncate to prevent overflow
        updated_at: new Date().toISOString(),
      })
      .eq("prompt_version", promptVersion);
  } catch (err) {
    console.error("[GeminiCache] Failed to update error:", err instanceof Error ? err.message : err);
  }
}

/**
 * Check if cache is valid (exists and not expired).
 */
function isCacheValid(metadata: CacheMetadata | null): boolean {
  if (!metadata || !metadata.cache_name || !metadata.expires_at) {
    return false;
  }

  const expiresAt = new Date(metadata.expires_at);
  const now = new Date();
  const bufferTime = new Date(now.getTime() + CACHE_EXPIRY_BUFFER_MS);

  return expiresAt > bufferTime;
}

/**
 * Create a new cache in Gemini API.
 * Uses systemInstruction for the full prompt (like the Colab pattern).
 * The cached system prompt is reused across all calls for cost savings.
 */
async function createGeminiCache(systemPrompt: string): Promise<{ cacheName: string; expiresAt: Date } | null> {
  const genai = getGeminiClient();
  if (!genai) {
    console.error("[GeminiCache] Gemini client not configured");
    return null;
  }

  debugLog(`Creating new Gemini cache for model ${MODEL_NAME}`);
  console.log(`[GeminiCache] System prompt length: ${systemPrompt.length} chars`);

  try {
    // Create cache with system prompt in systemInstruction (like Colab pattern)
    // This is the correct way - system prompt goes in systemInstruction, not contents
    const cache = await genai.caches.create({
      model: MODEL_NAME,
      config: {
        displayName: PROMPT_VERSION,
        systemInstruction: systemPrompt,
        ttl: `${TTL_SECONDS}s`,
      },
    });

    if (!cache.name) {
      console.error("[GeminiCache] Cache created but no name returned");
      return null;
    }

    // Parse expiration time from response
    const expiresAt = cache.expireTime
      ? new Date(cache.expireTime)
      : new Date(Date.now() + TTL_SECONDS * 1000);

    console.log(`[GeminiCache] ✅ Cache created: ${cache.name}, expires: ${expiresAt.toISOString()}`);

    return {
      cacheName: cache.name,
      expiresAt,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[GeminiCache] Failed to create cache:", errorMessage);
    await updateCacheError(PROMPT_VERSION, errorMessage);
    throw err;
  }
}

/**
 * Get or create a valid cache for the Ferguson system prompt.
 * Always uses the hardcoded SYSTEM_PROMPT - ignores any passed prompt.
 * This ensures consistent caching across all calls.
 */
async function getOrCreateCache(): Promise<string | null> {
  // Try to read existing cache
  const metadata = await readCacheMetadata(PROMPT_VERSION);

  if (isCacheValid(metadata)) {
    debugLog(`Using existing cache: ${metadata!.cache_name}`);
    return metadata!.cache_name;
  }

  // Cache missing or expired - create new one with the hardcoded SYSTEM_PROMPT
  console.log("[GeminiCache] Cache missing or expired, creating new cache with full Ferguson prompt");

  const newCache = await createGeminiCache(SYSTEM_PROMPT);
  if (!newCache) {
    return null;
  }

  // Store in Supabase
  await upsertCacheMetadata(PROMPT_VERSION, newCache.cacheName, newCache.expiresAt, null);

  return newCache.cacheName;
}

// =============================================================================
// MAIN EXPORT: generateJsonWithCachedSystem
// =============================================================================

/**
 * Generate JSON response using Gemini with cached system prompt.
 *
 * This function:
 * 1. Reads cache metadata from Supabase
 * 2. If cache is valid (expires_at > now + 10s), uses cachedContent
 * 3. If cache is missing/expired, creates new cache via Gemini API
 * 4. If Gemini call fails due to cache expiry, refreshes and retries once
 * 5. Always requests JSON output via responseMimeType
 *
 * Note: Always uses the hardcoded SYSTEM_PROMPT for caching consistency.
 *
 * @param dynamicInput - The dynamic user input/context for this generation
 * @returns The generated JSON response as a string
 */
export async function generateJsonWithCachedSystem(
  dynamicInput: string
): Promise<string> {
  const genai = getGeminiClient();
  if (!genai) {
    throw new Error("Gemini client not configured - GEMINI_API_KEY not set");
  }

  let retryCount = 0;
  const maxRetries = 1;

  while (retryCount <= maxRetries) {
    try {
      // Get or create cache (uses hardcoded SYSTEM_PROMPT)
      const cacheName = await getOrCreateCache();

      if (!cacheName) {
        // Fallback to non-cached call if cache creation fails
        console.warn("[GeminiCache] Cache unavailable, falling back to non-cached call");
        return await generateWithoutCache(genai, SYSTEM_PROMPT, dynamicInput);
      }

      // Generate with cached content
      debugLog(`Generating with cache: ${cacheName}`);

      // Use type assertion for cachedContent (SDK types don't include it yet)
      const response = await genai.models.generateContent({
        model: MODEL_NAME,
        contents: [
          createUserContent([createPartFromText(dynamicInput)]),
        ],
        config: {
          cachedContent: cacheName,
          responseMimeType: "application/json",
        },
      } as any);

      const text = response.text || "";
      debugLog(`Response received (${text.length} chars)`);

      // Strip markdown fences if present
      return stripCodeFences(text);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Check if error is due to cache expiry/not found
      const isCacheError = errorMessage.includes("cache") &&
        (errorMessage.includes("expired") || errorMessage.includes("not found") || errorMessage.includes("invalid"));

      if (isCacheError && retryCount < maxRetries) {
        console.warn(`[GeminiCache] Cache error detected, refreshing cache (attempt ${retryCount + 1})`);
        retryCount++;

        // Force cache refresh by creating new cache
        const newCache = await createGeminiCache(SYSTEM_PROMPT);
        if (newCache) {
          await upsertCacheMetadata(PROMPT_VERSION, newCache.cacheName, newCache.expiresAt, null);
        }
        continue;
      }

      // Non-retryable error or max retries reached
      console.error("[GeminiCache] Generation failed:", errorMessage);
      await updateCacheError(PROMPT_VERSION, errorMessage);
      throw err;
    }
  }

  // Should never reach here, but TypeScript needs this
  throw new Error("Unexpected end of retry loop");
}

/**
 * Fallback: Generate without cache when caching is unavailable.
 */
async function generateWithoutCache(
  genai: GoogleGenAI,
  systemPrompt: string,
  dynamicInput: string
): Promise<string> {
  debugLog("Generating without cache (fallback mode)");

  const response = await genai.models.generateContent({
    model: MODEL_NAME,
    contents: [
      createUserContent([createPartFromText(`${systemPrompt}\n\n${dynamicInput}`)]),
    ],
    config: {
      responseMimeType: "application/json",
    },
  });

  const text = response.text || "";
  return stripCodeFences(text);
}

// =============================================================================
// STREAMING WITH CACHE
// =============================================================================

/**
 * Early TTS callback type - called when speak text is ready during streaming
 * Now includes optional latency tracker for marking TTS queued time
 */
export type EarlyTtsCallback = (
  speakText: string,
  behavior: string,
  latencyTracker?: LatencyTracker
) => Promise<void>;

/**
 * Generate JSON response using Gemini with cached system prompt AND streaming.
 *
 * This function combines the cost savings of caching with the latency benefits
 * of streaming. It uses generateContentStream with cachedContent to get the
 * best of both worlds.
 *
 * Note: Always uses the hardcoded SYSTEM_PROMPT for caching consistency.
 *
 * @param dynamicInput - The dynamic user input/context for this generation
 * @param onSpeakReady - Optional callback for early TTS (called when speak field is complete)
 * @param callId - Optional call ID for latency tracking
 * @returns The generated JSON response as a string
 */
export async function generateStreamingWithCachedSystem(
  dynamicInput: string,
  onSpeakReady?: EarlyTtsCallback,
  callId?: string
): Promise<string> {
  const genai = getGeminiClient();
  if (!genai) {
    throw new Error("Gemini client not configured - GEMINI_API_KEY not set");
  }

  let retryCount = 0;
  const maxRetries = 1;

  while (retryCount <= maxRetries) {
    try {
      // Get or create cache (uses hardcoded SYSTEM_PROMPT)
      const cacheName = await getOrCreateCache();

      if (!cacheName) {
        // Fallback to non-cached streaming if cache creation fails
        console.warn("[GeminiCache] Cache unavailable, falling back to non-cached streaming");
        return await generateStreamingWithoutCache(genai, SYSTEM_PROMPT, dynamicInput, onSpeakReady, callId);
      }

      // Generate with cached content + streaming
      debugLog(`Streaming with cache: ${cacheName}`);

      // Initialize latency tracker for this stream
      const latencyTracker = new LatencyTracker(MODEL_NAME, true, callId);

      // Use type assertion for cachedContent (SDK types don't include it yet)
      const response = await genai.models.generateContentStream({
        model: MODEL_NAME,
        contents: [
          createUserContent([createPartFromText(dynamicInput)]),
        ],
        config: {
          cachedContent: cacheName,
          responseMimeType: "application/json",
        },
      } as any);

      // Process stream with incremental JSON parsing
      const parser = new StreamingJsonParser();
      let fullResponse = '';
      let ttsCallbackFired = false;
      let behaviorLogged = false;

      for await (const chunk of response) {
        const text = chunk.text || '';

        // Track first chunk (TTFT - time to first token)
        latencyTracker.markFirstChunk();
        latencyTracker.addChars(text.length);

        fullResponse += text;
        parser.addChunk(text);

        // Track behavior detection
        if (!behaviorLogged && parser.hasBehavior()) {
          latencyTracker.markBehaviorDetected(parser.getBehavior());
          behaviorLogged = true;
        }

        // Check if we can trigger early TTS
        if (!ttsCallbackFired && parser.canStartTts() && onSpeakReady) {
          const speakText = parser.getSpeakText();
          const behavior = parser.getBehavior();
          if (speakText) {
            // Track speak ready
            latencyTracker.markSpeakReady(speakText.length);

            console.log('[GeminiCache:STREAM] 🚀 Speak field complete - triggering early TTS');
            try {
              await onSpeakReady(speakText, behavior, latencyTracker);
              ttsCallbackFired = true;
            } catch (callbackError) {
              console.error('[GeminiCache:STREAM] ❌ Early TTS callback failed:', callbackError);
              // Don't throw - continue processing stream
            }
          }
        }

        // Check if we should stop processing early (skip TTS behaviors)
        if (parser.shouldSkipTts() && !ttsCallbackFired) {
          debugLog(`Behavior is ${parser.getBehavior()} - no TTS needed`);
          break;
        }
      }

      // Track stream completion and log summary
      latencyTracker.markComplete(fullResponse.length);
      latencyTracker.logSummary();

      debugLog(`Streaming response complete (${fullResponse.length} chars)`);

      // Strip markdown fences if present
      return stripCodeFences(fullResponse);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Check if error is due to cache expiry/not found
      const isCacheError = errorMessage.includes("cache") &&
        (errorMessage.includes("expired") || errorMessage.includes("not found") || errorMessage.includes("invalid"));

      if (isCacheError && retryCount < maxRetries) {
        console.warn(`[GeminiCache] Cache error detected, refreshing cache (attempt ${retryCount + 1})`);
        retryCount++;

        // Force cache refresh by creating new cache
        const newCache = await createGeminiCache(SYSTEM_PROMPT);
        if (newCache) {
          await upsertCacheMetadata(PROMPT_VERSION, newCache.cacheName, newCache.expiresAt, null);
        }
        continue;
      }

      // Non-retryable error or max retries reached
      console.error("[GeminiCache] Streaming generation failed:", errorMessage);
      await updateCacheError(PROMPT_VERSION, errorMessage);
      throw err;
    }
  }

  // Should never reach here, but TypeScript needs this
  throw new Error("Unexpected end of retry loop");
}

/**
 * Fallback: Stream without cache when caching is unavailable.
 */
async function generateStreamingWithoutCache(
  genai: GoogleGenAI,
  systemPrompt: string,
  dynamicInput: string,
  onSpeakReady?: EarlyTtsCallback,
  callId?: string
): Promise<string> {
  debugLog("Streaming without cache (fallback mode)");

  // Initialize latency tracker for non-cached stream
  const latencyTracker = new LatencyTracker(MODEL_NAME, false, callId);

  const response = await genai.models.generateContentStream({
    model: MODEL_NAME,
    contents: [
      createUserContent([createPartFromText(`${systemPrompt}\n\n${dynamicInput}`)]),
    ],
    config: {
      responseMimeType: "application/json",
    },
  });

  const parser = new StreamingJsonParser();
  let fullResponse = '';
  let ttsCallbackFired = false;
  let behaviorLogged = false;

  for await (const chunk of response) {
    const text = chunk.text || '';

    // Track first chunk (TTFT)
    latencyTracker.markFirstChunk();
    latencyTracker.addChars(text.length);

    fullResponse += text;
    parser.addChunk(text);

    // Track behavior detection
    if (!behaviorLogged && parser.hasBehavior()) {
      latencyTracker.markBehaviorDetected(parser.getBehavior());
      behaviorLogged = true;
    }

    if (!ttsCallbackFired && parser.canStartTts() && onSpeakReady) {
      const speakText = parser.getSpeakText();
      const behavior = parser.getBehavior();
      if (speakText) {
        // Track speak ready
        latencyTracker.markSpeakReady(speakText.length);

        try {
          await onSpeakReady(speakText, behavior, latencyTracker);
          ttsCallbackFired = true;
        } catch (callbackError) {
          console.error('[GeminiCache:STREAM] ❌ Early TTS callback failed:', callbackError);
        }
      }
    }

    if (parser.shouldSkipTts() && !ttsCallbackFired) {
      break;
    }
  }

  // Track completion and log summary
  latencyTracker.markComplete(fullResponse.length);
  latencyTracker.logSummary();

  return stripCodeFences(fullResponse);
}

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Strip markdown code fences from response if present.
 * Handles ```json ... ``` and ``` ... ``` patterns.
 */
export function stripCodeFences(text: string): string {
  if (!text) return text;

  // Match ```json ... ``` or ``` ... ```
  const fencePattern = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;
  const match = text.trim().match(fencePattern);

  if (match) {
    return match[1].trim();
  }

  return text.trim();
}

/**
 * Debug logging helper - only logs when ENABLE_GEMINI_DEBUG is true.
 */
function debugLog(message: string): void {
  if (config.gemini.enableDebug) {
    console.log(`[GeminiCache:DEBUG] ${message}`);
  }
}

/**
 * Check if Gemini caching is available and configured.
 */
export function isGeminiCacheConfigured(): boolean {
  return !!(config.gemini.apiKey && config.supabase.url && config.supabase.serviceRoleKey);
}

/**
 * Get the prompt version constant for external reference.
 */
export function getPromptVersion(): string {
  return PROMPT_VERSION;
}

/**
 * Get cache status for debugging/monitoring.
 */
export async function getCacheStatus(): Promise<{
  configured: boolean;
  hasValidCache: boolean;
  cacheName: string | null;
  expiresAt: string | null;
  lastError: string | null;
}> {
  const configured = isGeminiCacheConfigured();

  if (!configured) {
    return {
      configured: false,
      hasValidCache: false,
      cacheName: null,
      expiresAt: null,
      lastError: null,
    };
  }

  const metadata = await readCacheMetadata(PROMPT_VERSION);

  return {
    configured: true,
    hasValidCache: isCacheValid(metadata),
    cacheName: metadata?.cache_name || null,
    expiresAt: metadata?.expires_at || null,
    lastError: metadata?.last_error || null,
  };
}
