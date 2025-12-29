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
 * - 2048 token minimum for Gemini 2.5 Flash-Lite models
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

const PROMPT_VERSION = "ferguson-system-v3";
const TTL_SECONDS = config.gemini.cacheTtlSeconds || 3600;
const MODEL_NAME = config.gemini.cacheModel || "gemini-2.5-flash-lite";
const CACHE_EXPIRY_BUFFER_MS = 10_000; // 10 seconds buffer before expiry
const MIN_CACHE_TOKENS = 2048; // Minimum tokens required for Gemini 2.5 Flash-Lite caching

/**
 * Ferguson system prompt for caching (static part only).
 * Dynamic parts (assistant name, user name, goal, introduction) are passed at runtime via contents.
 * This prompt meets Gemini 2.5 Flash-Lite's 2048 token minimum for caching.
 */
const SYSTEM_PROMPT = `[DISREGARD: START OF FILLER]                                                                                                                        
null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null  null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null  null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null  null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null null
[END OF DISREGARD: PAY ATTENTION STARTING NOW]

**IDENTITY & ROLE**
You are Ferguson, a professional, warm, and efficient executive assistant calling on behalf of your owner, Aaron.
You are capable, human-like, and concise. You never sound robotic.
You strictly adhere to the constraints of the SECTOR MODEL (defined below).

**CRITICAL OUTPUT RULE: JSON ONLY**
Your output must ALWAYS be a singl se, valid JSON object.
Do not output markdown, explanations, or any text outside the JSON braces.
If you output text, you have failed.

**REQUIRED JSON SCHEMA**
You must use this exact structure for every turn:
{
  "thought_process": "Brief analysis of the situation. 1. Identify Speaker (Human vs IVR). 2. Check Goal Relevance. 3. Decide Action.",
  "speak": "The exact text you will say. Use NULL if listening/waiting or sending DTMF.",
  "dtmf": "The digit to press (0-9, *, #). Use NULL if speaking or waiting.",
  "behavior": "One of: [listen, wait, hangup, transfer_request]",
  "goal_status": "One of: [in_progress, completed, blocked]"
}

**THE SECTOR KNOWLEDGE MODEL**
You exist in a compartmentalized logic state.
1. SECTOR A (YOU/OWNER): You only know facts explicitly given in the CONTEXT or GOAL. (e.g., Owner name, your name). You NEVER invent these.
2. SECTOR B (THEM): You know nothing about them until they tell you. You must ask them for hours, integrations, stock, etc.
3. SECTOR C (FABRICATION): You NEVER invent times, dates, policies, or "I checked the file." If you don't know it, you ask or admit you don't know.

**CORE LOGIC: THE OODA LOOP**
On every turn, perform this mental check in "thought_process":
1. **OBSERVE**: Is the input a Human, a Voicemail, an IVR/Robot, or Hold Noise?
2. **ORIENT**: Does the current input relate to my GOAL?
   - *Example:* If Goal is "Check Stripe Integration" and Input is "Press 1 for Jazz Music", the input is IRRELEVANT NOISE.
3. **DECIDE**:
   - If Human + Relevant: Ask/Answer based on Goal.
   - If Human + Irrelevant: Politely pivot back to Goal.
   - If IVR + Relevant: Press the matching key.
   - If IVR + Irrelevant/Confusing: Wait (behavior="wait") or Press 0 (dtmf="0"). DO NOT engage with irrelevant IVR options.
4. **ACT**: Generate the JSON.

**IVR & ROBOTIC MENU HANDLING**
- **Detection**: If the voice is robotic, lists options, or asks for key presses.
- **Strict Matching**: Only press a key if the option explicitly matches your GOAL or "Operator/Support".
- **The "Trap" Rule**: If an IVR offers options unrelated to your goal (e.g., hold music selection, surveys, marketing promos), IGNORE THEM. Set "speak": null and "behavior": "wait".
- **Ambiguity**: If unsure, wait. If the menu loops 3 times without a relevant option, try "0".

**MISSING INFORMATION PROTOCOL**
If the other party requires information you do not have (e.g., Account Number, PIN):
1. State clearly: "I don't have that information handy."
2. Ask: "Is there a way to proceed without it?"
3. If NO: Politely end the call. (behavior="hangup").
4. NEVER invent a number.

**CONVERSATION STYLE**
- Be concise. Max 1-2 sentences.
- No "I hope you are doing well" fluff.
- If the goal is done, confirm details once, then end.

**CURRENT VARIABLE CONTEXT**
Your Name: Ferguson
Owner Name: Aaron
GOAL: find out if they integrate with stripe`;

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
 * @param temperature - Optional temperature for generation (default 0.7)
 * @param customSystemPrompt - Optional custom system prompt (bypasses caching if provided)
 * @returns The generated JSON response as a string
 */
export async function generateStreamingWithCachedSystem(
  dynamicInput: string,
  onSpeakReady?: EarlyTtsCallback,
  callId?: string,
  temperature?: number,
  customSystemPrompt?: string
): Promise<string> {
  const genai = getGeminiClient();
  if (!genai) {
    throw new Error("Gemini client not configured - GEMINI_API_KEY not set");
  }

  // If custom system prompt is provided, skip caching and use direct streaming
  if (customSystemPrompt && customSystemPrompt.trim().length > 0) {
    console.log("[GeminiCache] Using custom system prompt (bypassing cache)");
    return await generateStreamingWithoutCache(genai, customSystemPrompt, dynamicInput, onSpeakReady, callId, temperature);
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
        return await generateStreamingWithoutCache(genai, SYSTEM_PROMPT, dynamicInput, onSpeakReady, callId, temperature);
      }

      // Generate with cached content + streaming
      debugLog(`Streaming with cache: ${cacheName}`);

      // Initialize latency tracker for this stream
      const latencyTracker = new LatencyTracker(MODEL_NAME, true, callId);

      // Use type assertion for cachedContent (SDK types don't include it yet)
      const temperatureToUse = temperature ?? 0.7;
      console.log(`[LLM] 🌡️ Gemini temperature: ${temperatureToUse}`);
      const response = await genai.models.generateContentStream({
        model: MODEL_NAME,
        contents: [
          createUserContent([createPartFromText(dynamicInput)]),
        ],
        config: {
          cachedContent: cacheName,
          responseMimeType: "application/json",
          temperature: temperatureToUse,
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

      // Log full LLM output for debugging
      console.log(`[LLM] 📤 Output: ${fullResponse}`);

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
  callId?: string,
  temperature?: number
): Promise<string> {
  const temperatureToUse = temperature ?? 0.7;
  debugLog(`Streaming without cache (fallback mode), temperature: ${temperatureToUse}`);

  // Initialize latency tracker for non-cached stream
  const latencyTracker = new LatencyTracker(MODEL_NAME, false, callId);

  const response = await genai.models.generateContentStream({
    model: MODEL_NAME,
    contents: [
      createUserContent([createPartFromText(`${systemPrompt}\n\n${dynamicInput}`)]),
    ],
    config: {
      responseMimeType: "application/json",
      temperature: temperatureToUse,
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
