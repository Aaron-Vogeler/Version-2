/**
 * Prompt Types - Shared between browser and CLI
 */

export interface PromptConfig {
  assistantName: string;
  ownerName: string;
  recordingNotice: boolean;
  goalText: string;
}

export interface PromptBundle {
  system: string;
  ownerInstructions: string;
}

export interface ConversationTurn {
  speaker: 'caller' | 'assistant' | 'ivr' | 'agent';
  text: string;
  timestamp: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  tags: string[];
  goal: string;
  assistantName?: string;
  ownerName?: string;
  recordingNotice?: boolean;
  transcript: { speaker: 'caller' | 'assistant' | 'ivr'; text: string }[];
  expectations: {
    shouldContain?: string[];
    shouldNotContain?: string[];
    mustPreserveRelativeDates?: boolean;
    shouldAskFollowUp?: boolean;
    shouldClose?: boolean;
    shouldEscalate?: boolean;
  };
}

export interface ScenarioResult {
  scenarioId: string;
  passed: boolean;
  errors: string[];
  warnings: string[];
  messages: ChatMessage[];
  response?: string;
  durationMs: number;
}

export const DEFAULT_PROMPT_CONFIG: Omit<PromptConfig, 'goalText'> = {
  assistantName: 'Pigeon',
  ownerName: 'the owner',
  recordingNotice: false,
};
