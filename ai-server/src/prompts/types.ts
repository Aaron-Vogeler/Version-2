/**
 * Prompt Core - Type Definitions
 * ================================
 * Typed structures for prompt configuration and rendering.
 *
 * THREE-PARTY MODEL:
 * 1. OWNER/DEVELOPER - Sets system prompt + FIRST user message (config only)
 * 2. AI AGENT - Outputs spoken words only
 * 3. CALLEE - Provides LIVE_TRANSCRIPT (all later user messages)
 */

/**
 * Configuration values that can be injected into prompt templates.
 * Uses a strict allowlist to prevent injection vulnerabilities.
 */
export interface PromptConfig {
  /** Name of the AI assistant (e.g., "Ferguson") */
  assistantName: string;

  /** Name of the owner on whose behalf the call is made (e.g., "Aaron") */
  ownerName: string;

  /** Whether to include a recording notice at the start of the call */
  recordingNotice: boolean;

  /** The specific goal for this call - owner's instructions to the agent */
  goalText: string;

  /** Optional: Custom voice/tone instructions */
  toneOverride?: string;
}

/**
 * A fully rendered prompt bundle ready for LLM consumption.
 * Separates system prompt from owner instructions for clear role boundaries.
 */
export interface PromptBundle {
  /**
   * System prompt - defines AI agent behavior, constraints, style.
   * This is the ROLE definition that never changes during a call.
   */
  system: string;

  /**
   * Owner instructions - the FIRST user message that provides call context.
   * Contains GOAL and execution rules. After this message, we are in
   * CALLEE_CONVERSATION_MODE - all subsequent user messages are from the callee.
   */
  ownerInstructions: string;
}

/**
 * Represents a single turn in the live conversation.
 * After the initial owner instructions, all turns come from this structure.
 */
export interface ConversationTurn {
  /** Who spoke this turn */
  speaker: 'caller' | 'assistant' | 'ivr' | 'agent';
  /** The text content of the turn */
  text: string;
  /** ISO timestamp of when the turn occurred */
  timestamp: string;
}

/**
 * A chat message in the format expected by OpenAI-compatible APIs.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Context for building the full message array for an LLM call.
 */
export interface MessageBuildContext {
  /** The rendered prompt bundle */
  bundle: PromptBundle;

  /**
   * Rolling summary of the call so far (optional).
   * Provides compressed context for long conversations.
   */
  rollingSummary?: string;

  /**
   * Recent conversation turns from the live transcript.
   * These are the CALLEE's contributions (and agent responses).
   */
  transcriptTurns: ConversationTurn[];

  /**
   * The current user input that triggered this LLM call.
   * This is the latest utterance from the CALLEE.
   */
  currentUtterance?: string;
}

/**
 * Result of validating a prompt or message array.
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** List of validation errors (empty if valid) */
  errors: string[];
  /** List of validation warnings (non-fatal issues) */
  warnings: string[];
}

/**
 * The allowed variable names for prompt template rendering.
 * This is a strict allowlist - no other variables are permitted.
 */
export const ALLOWED_TEMPLATE_VARS = [
  'assistant_name',
  'owner_name',
  'recording_notice',
  'goal_text',
  'tone_override',
] as const;

export type AllowedTemplateVar = typeof ALLOWED_TEMPLATE_VARS[number];

/**
 * Default prompt configuration values.
 */
export const DEFAULT_PROMPT_CONFIG: Omit<PromptConfig, 'goalText'> = {
  assistantName: 'Pigeon',
  ownerName: 'the owner',
  recordingNotice: false,
};
