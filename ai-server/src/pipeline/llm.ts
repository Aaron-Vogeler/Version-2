import OpenAI from "openai";
import config from "../config";
import * as contextMgr from "../callContextManager";

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
 * Checks for custom system prompt in aiConfig first, falling back to default.
 * Replaces the hardcoded assistant name and user name with custom names from the call context.
 * @param context - Optional call context with goal, assistantName, userName, and aiConfig
 * @returns The complete system prompt
 */
function buildSystemPrompt(context?: CallContext): string {
  // Use custom system prompt from aiConfig if provided, otherwise use default
  let prompt = context?.aiConfig?.systemPrompt || config.llm.systemPrompt;

  // Replace the hardcoded assistant name "Ferguson" with the custom name if provided
  const assistantName = context?.assistantName || "Ferguson";

  // Replace all occurrences of "Ferguson" with the custom assistant name
  prompt = prompt.replace(/Ferguson/g, assistantName);

  // Also handle lowercase "ferguson" if it appears
  prompt = prompt.replace(/ferguson/g, assistantName.toLowerCase());

  // Replace the hardcoded user name "Aaron" with the custom name if provided
  const userName = context?.userName || "Aaron";

  // Replace all occurrences of "Aaron" with the custom user name
  prompt = prompt.replace(/Aaron/g, userName);

  if (context?.goal) {
    prompt += `

CALL GOAL (YOUR ONLY MISSION):
"${context.goal}"

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
  }

  return prompt;
}

// Default summary prompt template (can be overridden via aiConfig.summaryPrompt)
const DEFAULT_SUMMARY_PROMPT_TEMPLATE = `You are updating a rolling summary of a phone call between an AI assistant and a caller, and possibly multiple human agents.

EXISTING SUMMARY (may be empty or partial):
{{existingSummary}}

NEW TRANSCRIPT TURNS (since that summary was created):
{{turnsText}}

Please return an UPDATED, CONCISE summary (max ~{{maxTokens}} tokens) that preserves:
- The caller's main goal(s)
- Key facts (names, dates, constraints, identifiers)
- Important decisions / outcomes so far
- Current status (who we're talking to, which department, on hold or not, etc.)
- Any critical context for continuing the conversation

Be concise and focus on what's most important to continue this call effectively.`;

/**
 * Generate a rolling summary of the call by calling the LLM.
 * This is called periodically as new turns accumulate.
 * Uses aiConfig.summaryPrompt if provided, otherwise uses default template.
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

  // Use custom summary prompt from aiConfig if provided, otherwise use default template
  const promptTemplate = context.aiConfig?.summaryPrompt || DEFAULT_SUMMARY_PROMPT_TEMPLATE;

  // Replace placeholders in the prompt template
  const summaryPrompt = promptTemplate
    .replace(/\{\{existingSummary\}\}/g, existingSummary)
    .replace(/\{\{turnsText\}\}/g, turnsText)
    .replace(/\{\{maxTokens\}\}/g, String(config_params.maxSummaryTokensHint));

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

  // Add rolling summary if available and non-empty
  if (context?.callId) {
    const callContext = contextMgr.getContext(context.callId);
    if (callContext?.rollingSummary) {
      messages.push({
        role: "user",
        content: `CALL CONTEXT SUMMARY:\n${callContext.rollingSummary}`,
      });
    }

    // Use per-call maxTurnsInWindow from aiConfig if available, otherwise use default (12)
    const maxTurns = context.aiConfig?.maxTurnsInWindow ?? 12;

    // Add recent turns from the sliding window
    const recentTurns = contextMgr.getRecentTurns(context.callId, maxTurns);
    const recentMessages = contextMgr.formatTurnsAsMessages(recentTurns);
    messages.push(...recentMessages);
  }

  // Add the current user input as the final message
  messages.push({ role: "user", content: userText });

  const response = await groq.chat.completions.create({
    model: config.groq.model,
    messages,
  });

  return response.choices[0]?.message?.content || "";
}
