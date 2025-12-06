/**
 * Message Builder - Three-Party Rule Enforcement
 * ================================================
 * Builds the message array for LLM calls with explicit enforcement
 * of the three-party conversation model.
 *
 * THREE-PARTY MODEL:
 * ──────────────────
 * 1. OWNER/DEVELOPER (Party 1)
 *    - Sets: System prompt + FIRST user message (owner instructions)
 *    - This is CONFIG only - never responded to as dialogue
 *
 * 2. AI AGENT (Party 2)
 *    - Outputs: Spoken words only
 *    - First output: Opening greeting to CALLEE
 *    - No JSON, markdown, tags, or stage directions
 *
 * 3. CALLEE (Party 3)
 *    - Provides: LIVE_TRANSCRIPT (all user messages after the first)
 *    - The person on the phone the agent is talking to
 *
 * MESSAGE STRUCTURE:
 * ──────────────────
 * [0] system    → AI AGENT role definition (from OWNER)
 * [1] user      → OWNER_INSTRUCTIONS (config, goal, rules) ← MODE: OWNER_CONFIG
 * [2] user      → [Optional] CALL_CONTEXT_SUMMARY (if rolling summary exists)
 * [3+] user/assistant → LIVE_TRANSCRIPT turns ← MODE: CALLEE_CONVERSATION
 * [N] user      → Current utterance from CALLEE
 */

import {
  ChatMessage,
  PromptBundle,
  MessageBuildContext,
  ConversationTurn,
} from './types';

/**
 * Format conversation turns into chat messages.
 * Maps speaker types to chat roles:
 * - assistant → assistant
 * - caller/ivr/agent → user (these are all CALLEE-side in the three-party model)
 *
 * @param turns - Array of conversation turns
 * @returns Array of chat messages
 */
export function formatTurnsAsMessages(turns: ConversationTurn[]): ChatMessage[] {
  return turns.map((turn) => {
    const role: 'user' | 'assistant' =
      turn.speaker === 'assistant' ? 'assistant' : 'user';

    // Include speaker label for clarity when multiple parties (IVR, transfer, etc.)
    const speakerLabel =
      turn.speaker === 'assistant' ? '' : `[${turn.speaker.toUpperCase()}] `;

    return {
      role,
      content: `${speakerLabel}${turn.text}`,
    };
  });
}

/**
 * Build the complete message array for an LLM call.
 * This is the main entry point for constructing LLM prompts.
 *
 * Enforces the three-party model:
 * 1. System message (OWNER-defined agent behavior)
 * 2. Owner instructions (OWNER-defined call config) ← OWNER_CONFIG_MODE
 * 3. Rolling summary (if available)
 * 4. Transcript turns (CALLEE conversation) ← CALLEE_CONVERSATION_MODE
 * 5. Current utterance (latest CALLEE input)
 *
 * @param context - The message build context
 * @returns Array of chat messages ready for LLM API
 */
export function buildMessages(context: MessageBuildContext): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // ═══════════════════════════════════════════════════════════════════
  // PARTY 1: OWNER/DEVELOPER - System prompt (AI agent role definition)
  // ═══════════════════════════════════════════════════════════════════
  messages.push({
    role: 'system',
    content: context.bundle.system,
  });

  // ═══════════════════════════════════════════════════════════════════
  // PARTY 1: OWNER/DEVELOPER - Owner instructions (call config)
  // This is the FIRST user message and is CONFIG ONLY.
  // After this, we enter CALLEE_CONVERSATION_MODE.
  // ═══════════════════════════════════════════════════════════════════
  messages.push({
    role: 'user',
    content: context.bundle.ownerInstructions,
  });

  // ═══════════════════════════════════════════════════════════════════
  // CONTEXT: Rolling summary (compressed call history)
  // Provides context for long conversations without including all turns.
  // ═══════════════════════════════════════════════════════════════════
  if (context.rollingSummary && context.rollingSummary.trim()) {
    messages.push({
      role: 'user',
      content: `CALL CONTEXT SUMMARY:\n${context.rollingSummary}`,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // PARTY 3: CALLEE - Live transcript turns (CALLEE_CONVERSATION_MODE)
  // All user messages from here are from the person on the phone.
  // ═══════════════════════════════════════════════════════════════════
  if (context.transcriptTurns.length > 0) {
    const transcriptMessages = formatTurnsAsMessages(context.transcriptTurns);
    messages.push(...transcriptMessages);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PARTY 3: CALLEE - Current utterance (latest input)
  // The most recent thing the callee said, triggering this LLM call.
  // ═══════════════════════════════════════════════════════════════════
  if (context.currentUtterance && context.currentUtterance.trim()) {
    messages.push({
      role: 'user',
      content: context.currentUtterance,
    });
  }

  return messages;
}

/**
 * Build messages for the initial call (no transcript yet).
 * The AI should respond with its opening greeting.
 *
 * @param bundle - The prompt bundle
 * @returns Array of chat messages for initial call
 */
export function buildInitialMessages(bundle: PromptBundle): ChatMessage[] {
  return buildMessages({
    bundle,
    transcriptTurns: [],
  });
}

/**
 * Build messages with just a rolling summary (for long calls).
 * Use when you want to include summary but skip recent turns.
 *
 * @param bundle - The prompt bundle
 * @param rollingSummary - The rolling summary text
 * @param currentUtterance - The current callee utterance
 * @returns Array of chat messages
 */
export function buildMessagesWithSummary(
  bundle: PromptBundle,
  rollingSummary: string,
  currentUtterance?: string
): ChatMessage[] {
  return buildMessages({
    bundle,
    rollingSummary,
    transcriptTurns: [],
    currentUtterance,
  });
}

/**
 * Get the message index where CALLEE_CONVERSATION_MODE begins.
 * This is after system (0) and owner instructions (1).
 * If there's a rolling summary, it's after that too.
 *
 * @param messages - The message array
 * @returns The index where callee messages begin
 */
export function getCalleeConversationStartIndex(messages: ChatMessage[]): number {
  // System (0) + Owner Instructions (1) = 2
  // If message at index 2 is a CALL CONTEXT SUMMARY, start is 3
  if (
    messages.length > 2 &&
    messages[2].role === 'user' &&
    messages[2].content.startsWith('CALL CONTEXT SUMMARY:')
  ) {
    return 3;
  }
  return 2;
}

/**
 * Check if a message index is in OWNER_CONFIG_MODE or CALLEE_CONVERSATION_MODE.
 *
 * @param index - The message index
 * @param messages - The full message array
 * @returns The mode for this message
 */
export function getMessageMode(
  index: number,
  messages: ChatMessage[]
): 'SYSTEM' | 'OWNER_CONFIG' | 'CONTEXT_SUMMARY' | 'CALLEE_CONVERSATION' {
  if (index === 0) return 'SYSTEM';
  if (index === 1) return 'OWNER_CONFIG';

  // Check if index 2 is the context summary
  if (
    messages.length > 2 &&
    messages[2].role === 'user' &&
    messages[2].content.startsWith('CALL CONTEXT SUMMARY:')
  ) {
    if (index === 2) return 'CONTEXT_SUMMARY';
    return 'CALLEE_CONVERSATION';
  }

  return index >= 2 ? 'CALLEE_CONVERSATION' : 'OWNER_CONFIG';
}

/**
 * Extract just the callee conversation turns from a message array.
 * Useful for analysis and validation.
 *
 * @param messages - The full message array
 * @returns Only the callee conversation messages
 */
export function extractCalleeMessages(messages: ChatMessage[]): ChatMessage[] {
  const startIndex = getCalleeConversationStartIndex(messages);
  return messages.slice(startIndex);
}

/**
 * Count the number of turns in the callee conversation.
 *
 * @param messages - The full message array
 * @returns Number of callee conversation turns
 */
export function countCalleeTurns(messages: ChatMessage[]): number {
  return extractCalleeMessages(messages).length;
}
