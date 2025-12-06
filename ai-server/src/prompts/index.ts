/**
 * Prompt Core Module
 * ===================
 * Single source of truth for all prompt-related functionality.
 *
 * This module provides:
 * - Typed structures for prompt configuration
 * - Template rendering with strict allowlist
 * - Message building with three-party rule enforcement
 * - Validators for prompt and message invariants
 *
 * Usage:
 * ------
 * import {
 *   createPromptConfig,
 *   renderPromptBundle,
 *   buildMessages,
 *   validatePromptBundle,
 * } from './prompts';
 *
 * const config = createPromptConfig({
 *   goalText: 'Get store hours for next Monday',
 *   assistantName: 'Pigeon',
 *   ownerName: 'John',
 * });
 *
 * const bundle = renderPromptBundle(config);
 * const validation = validatePromptBundle(bundle);
 *
 * if (validation.valid) {
 *   const messages = buildMessages({
 *     bundle,
 *     transcriptTurns: [],
 *   });
 * }
 */

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════
export type {
  PromptConfig,
  PromptBundle,
  ConversationTurn,
  ChatMessage,
  MessageBuildContext,
  ValidationResult,
  AllowedTemplateVar,
} from './types';

export {
  ALLOWED_TEMPLATE_VARS,
  DEFAULT_PROMPT_CONFIG,
} from './types';

// ═══════════════════════════════════════════════════════════════════
// Templates
// ═══════════════════════════════════════════════════════════════════
export {
  SYSTEM_PROMPT_TEMPLATE,
  RECORDING_NOTICE_TEXT,
  getSystemPromptTemplate,
} from './systemPrompt';

export {
  OWNER_INSTRUCTIONS_TEMPLATE,
  OWNER_INSTRUCTIONS_COMPACT_TEMPLATE,
  getOwnerInstructionsTemplate,
} from './ownerInstructionsTemplate';

// ═══════════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════════
export {
  renderTemplate,
  renderPromptBundle,
  createPromptConfig,
  renderSystemPrompt,
  renderOwnerInstructions,
} from './render';

// ═══════════════════════════════════════════════════════════════════
// Message Building
// ═══════════════════════════════════════════════════════════════════
export {
  buildMessages,
  buildInitialMessages,
  buildMessagesWithSummary,
  formatTurnsAsMessages,
  getCalleeConversationStartIndex,
  getMessageMode,
  extractCalleeMessages,
  countCalleeTurns,
} from './buildMessages';

// ═══════════════════════════════════════════════════════════════════
// Validators
// ═══════════════════════════════════════════════════════════════════
export {
  validateMessageOrdering,
  validateSystemPromptContainsRoleRules,
  validateOwnerInstructionsConfigOnly,
  validateAssistantUtteranceFormat,
  validateNoCalendarDateGenerated,
  validatePromptBundle,
  validateMessagesPreFlight,
  looksLikeConfigResponse,
} from './validators';
