/**
 * LLM Pipeline - Groq Integration
 * =================================
 * Handles LLM calls using the centralized prompts module.
 *
 * THREE-PARTY MODEL:
 * 1. OWNER/DEVELOPER - Sets system prompt + FIRST user message (owner instructions)
 * 2. AI AGENT - Outputs spoken words only
 * 3. CALLEE - Provides LIVE_TRANSCRIPT (all later user messages)
 */

import OpenAI from "openai";
import config from "../config";
import * as contextMgr from "../callContextManager";

// Import from the centralized prompts module
import {
  createPromptConfig,
  renderPromptBundle,
  buildMessages,
  ConversationTurn,
  PromptBundle,
  PromptConfig,
} from "../prompts";

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
 * Build a PromptConfig from CallContext.
 * This adapts the existing CallContext interface to the new PromptConfig.
 *
 * @param context - Optional call context with goal, assistantName, and userName
 * @returns PromptConfig for rendering
 */
function buildPromptConfig(context?: CallContext): PromptConfig {
  return createPromptConfig({
    goalText: context?.goal || "Assist the caller with their request",
    assistantName: context?.assistantName || "Pigeon",
    ownerName: context?.userName || "the owner",
    recordingNotice: false, // TODO: Make configurable per-call
  });
}

/**
 * Convert callContextManager Turn to prompts ConversationTurn.
 */
function toConversationTurn(turn: contextMgr.Turn): ConversationTurn {
  return {
    speaker: turn.speaker as "caller" | "assistant" | "ivr" | "agent",
    text: turn.text,
    timestamp: turn.timestamp,
  };
}

/**
 * Build the system prompt dynamically using the centralized prompts module.
 * This is kept for backward compatibility with any code that calls it directly.
 *
 * @deprecated Use buildPromptConfig + renderPromptBundle instead
 * @param context - Optional call context with goal, assistantName, and userName
 * @returns The complete system prompt
 */
export function buildSystemPrompt(context?: CallContext): string {
  const promptConfig = buildPromptConfig(context);
  const bundle = renderPromptBundle(promptConfig);
  return bundle.system;
}

/**
 * Generate a rolling summary of the call by calling the LLM.
 * This is called periodically as new turns accumulate.
 *
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
 *
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
 *
 * Uses the THREE-PARTY MODEL:
 * - System message: Agent role definition (from OWNER)
 * - First user message: Owner instructions with GOAL (CONFIG, not dialogue)
 * - Subsequent user messages: CALLEE conversation (live transcript)
 *
 * @param userText - The user's input text (from CALLEE)
 * @param context - Call context with goal, call ID, and other metadata
 * @returns The AI-generated response, or an empty string if no response
 */
export async function generateAssistantReply(
  userText: string,
  context?: CallContext
): Promise<string> {
  // Build prompt config and render the bundle
  const promptConfig = buildPromptConfig(context);
  const bundle = renderPromptBundle(promptConfig);

  // Get call context for rolling summary and recent turns
  let rollingSummary: string | undefined;
  let transcriptTurns: ConversationTurn[] = [];

  if (context?.callId) {
    const callContext = contextMgr.getContext(context.callId);
    if (callContext?.rollingSummary) {
      rollingSummary = callContext.rollingSummary;
    }

    // Get recent turns from the sliding window
    const recentTurns = contextMgr.getRecentTurns(context.callId, 12);
    transcriptTurns = recentTurns.map(toConversationTurn);
  }

  // Build messages using the centralized message builder
  // This enforces the THREE-PARTY MODEL:
  // [0] system - Agent role definition
  // [1] user - Owner instructions (GOAL) <- OWNER_CONFIG_MODE
  // [2] user - Rolling summary (if exists)
  // [3+] - Transcript turns <- CALLEE_CONVERSATION_MODE
  // [N] user - Current utterance from callee
  const messages = buildMessages({
    bundle,
    rollingSummary,
    transcriptTurns,
    currentUtterance: userText,
  });

  const response = await groq.chat.completions.create({
    model: config.groq.model,
    messages,
    temperature: 0.2, // Low temperature for consistent, focused responses
  });

  return response.choices[0]?.message?.content || "";
}
