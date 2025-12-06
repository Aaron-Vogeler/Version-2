import OpenAI from "openai";
import config from "../config";
import * as contextMgr from "../callContextManager";
import type { PromptSettings } from "../callContextManager";

// Create Groq client configured with API key and base URL
const groq = new OpenAI({
  apiKey: config.groq.apiKey,
  baseURL: "https://api.groq.com/openai/v1",
});

// Default goal template (used when no custom template is provided)
const DEFAULT_GOAL_TEMPLATE = `CALL GOAL (YOUR ONLY MISSION):
"{goal}"

EXECUTION RULES FOR THIS CALL:
- Ask ONLY questions necessary to achieve the goal above
- Preserve the EXACT specificity of the goal (dates, times, details)
- Do NOT reinterpret dates/times (e.g., if goal says "next Monday", ask about "next Monday", not "tomorrow")
- Do NOT ask for names, store info, account details, or anything else unless directly needed
- Example: If goal is "get store hours for next Monday", ask ONLY about next Monday's hours—not tomorrow, not "the next day", not today
- When you have what you need: confirm it back ("Just to confirm, [info]. Is that correct?")
- After confirmation: end with "Thank you. Chow."
- Do NOT deviate from this goal

Remember: You are an AI phone agent. Strict scope control is mandatory.`;

/**
 * Re-export CallContext and PromptSettings from the context manager for backward compatibility.
 */
export type CallContext = contextMgr.CallContext;
export type { PromptSettings } from "../callContextManager";

/**
 * Build the system prompt dynamically, optionally injecting call goal context.
 * Replaces the hardcoded assistant name and user name with custom names from the call context.
 * Uses custom prompt settings if provided, otherwise falls back to defaults.
 * @param context - Optional call context with goal, assistantName, userName, and promptSettings
 * @returns The complete system prompt
 */
function buildSystemPrompt(context?: CallContext): string {
  const settings = context?.promptSettings;

  // Use custom system prompt if provided, otherwise use default from config
  let prompt = settings?.systemPrompt || config.llm.systemPrompt;

  // Replace the hardcoded assistant name "Ferguson" with the custom name if provided
  // Priority: promptSettings.assistantName > context.assistantName > "Ferguson"
  const assistantName = settings?.assistantName || context?.assistantName || "Ferguson";

  // Replace all occurrences of "Ferguson" with the custom assistant name
  prompt = prompt.replace(/Ferguson/g, assistantName);

  // Also handle lowercase "ferguson" if it appears
  prompt = prompt.replace(/ferguson/g, assistantName.toLowerCase());

  // Replace the hardcoded user name "Aaron" with the custom name if provided
  // Priority: promptSettings.userName > context.userName > "Aaron"
  const userName = settings?.userName || context?.userName || "Aaron";

  // Replace all occurrences of "Aaron" with the custom user name
  prompt = prompt.replace(/Aaron/g, userName);

  // Inject goal using custom template or default
  if (context?.goal) {
    const goalTemplate = settings?.goalTemplate || DEFAULT_GOAL_TEMPLATE;
    const goalSection = goalTemplate.replace("{goal}", context.goal);
    prompt += "\n\n" + goalSection;
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

  const summaryPrompt = `You are updating a rolling summary of a phone call between an AI assistant and a caller, and possibly multiple human agents.

EXISTING SUMMARY (may be empty or partial):
${existingSummary}

NEW TRANSCRIPT TURNS (since that summary was created):
${turnsText}

Please return an UPDATED, CONCISE summary (max ~${config_params.maxSummaryTokensHint} tokens) that preserves:
- The caller's main goal(s)
- Key facts (names, dates, constraints, identifiers)
- Important decisions / outcomes so far
- Current status (who we're talking to, which department, on hold or not, etc.)
- Any critical context for continuing the conversation

Be concise and focus on what's most important to continue this call effectively.`;

  try {
    console.log(`[${callId}] Generating rolling summary...`);
    const response = await groq.chat.completions.create({
      model: config.groq.model,
      messages: [
        {
          role: "system",
          content:
            "You are a concise call summary generator. Create summaries that preserve the most important context for continuing phone conversations.",
        },
        { role: "user", content: summaryPrompt },
      ],
      temperature: 0.2, // Lower temperature for consistency
      max_tokens: config_params.maxSummaryTokensHint,
    });

    const newSummary = response.choices[0]?.message?.content || "";
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
 * Uses custom prompt settings if provided for model, temperature, max_tokens, etc.
 * @param userText - The user's input text
 * @param context - Call context with goal, call ID, promptSettings, and other metadata
 * @returns The AI-generated response, or an empty string if no response
 */
export async function generateAssistantReply(
  userText: string,
  context?: CallContext
): Promise<string> {
  const settings = context?.promptSettings;
  const systemPrompt = buildSystemPrompt(context);
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  // Check if rolling summary should be included (default: true)
  const includeRollingSummary = settings?.includeRollingSummary !== false;

  // Get max context turns (default: 12)
  const maxContextTurns = settings?.maxContextTurns ?? 12;

  // Add rolling summary if available, non-empty, and not disabled
  if (context?.callId && includeRollingSummary) {
    const callContext = contextMgr.getContext(context.callId);
    if (callContext?.rollingSummary) {
      messages.push({
        role: "user",
        content: `CALL CONTEXT SUMMARY:\n${callContext.rollingSummary}`,
      });
    }
  }

  // Add recent turns from the sliding window
  if (context?.callId) {
    const recentTurns = contextMgr.getRecentTurns(context.callId, maxContextTurns);
    const recentMessages = contextMgr.formatTurnsAsMessages(recentTurns);
    messages.push(...recentMessages);
  }

  // Add the current user input as the final message
  messages.push({ role: "user", content: userText });

  // Build LLM request options with custom settings
  const model = settings?.model || config.groq.model;
  const temperature = settings?.temperature ?? 0.4; // Default to 0.4 for consistent phone agent behavior
  const maxTokens = settings?.maxTokens ?? 150; // Default to 150 for short phone responses

  // Log LLM parameters for debugging
  console.log(`[LLM] Generating reply with model=${model}, temp=${temperature}, max_tokens=${maxTokens}`);

  // Build the request options
  const requestOptions: OpenAI.Chat.ChatCompletionCreateParams = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  // Add optional parameters if provided
  if (settings?.topP !== undefined) {
    requestOptions.top_p = settings.topP;
  }
  if (settings?.frequencyPenalty !== undefined) {
    requestOptions.frequency_penalty = settings.frequencyPenalty;
  }
  if (settings?.presencePenalty !== undefined) {
    requestOptions.presence_penalty = settings.presencePenalty;
  }
  if (settings?.stopSequences && settings.stopSequences.length > 0) {
    requestOptions.stop = settings.stopSequences;
  }

  const response = await groq.chat.completions.create(requestOptions);

  return response.choices[0]?.message?.content || "";
}
