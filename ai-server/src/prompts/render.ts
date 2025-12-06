/**
 * Prompt Renderer - Strict Allowlist Template Rendering
 * =======================================================
 * Renders prompt templates with variable substitution using a strict allowlist.
 * Prevents injection vulnerabilities by only allowing known safe variables.
 */

import {
  PromptConfig,
  PromptBundle,
  ALLOWED_TEMPLATE_VARS,
  AllowedTemplateVar,
  DEFAULT_PROMPT_CONFIG,
} from './types';
import { SYSTEM_PROMPT_TEMPLATE, RECORDING_NOTICE_TEXT } from './systemPrompt';
import { OWNER_INSTRUCTIONS_TEMPLATE } from './ownerInstructionsTemplate';

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Render a template string by replacing {{variable_name}} placeholders
 * with values from the provided variables map.
 *
 * Uses a strict allowlist - only variables in ALLOWED_TEMPLATE_VARS are permitted.
 * Unknown variables in the template will throw an error.
 *
 * @param template - The template string with {{variable}} placeholders
 * @param variables - Map of variable names to their values
 * @param strict - If true, throws on unknown variables; if false, leaves them as-is
 * @returns The rendered template string
 * @throws Error if strict mode and an unknown variable is encountered
 */
export function renderTemplate(
  template: string,
  variables: Partial<Record<AllowedTemplateVar, string>>,
  strict: boolean = true
): string {
  let result = template;

  // Find all {{variable}} patterns in the template
  const variablePattern = /\{\{(\w+)\}\}/g;
  const foundVariables = new Set<string>();
  let match;

  while ((match = variablePattern.exec(template)) !== null) {
    foundVariables.add(match[1]);
  }

  // Validate all found variables are in allowlist (strict mode)
  if (strict) {
    for (const varName of foundVariables) {
      if (!ALLOWED_TEMPLATE_VARS.includes(varName as AllowedTemplateVar)) {
        throw new Error(
          `Unknown template variable: {{${varName}}}. ` +
            `Allowed variables: ${ALLOWED_TEMPLATE_VARS.join(', ')}`
        );
      }
    }
  }

  // Replace each allowed variable with its value
  for (const varName of ALLOWED_TEMPLATE_VARS) {
    const value = variables[varName];
    if (value !== undefined) {
      const pattern = new RegExp(escapeRegex(`{{${varName}}}`), 'g');
      result = result.replace(pattern, value);
    }
  }

  return result;
}

/**
 * Build a complete PromptBundle from a PromptConfig.
 * This is the main entry point for rendering prompts.
 *
 * @param config - The prompt configuration with all values
 * @returns A fully rendered PromptBundle ready for LLM consumption
 */
export function renderPromptBundle(config: PromptConfig): PromptBundle {
  // Build the recording notice line (or empty string if disabled)
  const recordingNotice = config.recordingNotice
    ? RECORDING_NOTICE_TEXT
    : '';

  // Map config to template variables
  const templateVars: Partial<Record<AllowedTemplateVar, string>> = {
    assistant_name: config.assistantName,
    owner_name: config.ownerName,
    recording_notice: recordingNotice,
    goal_text: config.goalText,
  };

  // Add tone override if provided
  if (config.toneOverride) {
    templateVars.tone_override = config.toneOverride;
  }

  // Render both templates
  const system = renderTemplate(SYSTEM_PROMPT_TEMPLATE, templateVars);
  const ownerInstructions = renderTemplate(OWNER_INSTRUCTIONS_TEMPLATE, templateVars);

  return {
    system,
    ownerInstructions,
  };
}

/**
 * Create a PromptConfig from partial values, filling in defaults.
 *
 * @param partial - Partial config with at least goalText required
 * @returns Complete PromptConfig with defaults applied
 */
export function createPromptConfig(
  partial: Partial<PromptConfig> & { goalText: string }
): PromptConfig {
  return {
    ...DEFAULT_PROMPT_CONFIG,
    ...partial,
  };
}

/**
 * Quickly render just the system prompt (for validation/testing).
 */
export function renderSystemPrompt(config: Omit<PromptConfig, 'goalText'>): string {
  const recordingNotice = config.recordingNotice ? RECORDING_NOTICE_TEXT : '';

  return renderTemplate(SYSTEM_PROMPT_TEMPLATE, {
    assistant_name: config.assistantName,
    owner_name: config.ownerName,
    recording_notice: recordingNotice,
  });
}

/**
 * Quickly render just the owner instructions (for validation/testing).
 */
export function renderOwnerInstructions(goalText: string): string {
  return renderTemplate(OWNER_INSTRUCTIONS_TEMPLATE, {
    goal_text: goalText,
  });
}
