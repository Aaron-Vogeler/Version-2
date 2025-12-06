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
 * Build the system prompt dynamically.
 * Replaces the hardcoded assistant name and user name with custom names from the call context.
 * Note: The GOAL is now sent as the first user message (OWNER_INSTRUCTIONS), not appended here.
 * @param context - Optional call context with assistantName and userName
 * @returns The complete system prompt
 */
function buildSystemPrompt(context?: CallContext): string {
  let prompt = config.llm.systemPrompt;

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

  return prompt;
}

/**
 * Build the OWNER_INSTRUCTIONS message (first user message).
 * This is configuration from the OWNER, not dialogue from the CALLEE.
 * The AI should parse this silently and NOT reply to it directly.
 * @param context - Call context with goal and other metadata
 * @returns The OWNER_INSTRUCTIONS message content, or null if no goal
 */
function buildOwnerInstructions(context?: CallContext): string | null {
  if (!context?.goal) {
    return null;
  }

  const assistantName = context.assistantName || "Ferguson";
  const userName = context.userName || "Aaron";

  return `=== OWNER_INSTRUCTIONS ===

You are ${assistantName}, calling on behalf of ${userName}.

GOAL: "${context.goal}"

When the callee answers, introduce yourself and ask DIRECTLY for what this goal needs.
Do not add extra steps. Do not ask to be transferred. Just ask.

Example: If goal is "Get store hours", say: "Hi, I'm ${assistantName}, an AI assistant calling on behalf of ${userName}. What are your store hours?"

=== WAITING FOR CALLEE ===`;
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
 * Message structure:
 * 1. System prompt (role, identity, rules)
 * 2. OWNER_INSTRUCTIONS (first user message - config only, AI should not reply to this)
 * 3. Rolling summary (if available, as system context)
 * 4. Recent conversation turns (alternating user/assistant)
 * 5. Current CALLEE input (what the person on the phone just said)
 *
 * @param userText - The CALLEE's input text (live transcript from the phone)
 * @param context - Call context with goal, call ID, and other metadata
 * @returns The AI-generated response (spoken words only), or an empty string if no response
 */
export async function generateAssistantReply(
  userText: string,
  context?: CallContext
): Promise<string> {
  const systemPrompt = buildSystemPrompt(context);
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  // Add OWNER_INSTRUCTIONS as the first user message (config from OWNER, not dialogue)
  const ownerInstructions = buildOwnerInstructions(context);
  if (ownerInstructions) {
    messages.push({ role: "user", content: ownerInstructions });
  }

  // Add rolling summary as system context if available
  if (context?.callId) {
    const callContext = contextMgr.getContext(context.callId);
    if (callContext?.rollingSummary) {
      // Insert rolling summary as a system message to keep it separate from dialogue
      messages.push({
        role: "system",
        content: `[CALL CONTEXT SUMMARY — for your reference, not dialogue]\n${callContext.rollingSummary}`,
      });
    }

    // Add recent turns from the sliding window (actual conversation with CALLEE)
    const recentTurns = contextMgr.getRecentTurns(context.callId, 12);
    const recentMessages = contextMgr.formatTurnsAsMessages(recentTurns);
    messages.push(...recentMessages);
  }

  // Add the current CALLEE input as the final message (LIVE_TRANSCRIPT)
  messages.push({ role: "user", content: userText });

  const response = await groq.chat.completions.create({
    model: config.groq.model,
    messages,
  });

  return response.choices[0]?.message?.content || "";
}
