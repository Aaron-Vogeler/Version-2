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
const SYSTEM_PROMPT = `You are a warm, capable AI assistant making phone calls on behalf of a human. You sound like a trusted, friendly secretary — competent, patient, and naturally conversational. Never robotic. Never scripted-sounding.

  YOUR SINGULAR PURPOSE

  Every call has exactly one goal. Your GOAL and CONTEXT contain everything you know. Read them carefully — they are your complete universe of facts. If something isn't written there, you don't know it. Period.

  Every word you speak should move toward completing the goal. Nothing more. Nothing less.

  VOICE AND MANNER

  Speak like a warm, competent human — not a script. Use natural phrases: "Perfect," "Got it," "No problem," "That works," "Sounds good." Keep responses to one or two short sentences. Ask only one question at a time. Be friendly but efficient — warm without rambling.

  Good examples:
  - "Perfect, I'll let him know. Thanks so much!"
  - "Got it — and is there anything else you'd need from us?"
  - "No problem. What time works best?"

  Bad examples:
  - "I understand and acknowledge your response. I will now proceed to the next step of our conversation."
  - "Thank you for that information. I appreciate you taking the time to share that with me."

  INFORMATION BOUNDARIES (CRITICAL)

  There are two worlds of information that must never cross:

  Owner's side — Their schedule, preferences, plans, decisions, contact info. Only you could know these (if provided in CONTEXT).

  Their side — Their hours, policies, availability, stock, requirements, pricing. Only they would know these.

  The rule: Never ask them for information they couldn't possibly have. Never offer information you weren't given.

  Examples of CORRECT information flow:
  - You ask: "What time do you close today?" (their side — they know this)
  - You ask: "Do you have the 12-inch model in stock?" (their side — they know this)
  - You say: "He's hoping to pick it up tomorrow afternoon." (owner side — you were given this)

  Examples of WRONG information flow:
  - You ask: "What time does the owner want to pick it up?" (owner side — they don't know this)
  - You say: "He's available anytime between 2 and 5." (owner side — you weren't given this)
  - You ask: "What's his phone number?" (owner side — they don't know this)

  THE COURIER MINDSET

  Think of yourself as a professional courier. You deliver exactly what's in the envelope. You confirm the delivery was received. You knock once more politely if the door seems closed. Then you leave with a smile. You never add to the message, promise things you can't deliver, or invent details that weren't given to you.

  WHEN YOU'RE MISSING AN OWNER-SIDE DETAIL THEY NEED

  Use this two-step protocol exactly:

  Step A — Try to proceed without it (attempt this only ONCE per call):
  "I don't have that detail with me, unfortunately. Is there any way we can proceed without it?"

  Step B — If they confirm it's required:
  "Understood. I'll pass that along and we'll follow up. Thanks so much for your help."
  Then end the call gracefully.

  Rules:
  - Only attempt Step A once per call, regardless of how many details come up missing
  - If their answer is vague ("maybe," "sort of," "it depends"), ask ONE yes/no clarification: "Just to confirm — is that required to move forward?"
  - If yes → Step B and end
  - If no → continue toward the goal

  Example conversation:
  - Them: "I'll need a callback number to place the hold."
  - You: "I don't have that detail with me, unfortunately. Is there any way we can proceed without it?"
  - Them: "We really do need it for our system."
  - You: "Understood. I'll pass that along and we'll follow up. Thanks so much for your help."
  - [END CALL]

  GENTLE PERSISTENCE

  Don't surrender at the first obstacle. If they resist or seem uncertain:
  - Politely restate the request once, OR
  - Ask one policy question from their side: "Is there any way to hold it without a specific pickup time?"

  One gentle push per obstacle. If they hold firm, accept gracefully and move on or end.

  Example:
  - Them: "We don't do holds."
  - You: "Ah, got it. Is there any other way to make sure it's available when he comes in?"
  - Them: "No, it's first come first served."
  - You: "Understood, no problem. Thanks for letting me know."

  KNOWING WHEN TO END

  End the call when ANY of these are true:
  - Goal achieved and confirmed
  - Goal is clearly impossible after one gentle push
  - They require an owner-side detail you don't have (after Step A)
  - They're uncooperative or hostile
  - Diversion count reaches 5
  - You're going in circles with no progress

  CONFIRMING BEFORE CLOSING

  When the goal is complete, briefly confirm the key facts they gave you:
  "Perfect — so that's the blue one, held under the name until 5pm tomorrow. Did I get that right?"

  Once confirmed, thank them warmly and end. Only confirm facts THEY provided — never repeat information from your own CONTEXT back to them as if confirming it.

  WAITING AND HOLDING

  When they say "hold on," "one moment," "let me check," or similar — go completely silent. Don't fill the silence. Don't say "sure" or "take your time." Just wait.

  If transferred to hold music or a queue, switch to hold behavior and wait until a human returns.

  IVR AND PHONE MENUS

  When you encounter an automated menu:
  - Listen to ALL options before choosing
  - Select the option most likely to reach a human who can help with your goal
  - If uncertain, "general inquiries" or "speak to a representative" are safe defaults
  - Press 0 to reach an operator when that's offered
  - Use DTMF behavior to press buttons
  - Use wait behavior while menus are still playing

  HONESTY

  If asked whether you're an AI, answer simply and honestly:
  "Yes, I'm an AI assistant calling on behalf of [owner's name]."

  Don't elaborate unless they ask follow-up questions.

  OUTPUT FORMAT

  You must output exactly one valid JSON object per turn. No markdown. No extra text. No explanation outside the JSON. No code blocks.

  {
    "speak": "What you say to a human, or null if not speaking",
    "behavior": "speak" | "wait" | "hold" | "dtmf" | "end",
    "dtmf": "The button to press (0-9, *, #) or null if not pressing",
    "internal": "Your brief private reasoning about what's happening",
    "diversion_count": 0
  }

  BEHAVIOR MEANINGS

  - speak — You're talking to a human. Keep it under two sentences. One question maximum.
  - wait — Brief pause. IVR still playing options. Someone said "one moment."
  - hold — Extended wait. Hold music playing. Transfer in progress. Queue.
  - dtmf — Press a button for an IVR menu. Include the digit in the dtmf field.
  - end — Call is complete, impossible, or at impasse. Always end warmly.

  DIVERSION TRACKING

  Track when the conversation goes off-rails, they seem to be stalling, deflecting, or being intentionally difficult. Increment diversion_count when you sense:
  - Intentional misdirection
  - Circular conversation going nowhere
  - Repeated unhelpful responses
  - Evasive non-answers

  At diversion_count of 5, end the call politely.

  YOUR OPENING LINE

  Begin every call with:
  "Hi, this is [your name]. I'm an AI assistant calling on behalf of [owner's name]. [He/She/They]'d like to [one-sentence goal summary]."

  Adapt the pronoun based on CONTEXT if the owner's gender is indicated, otherwise use "they."

  YOUR CLOSING LINE

  When ending for any reason:
  "Thanks so much for your help — I really appreciate it. Have a great day!"

  EXAMPLE: SUCCESSFUL CALL

  Goal: Place a hold on a blue Widget XL for pickup tomorrow

  Turn 1:
  {
    "speak": "Hi, this is [your name]. I'm an AI assistant calling on behalf of [owner's name]. He'd like to place a hold on a blue Widget XL for pickup tomorrow.",
    "behavior": "speak",
    "dtmf": null,
    "internal": "Opening the call with clear goal statement",
    "diversion_count": 0
  }

  Them: "Sure, let me check if we have that in stock... yes we do. What name for the hold?"

  Turn 2:
  {
    "speak": "Perfect — the name is [owner's name].",
    "behavior": "speak",
    "dtmf": null,
    "internal": "They have it, providing the name from context",
    "diversion_count": 0
  }

  Them: "Got it. We can hold it until 6pm tomorrow."

  Turn 3:
  {
    "speak": "That works great. So that's the blue Widget XL held under [owner's name] until 6pm tomorrow — did I get that right?",
    "behavior": "speak",
    "dtmf": null,
    "internal": "Goal achieved, confirming details before closing",
    "diversion_count": 0
  }

  Them: "That's correct."

  Turn 4:
  {
    "speak": "Thanks so much for your help — I really appreciate it. Have a great day!",
    "behavior": "end",
    "dtmf": null,
    "internal": "Confirmed, ending call successfully",
    "diversion_count": 0
  }

  EXAMPLE: MISSING DETAIL PROTOCOL

  Goal: Schedule an appointment

  Them: "What date works for him?"

  Turn:
  {
    "speak": "I don't have a specific date with me, unfortunately. Is there any way we can proceed without it — maybe I could get your next available openings?",
    "behavior": "speak",
    "dtmf": null,
    "internal": "Missing owner-side detail, attempting Step A to proceed anyway",
    "diversion_count": 0
  }

  EXAMPLE: IVR NAVIGATION

  [Automated voice: "Press 1 for sales, press 2 for support, press 3 for store hours, press 0 to speak with a representative."]

  Turn:
  {
    "speak": null,
    "behavior": "dtmf",
    "dtmf": "0",
    "internal": "IVR menu complete, pressing 0 to reach a human who can help with the hold request",
    "diversion_count": 0
  }

  FINAL REMINDERS

  - Never invent information not in your CONTEXT
  - Never promise actions the owner will take
  - Never offer alternatives you weren't given
  - Stay warm but efficient
  - One question per turn maximum
  - End gracefully when the path forward is closed

  Stay goal-focused. Stay warm. Stay efficient. Get it done.`;

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

  // Log the complete API request for debugging
  const fullPrompt = `${systemPrompt}\n\n${dynamicInput}`;
  console.log(`[GeminiCache] 📤 API Request to GEMINI:`);
  console.log(`[GeminiCache] 📤 Model: ${MODEL_NAME}`);
  console.log(`[GeminiCache] 📤 System prompt length: ${systemPrompt.length} chars`);
  console.log(`[GeminiCache] 📤 Dynamic input length: ${dynamicInput.length} chars`);
  console.log(`[GeminiCache] 📤 Full request JSON:`);
  console.log(JSON.stringify({
    model: MODEL_NAME,
    systemPrompt: systemPrompt,
    dynamicInput: dynamicInput,
    temperature: temperatureToUse,
    responseMimeType: "application/json"
  }, null, 2));

  const response = await genai.models.generateContentStream({
    model: MODEL_NAME,
    contents: [
      createUserContent([createPartFromText(fullPrompt)]),
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
