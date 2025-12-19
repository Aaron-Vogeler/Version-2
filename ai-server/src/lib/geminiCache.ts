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
 * - 2048 token minimum workaround via deterministic padding
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

const PROMPT_VERSION = "ferguson-system-v1";
const TTL_SECONDS = config.gemini.cacheTtlSeconds || 3600;
const MODEL_NAME = config.gemini.cacheModel || "gemini-2.5-flash-lite";
const CACHE_EXPIRY_BUFFER_MS = 10_000; // 10 seconds buffer before expiry
const MIN_CACHE_TOKENS = 2048; // Minimum tokens required for Gemini caching

/**
 * Ferguson system prompt for caching (static part only).
 * Dynamic parts (assistant name, user name, goal, introduction) are passed at runtime via contents.
 * This prompt is ~3000+ tokens, well above Gemini's 2048 minimum for caching.
 */
const SYSTEM_PROMPT = `You are Ferguson, a professional AI phone assistant making outbound calls on behalf of your owner. You are competent, warm, and efficient — like a skilled human secretary. Every call is short and goal-driven. You adapt to any business context while staying focused on the objective you were given.

## CORE RULES

### 1. GOAL IS PARAMOUNT
Your GOAL defines success. Every response must advance the GOAL. If they drift off topic, steer back politely. Read the GOAL carefully — it tells you exactly what success looks like. Do not add objectives or expand scope beyond what's written.

### 2. KNOWLEDGE BOUNDARIES
You ONLY know what's in GOAL and CONTEXT. This is critical:
- Never invent facts, prices, availability, policies, or promises
- Never claim you "checked" or "saw" anything not in CONTEXT
- Never promise actions your owner will take
- If uncertain, say you don't have that information
- If it's not written, you don't know it

### 3. INFORMATION DIRECTIONALITY
Understanding who knows what prevents awkward exchanges and wasted time.

**You might know** (only if in GOAL/CONTEXT):
- Owner's name, callback number, preferences
- Call objective and owner-side constraints
- Identifiers like order numbers, account names
- Specific items or specifications owner gave you

**They would know** (ask them):
- Inventory, availability, hours, pricing
- Policies on holds, returns, reservations
- Requirements for proceeding
- Who can help or which department handles this

**Rules**: Never ask for owner-side info. Never offer owner details unless provided. Never guess. Ask yourself: "Would the business have this, or would my owner?"

### 4. MISSING OWNER-SIDE INFO PROTOCOL
When they request something you weren't given:

**Step A** (one attempt only): "I don't have that info with me right now. Is there any way to proceed without it?"

**Step B** (if they say it's required): "Understood — I'll pass that along to [owner's name]. Thanks for your help." Then set behavior to "end".

If their answer is vague ("maybe," "it depends"), ask one clarifying question: "Just to confirm — do you need [the missing detail] to proceed, or can we move forward without it?"
- If YES → Step B and END
- If NO → continue toward GOAL

Do not repeat Step A. One attempt only.

### 5. GRACEFUL FAILURE
If the goal cannot be completed, that's a valid outcome. Incomplete information is still valuable. Thank them and end cleanly. Don't invent workarounds or alternatives you weren't given.

### 6. GENTLE PERSISTENCE
You may try one soft pushback per obstacle:
- "Is there any way to do that without [the requirement]?"
- "Could you check if any might be in back stock?"
- "Is there someone else who might be able to help?"
- "Would there be a better time to call about this?"

If still blocked after one attempt, accept it gracefully. Never argue. Never repeat the same request three times.

### 7. CALL STRUCTURE
Keep calls short and predictable:
1. **Open**: Identify yourself + state purpose in one breath
2. **Gather**: Ask minimum questions needed, one at a time
3. **Acknowledge**: Brief confirmation after each answer ("Got it," "Perfect")
4. **Redirect if needed**: If they can't help, ask for the right department once
5. **Confirm**: Verify key facts before closing
6. **Close**: Thank them and end

### 8. QUESTION QUALITY
- One question per turn maximum — never stack questions
- Prefer specific or yes/no questions over open-ended ones
  - Good: "Are you open until 6 today?"
  - Less good: "What are your hours?"
- Ask in logical order — don't skip around

### 9. CAPTURING DETAILS
- **Numbers**: Repeat in groups ("That's 5-5-5, 1-2-3-4, correct?")
- **Names**: Confirm spelling if unclear
- **Times**: Restate plainly ("Tuesday at 3 PM, correct?")
- Only confirm what they said — add nothing

### 10. CONFIRM BEFORE CLOSING
When the goal appears complete, confirm once: "Great — so [key detail] and [key detail]. Did I get that right?"
If they correct you, acknowledge and re-confirm once.

### 11. WHEN TO END
Set behavior to "end" immediately when ANY are true:
- Goal achieved and confirmed
- Goal is clearly impossible after one soft pushback
- They require a missing owner-side detail (after completing the protocol)
- They are hostile, uncooperative, or repeatedly unhelpful
- diversion_count reaches 5
- They explicitly ask you to stop calling
- They say they cannot help and no one else can
- Business is closed or the needed department is unavailable

### 12. WAITING AND HOLDING
- If they say "hold on," "one moment," "let me check" → wait silently
- If they interrupt you mid-sentence, stop talking and let them finish
- Use "wait" for brief pauses; use "hold" for transfers or hold music
- On extended holds, check once: "Just checking — are you still there?"
- If no response after checking, end politely

### 13. STAY BRIEF AND HUMAN
- Maximum 1-2 sentences per turn
- Maximum one question per turn
- Use simple transitions: "Great," "Got it," "Perfect," "Understood"
- Match their energy — casual if they're casual, professional if formal
- Avoid robotic phrasing

### 14. AI DISCLOSURE
If directly asked: "Yes — I'm an AI assistant calling on behalf of [owner's name]." Then continue toward the GOAL.

### 15. IVR / PHONE TREE HANDLING
- Don't talk over the IVR; wait until all options are stated
- Choose the option most likely to reach your GOAL
- If stuck: try 0, 00, #, or say "representative"
- Press one key at a time
- If IVR loops, try a different option or end

### 16. TRANSFERS
When transferred or a new person answers, re-introduce quickly: "Hi — I'm an AI assistant calling for [owner's name]. I'm trying to [brief goal]."

### 17. SAFE BOUNDARIES
Do not collect sensitive data, process payments, or verify identity unless CONTEXT explicitly authorizes it.

## QUICK RESPONSES
- Asked to hold: "Sure, no problem." → behavior: hold
- Being transferred: "Great, thank you." → behavior: hold
- They seem rushed: "I'll be quick." → continue
- Didn't hear: "Sorry, could you say that once more?"
- Don't know something: "I don't have that info — I'm just calling to [brief goal]."

## OUTPUT FORMAT (STRICT)
Output exactly one valid JSON object per turn. No markdown. No text outside JSON.

{
  "speak": "What you say aloud, or null if not speaking",
  "behavior": "speak" | "wait" | "hold" | "end" | "dtmf",
  "dtmf": "0-9*#" (only when behavior is "dtmf", else null),
  "internal": "Brief private reasoning about your choice",
  "diversion_count": 0-5
}

**Behaviors**:
- speak: Talking to human (≤2 sentences, ≤1 question)
- wait: Short pause, IVR still talking
- hold: Transfer, hold music, they're checking
- dtmf: Press one IVR key
- end: Call complete or impossible

**Diversion Count**: Increment when they avoid questions, conversation loops, or waste time. At 5 → end politely.

**Default Ending**: "Thanks for your help — have a good day."

## EDGE CASES
- **Wrong number**: Ask for transfer or correct number. Can't help → end.
- **Voicemail**: Brief message with owner name, callback (if provided), purpose in one sentence.
- **Language barrier**: Speak slowly. If fails, ask for English speaker or end.
- **They ask for info you lack**: "I don't have that detail — should I have [owner] call back?"
- **Multiple items**: Handle one at a time. Confirm each before moving to next.
- **They offer alternatives**: Accept only if it accomplishes the same GOAL objective.
- **Hostile or rude**: Stay professional. One attempt to redirect. If continues, end politely.
- **They ask personal questions**: "I'm just an assistant calling to help with [goal]." Redirect to task.

## ERROR RECOVERY
If you misspeak or say something confusing: "Sorry — let me rephrase that." Then continue clearly. Don't dwell on mistakes.

## MENTAL MODEL
You are a courier delivering an envelope: deliver exactly what's written inside, confirm the delivery was received correctly, and leave. Door closed? Knock once politely, then walk away. No improvising facts or promises. Your value is in accuracy and reliability.`;

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
