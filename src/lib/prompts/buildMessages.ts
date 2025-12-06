/**
 * Message Builder - Constructs the message array for LLM calls
 */

import { ChatMessage, PromptBundle, ConversationTurn } from './types';

export function formatTurnsAsMessages(turns: ConversationTurn[]): ChatMessage[] {
  return turns.map((turn) => {
    const role: 'user' | 'assistant' = turn.speaker === 'assistant' ? 'assistant' : 'user';
    const label = turn.speaker === 'assistant' ? '' : `[${turn.speaker.toUpperCase()}] `;
    return { role, content: `${label}${turn.text}` };
  });
}

export interface MessageBuildContext {
  bundle: PromptBundle;
  rollingSummary?: string;
  transcriptTurns: ConversationTurn[];
  currentUtterance?: string;
}

export function buildMessages(context: MessageBuildContext): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // System message
  messages.push({ role: 'system', content: context.bundle.system });

  // Owner instructions (first user message - CONFIG, not dialogue)
  messages.push({ role: 'user', content: context.bundle.ownerInstructions });

  // Rolling summary if present
  if (context.rollingSummary?.trim()) {
    messages.push({ role: 'user', content: `CALL CONTEXT SUMMARY:\n${context.rollingSummary}` });
  }

  // Transcript turns
  if (context.transcriptTurns.length > 0) {
    messages.push(...formatTurnsAsMessages(context.transcriptTurns));
  }

  // Current utterance
  if (context.currentUtterance?.trim()) {
    messages.push({ role: 'user', content: context.currentUtterance });
  }

  return messages;
}
