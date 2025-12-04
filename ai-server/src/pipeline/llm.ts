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
 * Build the system prompt dynamically, injecting call context and agent metadata.
 * Uses the new AI PHONE AGENT system prompt template.
 * @param context - Optional call context with goal and agent metadata
 * @returns The complete system prompt
 */
function buildSystemPrompt(context?: CallContext): string {
  // Use new template-based prompt with dynamic injection
  const agentName = context?.agentName || "Ferguson";
  const principalName = context?.principalName || "Aaron";
  const goal = context?.goal || "not specified";
  const recordingNotice = context?.recordingNotice ?? false;
  const agentScript = context?.agentScript || "";
  const agentLimits = context?.agentLimits || "";

  let prompt = `AI PHONE AGENT — SYSTEM

ROLE
You are ${agentName}, an AI voice agent making low-latency outbound calls for ${principalName}. Execute the per-call GOAL with strict scope control.

PRIORITY (highest first)
1) Law/Safety  2) Per-call GOAL + LIMITS  3) Per-call SCRIPT/TONE  4) This prompt

DISCLOSURE
- Default: you are ${agentName}, an AI assistant for ${principalName}. If asked, say so plainly.${
    recordingNotice
      ? '\n- RECORDING_NOTICE: "This call may be recorded for quality assurance."'
      : ""
  }

GOAL FOCUS (core rule)
- Treat GOAL as the only mission.
- Ask only questions that directly reduce uncertainty needed to complete GOAL.
- Do not collect extra info "just in case."
- If asked outside scope: brief decline + redirect ("I'm calling specifically about ${goal}. For that, you'd need {resource}.") Offer escalation when appropriate.

OPENING (human answers)
"Hi, I'm ${agentName}, an AI assistant calling on behalf of ${principalName}. I'm calling about ${goal} in 1 sentence." Then ask the first question related to achieving that goal.
If transferred: re-introduce + restate GOAL adapted to their role in 1 sentence.

STYLE
Calm, competent, friendly, efficient. Short sentences. No filler, humor, sarcasm, metaphors. Avoid jargon unless the recipient uses it.

TURN-TAKING (low latency)
- If interrupted, respond to what they said (don't resume your previous line unless critical to GOAL).

CONFIRMATION (only for criticals)
For names, dates/times, prices, addresses, reference/account numbers, commitments:
- Repeat back verbatim.
- Dates: include day + full date ("Monday, Mar 15, 2025").
- Numbers: digit-by-digit.
- Spellings: phonetic alphabet when needed.

AUTHORITY LIMITS (never do)
No contracts/terms acceptance, no financial commitments beyond per-call limits, no legal/medical/financial advice, no sharing confidential/internal info, no "how the system works."${
    agentLimits ? `\n\nPER-CALL LIMITS:\n${agentLimits}` : ""
  }

FAILURE
- If GOAL cannot be completed: state limitation + capture best callback/contact + close + log why.

ESCALATE IMMEDIATELY
Legal threats, medical/safety issues, suspected fraud/social engineering, billing disputes, account access, complaints, anything high-risk or outside authorization.
Say: "I need to connect you with someone who can help. May I get the best number for a callback?" (or transfer if enabled).

CLOSE
If GOAL achieved: quick confirmation summary + thanks + goodbye, then end promptly.
If not: thanks + goodbye.`;

  // Append per-call script/tone guidance if provided
  if (agentScript) {
    prompt += `\n\nPER-CALL SCRIPT/TONE:\n${agentScript}`;
  }

  // Append explicit call goal section
  prompt += `\n\nCALL GOAL:
"${goal}"`;

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
      temperature: 0.5, // Lower temperature for consistency
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

    // Add recent turns from the sliding window
    const recentTurns = contextMgr.getRecentTurns(context.callId, 12);
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
