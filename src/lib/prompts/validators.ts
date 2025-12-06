/**
 * Prompt Validators - Invariant checking
 */

import { ChatMessage, ValidationResult, PromptBundle } from './types';

export function validateMessageOrdering(messages: ChatMessage[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (messages.length === 0) {
    errors.push('Message array is empty');
    return { valid: false, errors, warnings };
  }

  if (messages[0].role !== 'system') {
    errors.push(`First message must be system role, got: ${messages[0].role}`);
  }

  const systemCount = messages.filter((m) => m.role === 'system').length;
  if (systemCount > 1) {
    errors.push(`Found ${systemCount} system messages - only 1 allowed`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateSystemPromptContainsRoleRules(systemPrompt: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const required = ['ROLE', 'GOAL FOCUS', 'OUTPUT FORMAT', 'DATE/TIME POLICY', 'AUTHORITY LIMITS'];

  for (const section of required) {
    if (!systemPrompt.includes(section)) {
      errors.push(`Missing required section: ${section}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateAssistantUtteranceFormat(text: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
    errors.push('Output appears to be JSON - should be spoken words only');
  }

  if (/^#+\s/.test(text) || /\n#+\s/.test(text)) {
    errors.push('Output contains markdown headers');
  }

  if (/\[[^\]]+\]/.test(text) && !/\[\d+\]/.test(text)) {
    errors.push('Output contains stage directions in brackets');
  }

  if (/\([^)]*pause[^)]*\)/i.test(text) || /\([^)]*thinking[^)]*\)/i.test(text)) {
    errors.push('Output contains stage directions');
  }

  if (/<[a-z][^>]*>/i.test(text)) {
    errors.push('Output contains HTML/XML tags');
  }

  if (/```/.test(text)) {
    errors.push('Output contains code blocks');
  }

  const thoughtMarkers = ['THINKING:', 'THOUGHT:', 'INTERNAL:', 'NOTE:'];
  for (const marker of thoughtMarkers) {
    if (text.toUpperCase().includes(marker)) {
      errors.push(`Output contains internal thought marker "${marker}"`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateNoCalendarDateGenerated(text: string, goalText: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const relativePatterns = [
    /next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)/i,
    /this\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)/i,
    /tomorrow/i,
  ];

  const hasRelativeDates = relativePatterns.some((p) => p.test(goalText));
  if (!hasRelativeDates) {
    return { valid: true, errors, warnings };
  }

  const calendarPatterns = [
    /(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/i,
    /(jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}/i,
    /\b\d{1,2}[\/\-]\d{1,2}(\/\d{2,4})?\b/,
  ];

  for (const pattern of calendarPatterns) {
    if (pattern.test(text)) {
      errors.push('Goal uses relative dates but response contains calendar date');
      break;
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function looksLikeConfigResponse(text: string): boolean {
  const patterns = [
    /^understood/i,
    /^got it/i,
    /^i understand/i,
    /^i will/i,
    /^okay,?\s*i/i,
    /^sure,?\s*i/i,
    /^acknowledged/i,
  ];

  const start = text.toLowerCase().trim().substring(0, 50);
  return patterns.some((p) => p.test(start));
}

export function validatePromptBundle(bundle: PromptBundle): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const systemResult = validateSystemPromptContainsRoleRules(bundle.system);
  errors.push(...systemResult.errors);
  warnings.push(...systemResult.warnings);

  if (!bundle.ownerInstructions.includes('OWNER') || !bundle.ownerInstructions.includes('GOAL')) {
    errors.push('Owner instructions missing required markers');
  }

  return { valid: errors.length === 0, errors, warnings };
}
