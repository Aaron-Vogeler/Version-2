import OpenAI from "openai";
import config from "../config";
import * as contextMgr from "../callContextManager";
import { insertLlmLog } from "../utils/supabase";

// Create Groq client configured with API key and base URL
const groq = new OpenAI({
  apiKey: config.groq.apiKey,
  baseURL: "https://api.groq.com/openai/v1",
});

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

  // Also replace legacy hardcoded names for backwards compatibility
  prompt = prompt.replace(/Ferguson/g, assistantName);
  prompt = prompt.replace(/ferguson/g, assistantName.toLowerCase());
  prompt = prompt.replace(/Aaron/g, userName);

  // Inject goal at the bottom in simple format
  if (context?.goal) {
    prompt += `

CALL GOAL (YOUR ONLY MISSION): "${context.goal}"`;
  }

  return prompt;
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

  // Use configurable rolling summary prompt from config
  // Replace placeholders: {EXISTING_SUMMARY}, {TURNS_TEXT}, {MAX_TOKENS}
  const summaryPrompt = config.llm.rollingSummaryPrompt
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
    const response = await groq.chat.completions.create({
      model: config.groq.model,
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
      model: config.groq.model,
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
export async function generateAssistantReply(
  userText: string,
  context?: CallContext
): Promise<string> {
  const systemPrompt = buildSystemPrompt(context);
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  let rollingSummary: string | undefined;
  let recentTurnsCount = 0;

  // Add rolling summary if available and non-empty
  if (context?.callId) {
    const callContext = contextMgr.getContext(context.callId);
    if (callContext?.rollingSummary) {
      rollingSummary = callContext.rollingSummary;
      messages.push({
        role: "user",
        content: `CALL CONTEXT SUMMARY:\n${callContext.rollingSummary}`,
      });
    }

    // Add recent turns from the sliding window
    const recentTurns = contextMgr.getRecentTurns(context.callId, 12);
    recentTurnsCount = recentTurns.length;
    const recentMessages = contextMgr.formatTurnsAsMessages(recentTurns);
    messages.push(...recentMessages);
  }

  // Add the current user input as the final message
  messages.push({ role: "user", content: userText });

  const startTime = Date.now();
  const response = await groq.chat.completions.create({
    model: config.groq.model,
    messages,
  });
  const latencyMs = Date.now() - startTime;

  const assistantResponse = response.choices[0]?.message?.content || "";

  // Log the LLM interaction to database for live visibility
  if (context?.callId) {
    insertLlmLog({
      call_id: context.callId,
      request_type: "chat",
      model: config.groq.model,
      system_prompt: systemPrompt,
      messages: messages,
      user_input: userText,
      assistant_response: assistantResponse,
      rolling_summary: rollingSummary,
      recent_turns_count: recentTurnsCount,
      prompt_tokens: response.usage?.prompt_tokens,
      completion_tokens: response.usage?.completion_tokens,
      total_tokens: response.usage?.total_tokens,
      latency_ms: latencyMs,
    }).catch((err) => {
      console.error(`[${context.callId}] Failed to log LLM chat:`, err);
    });
  }

  return assistantResponse;
}
