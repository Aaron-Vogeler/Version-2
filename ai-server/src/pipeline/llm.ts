import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import config from "../config";
import * as contextMgr from "../callContextManager";
import { insertLlmLog, insertUsageCostLog, calculateXaiCost, calculateGroqCost } from "../utils/supabase";
import {
  buildClassificationPrompt,
  parseClassificationResponse,
  type ReceiverClassification,
} from "./humanDetection";
import { StreamingJsonParser } from "./streamingJsonParser";
import {
  generateJsonWithCachedSystem,
  generateStreamingWithCachedSystem,
  isGeminiCacheConfigured,
  stripCodeFences,
  type EarlyTtsCallback as CacheEarlyTtsCallback,
} from "../lib/geminiCache";
import { LatencyTracker } from "../lib/latencyLogger";

// Create Groq client configured with API key and base URL
const groq = new OpenAI({
  apiKey: config.groq.apiKey,
  baseURL: "https://api.groq.com/openai/v1",
});

// Create xAI client (lazy initialized when API key is available)
let xai: OpenAI | null = null;
if (config.xai.apiKey) {
  xai = new OpenAI({
    apiKey: config.xai.apiKey,
    baseURL: config.xai.baseUrl,
  });
}

// Create Gemini client (lazy initialized when API key is available)
let gemini: GoogleGenerativeAI | null = null;
if (config.gemini.apiKey) {
  gemini = new GoogleGenerativeAI(config.gemini.apiKey);
}

/**
 * Check if a model is a Gemini model (requires streaming support)
 */
function isGeminiModel(model: string): boolean {
  return model.includes('gemini') || model.startsWith('models/gemini');
}

/**
 * Check if a model is a Grok/xAI model
 */
function isGrokModel(model: string): boolean {
  return model.includes('grok');
}

/**
 * Re-export CallContext from the context manager for backward compatibility.
 */
export type CallContext = contextMgr.CallContext;

/**
 * Build the system prompt dynamically, optionally injecting call goal context.
 * Uses variable keys: {ASSISTANT_NAME}, {USER_NAME} for placeholder replacement.
 * Goal is always injected at the bottom in format: CALL GOAL (YOUR ONLY MISSION): "{goal}"
 * @param context - Optional call context with goal, assistantName, userName, and systemPrompt
 * @returns The complete system prompt
 */
function buildSystemPrompt(context?: CallContext): string {
  // Use systemPrompt from context (passed from frontend), fall back to config (for backwards compat)
  let prompt = context?.systemPrompt || config.llm.systemPrompt;

  // If no prompt available, return empty (should not happen in normal flow)
  if (!prompt) {
    console.warn("[LLM] No system prompt available - neither from context nor config");
    prompt = "";
  }

  // Get names from context or use defaults
  const assistantName = context?.assistantName || "Ferguson";
  const userName = context?.userName || "Aaron";

  // Replace variable keys {ASSISTANT_NAME} and {USER_NAME}
  prompt = prompt.replace(/\{ASSISTANT_NAME\}/g, assistantName);
  prompt = prompt.replace(/\{USER_NAME\}/g, userName);

  // Also replace ASSISTANT_NAME and USER_NAME without curly braces (common mistake)
  prompt = prompt.replace(/ASSISTANT_NAME/g, assistantName);
  prompt = prompt.replace(/USER_NAME/g, userName);

  // Also replace legacy hardcoded names for backwards compatibility
  prompt = prompt.replace(/Ferguson/g, assistantName);
  prompt = prompt.replace(/ferguson/g, assistantName.toLowerCase());
  prompt = prompt.replace(/Aaron/g, userName);

  // Inject additional context if provided (right above the goal)
  if (context?.additionalContext) {
    prompt += `

ADDITIONAL CONTEXT:
${context.additionalContext}`;
  }

  // Inject goal at the bottom in simple format
  if (context?.goal) {
    prompt += `

CALL GOAL (YOUR ONLY MISSION): "${context.goal}"`;
  }

  return prompt;
}

/**
 * Build dynamic input for cached Gemini calls.
 * Combines dynamic variables, conversation context (rolling summary, recent turns) into a single string.
 * The system prompt is cached separately, so this only includes the dynamic parts.
 *
 * @param messages - The full message array (includes system, summary, turns)
 * @param currentUserText - The current user input
 * @param context - Call context with goal, assistantName, userName
 * @returns Formatted dynamic input string
 */
function buildDynamicInputForCache(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  currentUserText: string,
  context?: CallContext
): string {
  const parts: string[] = [];

  // Add dynamic variables and introduction template (these are NOT in the cached system prompt)
  // These should come from the dashboard - warn if using defaults
  const assistantName = context?.assistantName;
  const userName = context?.userName;
  const goal = context?.goal || "assist with your request";

  if (!assistantName) {
    console.warn("[LLM] ⚠️ assistantName not provided in context - AI may not introduce itself correctly");
  }
  if (!userName) {
    console.warn("[LLM] ⚠️ userName not provided in context - AI may not mention owner correctly");
  }

  console.log(`[LLM] 📝 Dynamic variables: assistantName="${assistantName}", userName="${userName}", goal="${goal}"`);

  parts.push(`VARIABLES (FOR THIS CALL)

Your name: ${assistantName}
Your owner's name: ${userName}

INTRODUCTION TEMPLATE
When applicable (i.e. if you haven't been prompted to provide a DTMF tone), begin calls with:
"Hi, this is [your name]. I'm an AI assistant calling on behalf of [owner's name]. He wants to [summarize goal in 1 sentence]."

GOAL FOR THIS CALL
${goal}`);

  // Skip system message (index 0) - it's cached
  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      // Check if this is the rolling summary
      if (msg.content.startsWith("CALL CONTEXT SUMMARY:")) {
        parts.push(msg.content);
      } else {
        parts.push(`Caller: ${msg.content}`);
      }
    } else if (msg.role === "assistant") {
      parts.push(`Assistant: ${msg.content}`);
    }
  }

  return parts.join("\n\n");
}

/**
 * Generate a rolling summary of the call by calling the LLM.
 * This is called periodically as new turns accumulate.
 * @param callId - The call ID
 * @param config_override - Optional context configuration
 * @returns The updated summary, or existing summary if generation fails
 */
export async function generateRollingSummary(
  callId: string,
  config_override?: contextMgr.ContextConfig
): Promise<string> {
  const config_params = config_override || contextMgr.DEFAULT_CONFIG;
  const context = contextMgr.getContext(callId);
  if (!context) {
    console.warn(`[${callId}] Cannot generate summary: context not found`);
    return "";
  }

  const newTurns = contextMgr.getNewTurnsForSummary(callId);
  if (newTurns.length === 0) {
    console.log(`[${callId}] No new turns to summarize`);
    return context.rollingSummary;
  }

  const turnsText = contextMgr.formatTurnsForSummary(newTurns);
  const existingSummary = context.rollingSummary || "(empty)";

  // Use rolling summary prompt from context (if provided), otherwise fall back to config
  // Replace placeholders: {EXISTING_SUMMARY}, {TURNS_TEXT}, {MAX_TOKENS}
  const summaryPromptTemplate = context.rollingSummaryPrompt || config.llm.rollingSummaryPrompt;
  const summaryPrompt = summaryPromptTemplate
    .replace(/\{EXISTING_SUMMARY\}/g, existingSummary)
    .replace(/\{TURNS_TEXT\}/g, turnsText)
    .replace(/\{MAX_TOKENS\}/g, String(config_params.maxSummaryTokensHint));

  try {
    console.log(`[${callId}] Generating rolling summary...`);
    // Use configurable system message from config
    const summarySystemContent = config.llm.rollingSummarySystemMessage;
    const summaryMessages: Array<{ role: "system" | "user"; content: string }> = [
      { role: "system", content: summarySystemContent },
      { role: "user", content: summaryPrompt },
    ];

    const startTime = Date.now();
    // Use model from context if available, otherwise fall back to config
    const modelToUse = context.model || config.groq.model;
    const response = await groq.chat.completions.create({
      model: modelToUse,
      messages: summaryMessages,
      temperature: 0.2, // Lower temperature for consistency
      max_tokens: config_params.maxSummaryTokensHint,
    });
    const latencyMs = Date.now() - startTime;

    const newSummary = response.choices[0]?.message?.content || "";

    // Log the LLM interaction to database for live visibility
    insertLlmLog({
      call_id: callId,
      request_type: "summary",
      model: modelToUse,
      temperature: 0.2,
      max_tokens: config_params.maxSummaryTokensHint,
      system_prompt: summarySystemContent,
      messages: summaryMessages,
      user_input: summaryPrompt,
      assistant_response: newSummary,
      rolling_summary: existingSummary,
      recent_turns_count: newTurns.length,
      prompt_tokens: response.usage?.prompt_tokens,
      completion_tokens: response.usage?.completion_tokens,
      total_tokens: response.usage?.total_tokens,
      latency_ms: latencyMs,
    }).catch((err) => {
      console.error(`[${callId}] Failed to log LLM summary:`, err);
    });

    if (!newSummary) {
      console.warn(`[${callId}] LLM returned empty summary`);
      return context.rollingSummary;
    }

    console.log(`[${callId}] Summary updated (${newSummary.length} chars)`);
    return newSummary;
  } catch (error) {
    console.error(
      `[${callId}] Failed to generate rolling summary:`,
      error instanceof Error ? error.message : error
    );
    // Return existing summary on error (resilient fallback)
    return context.rollingSummary;
  }
}

/**
 * Check if we should update the summary and do so if needed.
 * Call this after processing each turn.
 * @param callId - The call ID
 * @param config_override - Optional context configuration
 */
export async function maybeUpdateSummaryForCall(
  callId: string,
  config_override?: contextMgr.ContextConfig
): Promise<void> {
  const config_params = config_override || contextMgr.DEFAULT_CONFIG;

  if (!contextMgr.shouldUpdateSummary(callId, config_params)) {
    return;
  }

  const newSummary = await generateRollingSummary(callId, config_params);
  const context = contextMgr.getContext(callId);
  if (context) {
    contextMgr.updateSummary(callId, newSummary, context.turns.length - 1);
  }
}

/**
 * Call Groq LLM with user text and return the AI response.
 * Includes rolling summary and recent turns for rich per-call context.
 * @param userText - The user's input text
 * @param context - Call context with goal, call ID, and other metadata
 * @returns The AI-generated response, or an empty string if no response
 */
/**
 * Detect if the caller is an IVR/robotic system or a human.
 * Used at the start of calls to adjust call control settings appropriately.
 * @param transcriptText - The transcript text to analyze
 * @param callId - Optional call ID for logging
 * @returns true if it sounds like an IVR/AI system, false if it sounds like a human
 */
export async function detectPartyType(
  transcriptText: string,
  callId?: string
): Promise<boolean> {
  const systemPrompt = `You are analyzing phone call transcripts to determine if the speaker is an automated IVR/AI system or a human.

IVR/AI indicators:
- Menu prompts like "Press 1 for...", "For sales, press..."
- Recorded greetings: "Thank you for calling...", "Your call is important to us"
- Hold messages: "Please hold", "Your estimated wait time is..."
- Robotic/scripted speech patterns
- Standard automated responses

Human indicators:
- Natural conversational patterns
- Personal introductions: "Hi, this is John", "How can I help you?"
- Conversational filler words and natural pauses
- Responsive dialogue, questions about the caller's needs
- Informal or varied speech patterns

Respond with ONLY "True" if this sounds like an IVR/AI/robotic system, or "False" if this sounds like a human. No other text.`;

  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Analyze this transcript:\n"${transcriptText}"\n\nIs this an IVR/AI system? Respond only with True or False.` },
  ];

  try {
    const startTime = Date.now();
    const response = await groq.chat.completions.create({
      model: config.groq.model, // Use fast model for quick detection
      messages,
      temperature: 0.1, // Low temperature for consistent responses
      max_tokens: 10, // We only need "True" or "False"
    });
    const latencyMs = Date.now() - startTime;

    const result = response.choices[0]?.message?.content?.trim().toLowerCase() || "";
    const isRobotic = result === "true" || result.startsWith("true");

    console.log(`[PARTY-DETECT] 🔍 Detection result: ${isRobotic ? "ROBOTIC/IVR" : "HUMAN"} (response: "${result}", latency: ${latencyMs}ms)`);

    // Log the LLM interaction for debugging
    if (callId) {
      insertLlmLog({
        call_id: callId,
        request_type: "party_detection",
        model: config.groq.model,
        temperature: 0.1,
        max_tokens: 10,
        system_prompt: systemPrompt,
        messages: messages,
        user_input: transcriptText,
        assistant_response: result,
        prompt_tokens: response.usage?.prompt_tokens,
        completion_tokens: response.usage?.completion_tokens,
        total_tokens: response.usage?.total_tokens,
        latency_ms: latencyMs,
      }).catch((err) => {
        console.error(`[${callId}] Failed to log party detection:`, err);
      });
    }

    return isRobotic;
  } catch (error) {
    console.error(
      `[PARTY-DETECT] ❌ Detection failed, defaulting to human:`,
      error instanceof Error ? error.message : error
    );
    // Default to human on error (more conservative - use normal timing)
    return false;
  }
}

/**
 * Classify the receiver as human, IVR, or unsure using LLM.
 * This is the enhanced version that returns structured classification with confidence.
 * @param transcriptText - The transcript text to analyze
 * @param callId - Optional call ID for logging
 * @param customPrompt - Optional custom prompt template (uses {{TRANSCRIPT}} placeholder)
 * @param customModel - Optional model to use for classification (defaults to config.groq.model)
 * @returns Classification result with receiver type, confidence, and reason
 */
export async function classifyReceiver(
  transcriptText: string,
  callId?: string,
  customPrompt?: string | null,
  customModel?: string | null
): Promise<ReceiverClassification> {
  const prompt = buildClassificationPrompt(transcriptText, customPrompt);
  const modelToUse = customModel || config.groq.model;

  const systemPrompt = `You are an expert at analyzing phone call transcripts to determine if the speaker is a human or an automated IVR system. You must respond with ONLY valid JSON in the exact format specified. Do not include any other text.`;

  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];

  // Determine which client to use based on model
  const useXai = isGrokModel(modelToUse) && xai;
  const client = useXai ? xai! : groq;

  try {
    const startTime = Date.now();
    console.log(`[RECEIVER-CLASSIFY] 🔍 Using model: ${modelToUse} (${useXai ? 'xAI' : 'Groq'})`);
    const response = await client.chat.completions.create({
      model: modelToUse,
      messages,
      temperature: 0.1, // Low temperature for consistent classification
      max_tokens: 100, // Enough for JSON response
    });
    const latencyMs = Date.now() - startTime;

    const rawResponse = response.choices[0]?.message?.content?.trim() || "";
    const classification = parseClassificationResponse(rawResponse);

    console.log(
      `[RECEIVER-CLASSIFY] 🔍 Classification result: ${classification.receiver.toUpperCase()} ` +
      `(model: ${modelToUse}, confidence: ${classification.confidence?.toFixed(2) ?? "N/A"}, ` +
      `reason: "${classification.reason || "none"}", latency: ${latencyMs}ms)`
    );

    // Extract token usage
    const usage = response.usage;
    const promptTokens = usage?.prompt_tokens || 0;
    const completionTokens = usage?.completion_tokens || 0;
    const totalTokens = usage?.total_tokens || 0;
    const cachedTokens = (usage as any)?.prompt_tokens_details?.cached_tokens || 0;

    // Log detailed token usage for Grok models
    if (useXai && usage) {
      console.log(
        `[RECEIVER-CLASSIFY] 🤖 Grok usage: prompt=${promptTokens}, completion=${completionTokens}, ` +
        `total=${totalTokens}, cached=${cachedTokens}`
      );
    }

    // Log the LLM interaction for debugging
    if (callId) {
      insertLlmLog({
        call_id: callId,
        request_type: "receiver_classification",
        model: modelToUse,
        temperature: 0.1,
        max_tokens: 100,
        system_prompt: systemPrompt,
        messages: messages,
        user_input: transcriptText,
        assistant_response: rawResponse,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        latency_ms: latencyMs,
      }).catch((err) => {
        console.error(`[${callId}] Failed to log receiver classification:`, err);
      });

      // Log usage cost
      if (usage) {
        const cost = useXai
          ? calculateXaiCost(promptTokens, completionTokens, modelToUse, cachedTokens)
          : calculateGroqCost(promptTokens, completionTokens, modelToUse);

        insertUsageCostLog({
          call_id: callId,
          provider: useXai ? "xai" : "groq",
          service_type: "llm",
          model: modelToUse,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
          cached_tokens: cachedTokens > 0 ? cachedTokens : undefined,
          cost_usd: cost,
          request_type: "receiver_classification",
          metadata: cachedTokens > 0 ? { cached_tokens: cachedTokens } : undefined,
        }).catch((err) => {
          console.error(`[${callId}] Failed to log classification cost:`, err);
        });
      }
    }

    return classification;
  } catch (error) {
    console.error(
      `[RECEIVER-CLASSIFY] ❌ Classification failed:`,
      error instanceof Error ? error.message : error
    );
    // Default to unsure on error - this will trigger additional checks
    return { receiver: "unsure", reason: "LLM call failed" };
  }
}

/**
 * Early TTS callback type - called when speak text is ready during streaming
 * Includes optional latency tracker for end-to-end timing measurements
 */
export type EarlyTtsCallback = (
  speakText: string,
  behavior: string,
  latencyTracker?: LatencyTracker
) => Promise<void>;

/**
 * Generate an assistant reply using either streaming (Gemini) or buffered (Groq/other) mode.
 * When using Gemini models, enables streaming and calls onSpeakReady as soon as speak text is available.
 *
 * @param userText - The user's input text
 * @param context - Call context with goal, call ID, and other metadata
 * @param onSpeakReady - Optional callback for early TTS (called during streaming when speak field is complete)
 * @returns The complete AI-generated response
 */
export async function generateAssistantReply(
  userText: string,
  context?: CallContext,
  onSpeakReady?: EarlyTtsCallback
): Promise<string> {
  const callContext = context?.callId ? contextMgr.getContext(context.callId) : null;
  const modelToUse = callContext?.model || config.groq.model;
  const useStreaming = isGeminiModel(modelToUse);

  // Build system prompt
  const systemPrompt = buildSystemPrompt(context);
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  let rollingSummary: string | undefined;
  let recentTurnsCount = 0;

  // Add rolling summary if available and non-empty
  if (context?.callId) {
    const contextData = contextMgr.getContext(context.callId);
    if (contextData?.rollingSummary) {
      rollingSummary = contextData.rollingSummary;
      messages.push({
        role: "user",
        content: `CALL CONTEXT SUMMARY:\n${contextData.rollingSummary}`,
      });
    }

    // Add recent turns from the sliding window
    const recentTurns = contextMgr.getRecentTurns(context.callId, 12);
    recentTurnsCount = recentTurns.length;
    const recentMessages = contextMgr.formatTurnsAsMessages(recentTurns);
    messages.push(...recentMessages);
  } else {
    // No context available - add raw userText as fallback
    messages.push({ role: "user", content: userText });
  }

  const startTime = Date.now();
  const temperatureToUse = callContext?.temperature ?? 0.7;
  const maxTokensToUse = callContext?.maxTokens ?? 1024;
  const topPToUse = callContext?.topP ?? 1.0;
  const reasoningToUse = callContext?.reasoning || 'medium';
  const jsonModeToUse = callContext?.jsonMode || false;

  // Route to appropriate provider based on model
  if (useStreaming && gemini) {
    // Check if custom prompt mode is enabled (per-call setting from dashboard, or global config fallback)
    const useCustomGeminiPrompt = callContext?.geminiUseCustomPrompt ?? config.gemini.useCustomPrompt;
    if (useCustomGeminiPrompt) {
      // Estimate tokens that would have been cached (rough estimate: ~4 chars per token)
      const estimatedCacheTokens = Math.round(systemPrompt.length / 4);
      console.log(`[LLM] 📝 Custom prompt mode enabled - bypassing Gemini cache`);
      console.log(`[LLM] 📊 Dropped caching tokens (estimate): ~${estimatedCacheTokens} tokens (${systemPrompt.length} chars)`);

      // Use regular Gemini streaming with custom system prompt, passing isCustomPromptMode=true
      return await generateWithGeminiStreaming(
        modelToUse,
        messages,
        temperatureToUse,
        maxTokensToUse,
        topPToUse,
        context,
        userText,
        rollingSummary,
        recentTurnsCount,
        startTime,
        onSpeakReady,
        true  // isCustomPromptMode - enables dropped cache token logging
      );
    }

    // Check if Gemini caching is available - use cached streaming for cost savings
    if (isGeminiCacheConfigured()) {
      console.log(`[LLM] 🔄 Using cached Gemini streaming for model: ${modelToUse}`);

      // Build dynamic input from conversation context (includes dynamic variables, intro template, goal)
      const dynamicInput = buildDynamicInputForCache(messages, userText, context);

      try {
        const response = await generateStreamingWithCachedSystem(
          dynamicInput,
          onSpeakReady,
          context?.callId  // Pass callId for latency tracking
        );

        const latencyMs = Date.now() - startTime;
        console.log(`[LLM] ✅ Cached Gemini streaming complete (${latencyMs}ms, ${response.length} chars)`);

        // Log the interaction
        if (context?.callId) {
          insertLlmLog({
            call_id: context.callId,
            request_type: "chat",
            model: config.gemini.cacheModel,
            temperature: temperatureToUse,
            max_tokens: maxTokensToUse,
            system_prompt: "[CACHED]",
            messages: messages.slice(0, 3), // Truncate for logging
            user_input: userText.substring(0, 500),
            assistant_response: response,
            rolling_summary: rollingSummary,
            recent_turns_count: recentTurnsCount,
            latency_ms: latencyMs,
          }).catch((err) => {
            console.error(`[${context.callId}] Failed to log cached Gemini call:`, err);
          });
        }

        return response;
      } catch (cacheError) {
        // Fallback to regular streaming if cache fails
        console.warn(`[LLM] ⚠️ Cached streaming failed, falling back to regular: ${cacheError instanceof Error ? cacheError.message : cacheError}`);
      }
    }

    // Use regular Gemini streaming (no cache or cache failed)
    return await generateWithGeminiStreaming(
      modelToUse,
      messages,
      temperatureToUse,
      maxTokensToUse,
      topPToUse,
      context,
      userText,
      rollingSummary,
      recentTurnsCount,
      startTime,
      onSpeakReady
    );
  } else if (isGrokModel(modelToUse) && xai) {
    // Route Grok models to xAI API
    console.log(`[LLM] 🚀 Using xAI for Grok model: ${modelToUse}`);
    return await generateWithOpenAICompatible(
      xai,
      modelToUse,
      messages,
      temperatureToUse,
      maxTokensToUse,
      topPToUse,
      reasoningToUse,
      jsonModeToUse,
      context,
      userText,
      systemPrompt,
      rollingSummary,
      recentTurnsCount,
      startTime
    );
  } else {
    // Default to Groq
    return await generateWithOpenAICompatible(
      groq,
      modelToUse,
      messages,
      temperatureToUse,
      maxTokensToUse,
      topPToUse,
      reasoningToUse,
      jsonModeToUse,
      context,
      userText,
      systemPrompt,
      rollingSummary,
      recentTurnsCount,
      startTime
    );
  }
}

/**
 * Generate response using OpenAI-compatible API (Groq, xAI, etc.)
 */
async function generateWithOpenAICompatible(
  client: OpenAI,
  modelToUse: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  temperature: number,
  maxTokens: number,
  topP: number,
  reasoningEffort: string,
  jsonMode: boolean,
  context: CallContext | undefined,
  userText: string,
  systemPrompt: string,
  rollingSummary: string | undefined,
  recentTurnsCount: number,
  startTime: number
): Promise<string> {
  // Build API request parameters
  const apiParams: any = {
    model: modelToUse,
    messages,
    temperature,
    max_tokens: maxTokens,
    top_p: topP,
  };

  // Add reasoning_effort if model supports it (exclude Grok models)
  const supportsReasoning = (modelToUse.includes('gpt-oss') || modelToUse.includes('reasoning')) && !isGrokModel(modelToUse);
  if (supportsReasoning) {
    apiParams.reasoning_effort = reasoningEffort;
  }

  // Add response_format for JSON mode
  if (jsonMode) {
    apiParams.response_format = { type: 'json_object' };
  }

  const response = await client.chat.completions.create(apiParams);
  const latencyMs = Date.now() - startTime;

  const assistantResponse = response.choices[0]?.message?.content || "";

  // Extract token usage - xAI provides detailed usage including cache info
  const usage = response.usage;
  const promptTokens = usage?.prompt_tokens || 0;
  const completionTokens = usage?.completion_tokens || 0;
  const totalTokens = usage?.total_tokens || 0;

  // xAI provides cache details in usage_details (if available)
  const usageDetails = (usage as any)?.prompt_tokens_details;
  const cachedTokens = usageDetails?.cached_tokens || 0;

  // Determine if this is xAI/Grok for detailed logging
  const isXai = isGrokModel(modelToUse);

  // Log detailed token usage for Grok models
  if (isXai && usage) {
    console.log(
      `[LLM] 🤖 Grok usage: prompt=${promptTokens}, completion=${completionTokens}, ` +
      `total=${totalTokens}, cached=${cachedTokens}`
    );
  }

  // Log the LLM interaction to database for live visibility
  if (context?.callId) {
    insertLlmLog({
      call_id: context.callId,
      request_type: "chat",
      model: modelToUse,
      temperature,
      max_tokens: maxTokens,
      system_prompt: systemPrompt,
      messages: messages,
      user_input: userText,
      assistant_response: assistantResponse,
      rolling_summary: rollingSummary,
      recent_turns_count: recentTurnsCount,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      latency_ms: latencyMs,
    }).catch((err) => {
      console.error(`[${context.callId}] Failed to log LLM chat:`, err);
    });

    // Log usage cost
    if (usage) {
      const cost = isXai
        ? calculateXaiCost(promptTokens, completionTokens, modelToUse, cachedTokens)
        : calculateGroqCost(promptTokens, completionTokens, modelToUse);

      insertUsageCostLog({
        call_id: context.callId,
        provider: isXai ? "xai" : "groq",
        service_type: "llm",
        model: modelToUse,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        cached_tokens: cachedTokens > 0 ? cachedTokens : undefined,
        cost_usd: cost,
        request_type: "chat",
        metadata: cachedTokens > 0 ? { cached_tokens: cachedTokens } : undefined,
      }).catch((err) => {
        console.error(`[${context.callId}] Failed to log LLM cost:`, err);
      });
    }
  }

  return assistantResponse;
}

/**
 * Generate response using Gemini (streaming mode with early TTS)
 * @param isCustomPromptMode - When true, logs dropped caching tokens data
 */
async function generateWithGeminiStreaming(
  modelToUse: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  temperature: number,
  maxTokens: number,
  topP: number,
  context: CallContext | undefined,
  userText: string,
  rollingSummary: string | undefined,
  recentTurnsCount: number,
  startTime: number,
  onSpeakReady?: EarlyTtsCallback,
  isCustomPromptMode: boolean = false
): Promise<string> {
  if (!gemini) {
    throw new Error("Gemini client not initialized - GEMINI_API_KEY not configured");
  }

  console.log(`[LLM] 🔄 Using Gemini streaming mode for model: ${modelToUse}`);

  // Convert OpenAI-style messages to Gemini format
  const systemMessage = messages.find(m => m.role === 'system')?.content || '';
  const conversationHistory = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  // Create model with system instruction (must be passed to getGenerativeModel, not startChat)
  const model = gemini.getGenerativeModel({
    model: modelToUse,
    systemInstruction: systemMessage,
  });

  // Build generation config
  const generationConfig = {
    temperature,
    maxOutputTokens: maxTokens,
    topP,
  };

  try {
    // Start streaming
    const chat = model.startChat({
      history: conversationHistory.slice(0, -1), // All but last message
      generationConfig,
    });

    const lastUserMessage = conversationHistory[conversationHistory.length - 1]?.parts[0]?.text || userText;
    const result = await chat.sendMessageStream(lastUserMessage);

    // Process stream with incremental JSON parsing
    const parser = new StreamingJsonParser();
    let fullResponse = '';
    let ttsCallbackFired = false;

    for await (const chunk of result.stream) {
      const text = chunk.text();
      fullResponse += text;
      parser.addChunk(text);

      // Check if we can trigger early TTS
      if (!ttsCallbackFired && parser.canStartTts() && onSpeakReady) {
        const speakText = parser.getSpeakText();
        const behavior = parser.getBehavior();
        if (speakText) {
          console.log('[STREAM] 🚀 Speak field complete - triggering early TTS');
          try {
            await onSpeakReady(speakText, behavior);
            ttsCallbackFired = true;
          } catch (callbackError) {
            console.error('[STREAM] ❌ Early TTS callback failed:', callbackError);
            // Don't throw - continue processing stream
          }
        }
      }

      // Check if we should stop processing early (skip TTS behaviors)
      if (parser.shouldSkipTts() && !ttsCallbackFired) {
        console.log(`[STREAM] ⏭️ Behavior is ${parser.getBehavior()} - no TTS needed, stopping stream processing`);
        break;
      }
    }

    const latencyMs = Date.now() - startTime;
    const finalResponse = await result.response;

    // Get usage metadata if available
    const usageMetadata = finalResponse.usageMetadata;

    console.log(`[LLM] ✅ Gemini streaming complete (${latencyMs}ms, ${fullResponse.length} chars)`);

    // Always log Gemini token usage including implicit caching data
    if (usageMetadata) {
      const promptTokens = usageMetadata.promptTokenCount || 0;
      const completionTokens = usageMetadata.candidatesTokenCount || 0;
      const totalTokens = usageMetadata.totalTokenCount || 0;
      // Gemini returns cachedContentTokenCount for implicit prompt caching
      const cachedTokens = (usageMetadata as any).cachedContentTokenCount || 0;

      if (isCustomPromptMode) {
        // Custom prompt mode - no caching applied
        console.log(`[LLM] 📊 Gemini usage (custom prompt): prompt=${promptTokens}, completion=${completionTokens}, total=${totalTokens}`);
        console.log(`[LLM] 📊 Gemini dropped caching: ${promptTokens} prompt tokens uncached (cache bypassed)`);
      } else {
        // Normal mode - log implicit caching data
        console.log(`[LLM] 📊 Gemini usage: prompt=${promptTokens}, completion=${completionTokens}, total=${totalTokens}, cached=${cachedTokens}`);
        if (cachedTokens > 0) {
          const cacheHitRate = ((cachedTokens / promptTokens) * 100).toFixed(1);
          console.log(`[LLM] 💾 Gemini implicit cache hit: ${cachedTokens} tokens cached (${cacheHitRate}% of prompt)`);
        }
      }
    }

    // Log the LLM interaction
    if (context?.callId) {
      insertLlmLog({
        call_id: context.callId,
        request_type: "chat",
        model: modelToUse,
        temperature,
        max_tokens: maxTokens,
        system_prompt: systemMessage,
        messages: messages,
        user_input: userText,
        assistant_response: fullResponse,
        rolling_summary: rollingSummary,
        recent_turns_count: recentTurnsCount,
        prompt_tokens: usageMetadata?.promptTokenCount,
        completion_tokens: usageMetadata?.candidatesTokenCount,
        total_tokens: usageMetadata?.totalTokenCount,
        latency_ms: latencyMs,
      }).catch((err) => {
        console.error(`[${context.callId}] Failed to log Gemini chat:`, err);
      });
    }

    return fullResponse;
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    console.error(
      `[LLM] ❌ Gemini streaming error (${latencyMs}ms):`,
      error instanceof Error ? error.message : error
    );
    throw error;
  }
}

/**
 * Generate JSON response using Gemini with cached system prompt.
 *
 * This function uses the Gemini caching API to efficiently reuse system prompts
 * across multiple calls. The cache metadata is stored in Supabase for sharing
 * across Fly.io instances.
 *
 * @param dynamicInput - The user input/context for this generation
 * @param context - Optional call context for logging
 * @param customSystemPrompt - Optional custom system prompt (uses default Ferguson prompt if not provided)
 * @returns The generated JSON response
 */
export async function generateWithCachedGemini(
  dynamicInput: string,
  context?: CallContext,
  customSystemPrompt?: string
): Promise<string> {
  if (!isGeminiCacheConfigured()) {
    throw new Error("Gemini cache not configured - requires GEMINI_API_KEY, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY");
  }

  const startTime = Date.now();

  try {
    console.log("[LLM] 🔄 Using cached Gemini generation");

    const response = await generateJsonWithCachedSystem(dynamicInput);
    const latencyMs = Date.now() - startTime;

    console.log(`[LLM] ✅ Cached Gemini response (${latencyMs}ms, ${response.length} chars)`);

    // Log the LLM interaction if context is provided
    if (context?.callId) {
      insertLlmLog({
        call_id: context.callId,
        request_type: "chat",
        model: config.gemini.cacheModel,
        temperature: undefined, // Not configurable for cached calls
        max_tokens: undefined,
        system_prompt: "[CACHED]", // Don't log full prompt
        messages: [{ role: "user", content: dynamicInput.substring(0, 500) }], // Truncate for logging
        user_input: dynamicInput.substring(0, 500),
        assistant_response: response,
        latency_ms: latencyMs,
      }).catch((err) => {
        console.error(`[${context.callId}] Failed to log cached Gemini call:`, err);
      });
    }

    return response;
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    console.error(
      `[LLM] ❌ Cached Gemini error (${latencyMs}ms):`,
      error instanceof Error ? error.message : error
    );
    throw error;
  }
}

/**
 * Check if Gemini caching is available.
 * Useful for callers to decide whether to use cached vs streaming generation.
 */
export function isCachedGeminiAvailable(): boolean {
  return isGeminiCacheConfigured();
}
