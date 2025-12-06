/**
 * Prompt Validators - Invariant Checking
 * ========================================
 * Deterministic validators for prompt and message invariants.
 * Used by both the test suite and the prompt lab runner.
 *
 * These validators enforce the THREE-PARTY MODEL:
 * 1. OWNER/DEVELOPER - Sets system prompt + FIRST user message (config only)
 * 2. AI AGENT - Outputs spoken words only
 * 3. CALLEE - Provides LIVE_TRANSCRIPT (all later user messages)
 */

import { ChatMessage, ValidationResult, PromptBundle } from './types';

/**
 * Validate that messages are in the correct order:
 * 1. System message (required, must be first)
 * 2. Owner instructions (first user message, contains CONFIG marker)
 * 3. Subsequent turns (alternating user/assistant for transcript)
 *
 * @param messages - Array of chat messages to validate
 * @returns ValidationResult with any ordering violations
 */
export function validateMessageOrdering(messages: ChatMessage[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (messages.length === 0) {
    errors.push('Message array is empty - must have at least system message');
    return { valid: false, errors, warnings };
  }

  // Check first message is system
  if (messages[0].role !== 'system') {
    errors.push(`First message must be system role, got: ${messages[0].role}`);
  }

  // Check for multiple system messages
  const systemMessages = messages.filter((m) => m.role === 'system');
  if (systemMessages.length > 1) {
    errors.push(`Found ${systemMessages.length} system messages - only 1 allowed`);
  }

  // Check system message is only at position 0
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === 'system') {
      errors.push(`System message found at position ${i} - must only be at position 0`);
    }
  }

  // If we have user messages, the first one should be owner instructions
  const userMessages = messages.filter((m) => m.role === 'user');
  if (userMessages.length > 0) {
    const firstUserMsg = userMessages[0];
    // Check for owner instructions markers
    const hasOwnerMarker =
      firstUserMsg.content.includes('OWNER') ||
      firstUserMsg.content.includes('CONFIG') ||
      firstUserMsg.content.includes('GOAL');

    if (!hasOwnerMarker) {
      warnings.push(
        'First user message does not contain OWNER/CONFIG/GOAL markers - ' +
          'ensure this is intentional (may indicate missing owner instructions)'
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate that the system prompt contains the essential role rules.
 * Checks for presence of key sections that define AI behavior.
 *
 * @param systemPrompt - The system prompt text
 * @returns ValidationResult with any missing sections
 */
export function validateSystemPromptContainsRoleRules(
  systemPrompt: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const requiredSections = [
    { marker: 'ROLE', description: 'Role definition' },
    { marker: 'GOAL FOCUS', description: 'Goal focus rules' },
    { marker: 'OUTPUT FORMAT', description: 'Output format constraints' },
    { marker: 'DATE/TIME POLICY', description: 'Date/time handling rules' },
    { marker: 'AUTHORITY LIMITS', description: 'Authority limits' },
  ];

  const recommendedSections = [
    { marker: 'PRIORITY', description: 'Priority ordering' },
    { marker: 'DISCLOSURE', description: 'AI disclosure rules' },
    { marker: 'STYLE', description: 'Communication style' },
    { marker: 'CONFIRMATION', description: 'Confirmation rules' },
    { marker: 'ESCALATE', description: 'Escalation rules' },
  ];

  for (const section of requiredSections) {
    if (!systemPrompt.includes(section.marker)) {
      errors.push(`Missing required section: ${section.marker} (${section.description})`);
    }
  }

  for (const section of recommendedSections) {
    if (!systemPrompt.includes(section.marker)) {
      warnings.push(`Missing recommended section: ${section.marker} (${section.description})`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate that owner instructions are config-only and not dialogue.
 * The owner instructions should contain clear markers indicating
 * they are configuration, not part of the conversation.
 *
 * @param ownerInstructions - The owner instructions text
 * @returns ValidationResult with any violations
 */
export function validateOwnerInstructionsConfigOnly(
  ownerInstructions: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Must contain clear config markers
  const configMarkers = [
    'OWNER',
    'CONFIG',
    'DO NOT RESPOND',
    'GOAL',
    'CALLEE_CONVERSATION_MODE',
  ];

  const foundMarkers = configMarkers.filter((marker) =>
    ownerInstructions.toUpperCase().includes(marker.toUpperCase())
  );

  if (foundMarkers.length < 2) {
    errors.push(
      `Owner instructions lack clear config markers. ` +
        `Found: [${foundMarkers.join(', ')}]. ` +
        `Should include at least 2 of: ${configMarkers.join(', ')}`
    );
  }

  // Must contain goal text (not be empty)
  if (ownerInstructions.trim().length < 50) {
    errors.push('Owner instructions too short - must include goal and execution rules');
  }

  // Should explicitly mention mode transition
  if (
    !ownerInstructions.includes('MODE') &&
    !ownerInstructions.includes('CALLEE') &&
    !ownerInstructions.includes('next')
  ) {
    warnings.push(
      'Owner instructions should mention mode transition to CALLEE_CONVERSATION_MODE'
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate that assistant utterance is in "spoken words only" format.
 * Checks for common violations like JSON, markdown, stage directions.
 *
 * @param text - The assistant's output text
 * @returns ValidationResult with any format violations
 */
export function validateAssistantUtteranceFormat(text: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for JSON
  if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
    errors.push('Assistant output appears to be JSON - should be spoken words only');
  }

  // Check for markdown headers
  if (/^#+\s/.test(text) || /\n#+\s/.test(text)) {
    errors.push('Assistant output contains markdown headers (##) - should be spoken words only');
  }

  // Check for markdown bold/italic
  if (/\*\*[^*]+\*\*/.test(text) || /\*[^*]+\*/.test(text)) {
    warnings.push('Assistant output contains markdown formatting (*) - may not render in TTS');
  }

  // Check for markdown lists
  if (/^\s*[-*]\s/.test(text) || /\n\s*[-*]\s/.test(text)) {
    warnings.push('Assistant output contains list markers - may not render well in TTS');
  }

  // Check for stage directions [like this] or (like this)
  if (/\[[^\]]+\]/.test(text) && !/\[\d+\]/.test(text)) {
    // Exclude numeric references like [1]
    errors.push('Assistant output contains stage directions in brackets - should be spoken words only');
  }

  if (/\([^)]*pause[^)]*\)/i.test(text) || /\([^)]*thinking[^)]*\)/i.test(text)) {
    errors.push('Assistant output contains stage directions - should be spoken words only');
  }

  // Check for XML/HTML tags
  if (/<[a-z][^>]*>/i.test(text)) {
    errors.push('Assistant output contains HTML/XML tags - should be spoken words only');
  }

  // Check for code blocks
  if (/```/.test(text)) {
    errors.push('Assistant output contains code blocks - should be spoken words only');
  }

  // Check for internal thought markers
  const thoughtMarkers = ['THINKING:', 'THOUGHT:', 'INTERNAL:', 'NOTE:'];
  for (const marker of thoughtMarkers) {
    if (text.toUpperCase().includes(marker)) {
      errors.push(
        `Assistant output contains internal thought marker "${marker}" - should be spoken words only`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate that text does not contain generated calendar dates when the goal
 * uses relative dates. This is a heuristic check - not perfect but catches
 * common violations.
 *
 * @param text - The assistant's output text
 * @param goalText - The original goal text (to check for relative dates)
 * @returns ValidationResult with any date policy violations
 */
export function validateNoCalendarDateGenerated(
  text: string,
  goalText: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Relative date patterns in the goal
  const relativePatterns = [
    /next\s+monday/i,
    /next\s+tuesday/i,
    /next\s+wednesday/i,
    /next\s+thursday/i,
    /next\s+friday/i,
    /next\s+saturday/i,
    /next\s+sunday/i,
    /next\s+week/i,
    /this\s+monday/i,
    /this\s+tuesday/i,
    /this\s+wednesday/i,
    /this\s+thursday/i,
    /this\s+friday/i,
    /this\s+saturday/i,
    /this\s+sunday/i,
    /this\s+week/i,
    /tomorrow/i,
    /the\s+day\s+after/i,
  ];

  // Check if goal contains relative dates
  const goalHasRelativeDates = relativePatterns.some((pattern) => pattern.test(goalText));

  if (!goalHasRelativeDates) {
    // No relative dates in goal, no validation needed
    return { valid: true, errors, warnings };
  }

  // Calendar date patterns that would indicate conversion
  // e.g., "January 15", "Jan 15", "1/15", "15th", "the 15th"
  const calendarPatterns = [
    // Month day patterns: "January 15", "Jan 15", "January 15th"
    /(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(st|nd|rd|th)?/i,
    // Abbreviated month: "Jan 15", "Feb 3rd"
    /(jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}(st|nd|rd|th)?/i,
    // Numeric dates: "1/15", "01/15", "1-15"
    /\b\d{1,2}[\/\-]\d{1,2}(\/\d{2,4})?\b/,
    // "the 15th", "the 23rd" (but not in context of "the next")
    /\bthe\s+\d{1,2}(st|nd|rd|th)\b(?!\s+of\s+(january|february|march|april|may|june|july|august|september|october|november|december))/i,
  ];

  for (const pattern of calendarPatterns) {
    if (pattern.test(text)) {
      errors.push(
        `Goal uses relative dates but assistant output contains calendar date. ` +
          `Goal: "${goalText.substring(0, 100)}..." ` +
          `Assistant should preserve relative dates (e.g., "next Monday") ` +
          `and not convert to specific calendar dates.`
      );
      break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate a complete PromptBundle.
 * Runs all relevant validators on system prompt and owner instructions.
 *
 * @param bundle - The prompt bundle to validate
 * @returns Combined ValidationResult
 */
export function validatePromptBundle(bundle: PromptBundle): ValidationResult {
  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  // Validate system prompt
  const systemResult = validateSystemPromptContainsRoleRules(bundle.system);
  allErrors.push(...systemResult.errors);
  allWarnings.push(...systemResult.warnings);

  // Validate owner instructions
  const ownerResult = validateOwnerInstructionsConfigOnly(bundle.ownerInstructions);
  allErrors.push(...ownerResult.errors);
  allWarnings.push(...ownerResult.warnings);

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}

/**
 * Validate a complete message array before sending to LLM.
 * This is the main entry point for pre-flight validation.
 *
 * @param messages - Array of chat messages
 * @param goalText - The goal text for date policy validation
 * @returns Combined ValidationResult
 */
export function validateMessagesPreFlight(
  messages: ChatMessage[],
  goalText: string
): ValidationResult {
  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  // Validate ordering
  const orderingResult = validateMessageOrdering(messages);
  allErrors.push(...orderingResult.errors);
  allWarnings.push(...orderingResult.warnings);

  // Validate system prompt if present
  if (messages.length > 0 && messages[0].role === 'system') {
    const systemResult = validateSystemPromptContainsRoleRules(messages[0].content);
    allErrors.push(...systemResult.errors);
    allWarnings.push(...systemResult.warnings);
  }

  // Validate first user message (owner instructions) if present
  const userMessages = messages.filter((m) => m.role === 'user');
  if (userMessages.length > 0) {
    const ownerResult = validateOwnerInstructionsConfigOnly(userMessages[0].content);
    // Only add errors if it looks like it should be owner instructions
    if (
      userMessages[0].content.includes('GOAL') ||
      userMessages[0].content.includes('OWNER')
    ) {
      allErrors.push(...ownerResult.errors);
    }
    allWarnings.push(...ownerResult.warnings);
  }

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}

/**
 * Quick check: does the text look like it's trying to respond to config as dialogue?
 * This is a heuristic to detect if the AI misunderstood owner instructions.
 *
 * @param text - The assistant's first response
 * @returns true if response looks like it's treating config as dialogue
 */
export function looksLikeConfigResponse(text: string): boolean {
  const configResponsePatterns = [
    /understood/i,
    /got it/i,
    /i understand/i,
    /i will/i,
    /i'll do/i,
    /okay,?\s*i/i,
    /sure,?\s*i/i,
    /acknowledged/i,
    /affirmative/i,
    /roger/i,
  ];

  const lowerText = text.toLowerCase().trim();

  // If response starts with a config acknowledgment, it's wrong
  for (const pattern of configResponsePatterns) {
    if (pattern.test(lowerText.substring(0, 50))) {
      return true;
    }
  }

  return false;
}
