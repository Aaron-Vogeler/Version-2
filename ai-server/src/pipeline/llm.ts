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
 * Replaces variable keys with custom names from the call context.
 * @param context - Optional call context with goal, assistantName, userName
 * @param customSystemPrompt - Optional custom system prompt to override default
 * @returns The complete system prompt
 */
function buildSystemPrompt(context?: CallContext, customSystemPrompt?: string): string {
  // Use custom system prompt if provided, otherwise use config default
  let prompt = customSystemPrompt || context?.customSystemPrompt || config.llm.systemPrompt;

  // Validate that a system prompt is provided
  if (!prompt) {
    throw new Error("System prompt is required. Please provide a custom system prompt via LLM_SYSTEM_PROMPT env var or in the call context.");
  }

  // Replace variable keys with actual names
  const assistantName = context?.assistantName || "Assistant";
  const userName = context?.userName || "User";

  prompt = prompt.replace(new RegExp(config.llm.assistantVariableKey, "g"), assistantName);
  prompt = prompt.replace(new RegExp(config.llm.userVariableKey, "g"), userName);

  // Simplified goal injection at the bottom
  if (context?.goal) {
    prompt += `

CALL GOAL (YOUR ONLY MISSION):
"${context.goal}"`;
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

  // Use configurable summary prompt with placeholder replacement
  const summaryPrompt = config.llm.summaryPrompt
    .replace("{existingSummary}", existingSummary)
    .replace("{turnsText}", turnsText)
    .replace("{maxTokens}", config_params.maxSummaryTokensHint.toString());

  try {
    console.log(`[${callId}] Generating rolling summary...`);
    const summarySystemContent = config.llm.summarySystemMessage;
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
 * @param customSystemPrompt - Optional custom system prompt to override default
 * @returns The AI-generated response, or an empty string if no response
 */
export async function generateAssistantReply(
  userText: string,
  context?: CallContext,
  customSystemPrompt?: string
): Promise<string> {
  const systemPrompt = buildSystemPrompt(context, customSystemPrompt);
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
