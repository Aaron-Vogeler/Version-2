/**
 * Prompt Rendering - Template substitution with strict allowlist
 */

import { PromptConfig, PromptBundle, DEFAULT_PROMPT_CONFIG } from './types';
import { SYSTEM_PROMPT_TEMPLATE, RECORDING_NOTICE_TEXT, OWNER_INSTRUCTIONS_TEMPLATE } from './templates';

const ALLOWED_VARS = ['assistant_name', 'owner_name', 'recording_notice', 'goal_text'] as const;

export function renderTemplate(
  template: string,
  variables: Record<string, string>
): string {
  let result = template;

  for (const varName of ALLOWED_VARS) {
    const value = variables[varName];
    if (value !== undefined) {
      result = result.replace(new RegExp(`\\{\\{${varName}\\}\\}`, 'g'), value);
    }
  }

  return result;
}

export function renderPromptBundle(config: PromptConfig): PromptBundle {
  const recordingNotice = config.recordingNotice ? RECORDING_NOTICE_TEXT : '';

  const vars: Record<string, string> = {
    assistant_name: config.assistantName,
    owner_name: config.ownerName,
    recording_notice: recordingNotice,
    goal_text: config.goalText,
  };

  return {
    system: renderTemplate(SYSTEM_PROMPT_TEMPLATE, vars),
    ownerInstructions: renderTemplate(OWNER_INSTRUCTIONS_TEMPLATE, vars),
  };
}

export function createPromptConfig(
  partial: Partial<PromptConfig> & { goalText: string }
): PromptConfig {
  return {
    ...DEFAULT_PROMPT_CONFIG,
    ...partial,
  };
}
