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
 * Build the system prompt dynamically by replacing assistant and user names.
 * @param context - Optional call context with assistantName and userName
 * @returns The complete system prompt with names substituted
 */
function buildSystemPrompt(context?: CallContext): string {
  let prompt = config.llm.systemPrompt;

  // Replace the hardcoded assistant name "Ferguson" with the custom name if provided
  const assistantName = context?.assistantName || "Ferguson";
  prompt = prompt.replace(/Ferguson/g, assistantName);
  prompt = prompt.replace(/ferguson/g, assistantName.toLowerCase());

  // Replace the hardcoded user name "Aaron" with the custom name if provided
  const userName = context?.userName || "Aaron";
  prompt = prompt.replace(/Aaron/g, userName);

  return prompt;
}

/**
 * Build the OWNER_INSTRUCTIONS message containing the GOAL and call configuration.
 * This is sent as the first user message to set up the call context.
 * @param context - Call context with goal, assistantName, and userName
 * @returns The OWNER_INSTRUCTIONS message content
 */
function buildOwnerInstructions(context?: CallContext): string {
  const assistantName = context?.assistantName || "Ferguson";
  const ownerName = context?.userName || "Aaron";
  const recordingNotice = context?.recordingNotice ? "true" : "false";
  const goal = context?.goal || "";

  return `OWNER_INSTRUCTIONS

assistant_name: ${assistantName}
owner_name: ${ownerName}
recording_notice: ${recordingNotice}

GOAL:
${goal}

CONTEXT:
- You are placing a phone call on behalf of {{owner_name}} to complete the GOAL above.
- Use the GOAL phrasing to explain why you are calling if the human asks.
- Any additional details spoken during the call come from the human, not the owner.

CONSTRAINTS:
- Stay tightly focused on completing the GOAL.
- Do NOT gather unnecessary information.
- Do NOT guess or infer anything; ask if unclear.
- Mirror only the information explicitly stated by the human.
- If the human corrects a detail (e.g., time, date, price), always use their correction.

CLOSING INSTRUCTIONS:
- When the GOAL is completed or cannot be completed, provide one concise summary.
- Confirm once if appropriate.
- End the call by saying, "Thanks, chow."`;
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
 * 1. System: buildSystemPrompt(context) - behavioral instructions
 * 2. User: OWNER_INSTRUCTIONS - goal and call configuration (first user message only)
 * 3. User: Rolling summary (if available)
 * 4. Assistant/User: Recent conversation turns
 * 5. User: Current user input
 * @param userText - The user's input text
 * @param context - Call context with goal, call ID, and other metadata
 * @param includeOwnerInstructions - Whether to include OWNER_INSTRUCTIONS (set true on first turn)
 * @returns The AI-generated response, or an empty string if no response
 */
export async function generateAssistantReply(
  userText: string,
  context?: CallContext,
  includeOwnerInstructions: boolean = true
): Promise<string> {
  const systemPrompt = buildSystemPrompt(context);
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  // Add OWNER_INSTRUCTIONS as the first user message (configuration, not a human speaking)
  if (includeOwnerInstructions && context?.goal) {
    const ownerInstructions = buildOwnerInstructions(context);
    messages.push({
      role: "user",
      content: ownerInstructions,
    });
  }

  // Add rolling summary if available and non-empty
  if (context?.callId) {
    const callContext = contextMgr.getContext(context.callId);
    if (callContext?.rollingSummary) {
      messages.push({
        role: "user",
        content: `CALL CONTEXT SUMMARY:\n${callContext.rollingSummary}`,
      });
    }

    // Add recent turns from the sliding window
    const recentTurns = contextMgr.getRecentTurns(context.callId, 12);
    const recentMessages = contextMgr.formatTurnsAsMessages(recentTurns);
    messages.push(...recentMessages);
  }

  // Add the current user input as the final message (LIVE_TRANSCRIPT from the human)
  messages.push({ role: "user", content: userText });

  const response = await groq.chat.completions.create({
    model: config.groq.model,
    messages,
  });

  return response.choices[0]?.message?.content || "";
}
