/**
 * Prompt Lab - Type Definitions
 * ==============================
 * Types for scenarios, fixtures, and test results.
 */

import { ConversationTurn, ChatMessage } from '../ai-server/src/prompts/types';

/**
 * A prompt lab scenario defines a complete test case.
 */
export interface Scenario {
  /** Unique identifier for this scenario */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description of what this scenario tests */
  description: string;

  /** Tags for filtering scenarios */
  tags: string[];

  /** The goal text for this call */
  goal: string;

  /** Optional custom assistant name (defaults to "Pigeon") */
  assistantName?: string;

  /** Optional custom owner name (defaults to "the owner") */
  ownerName?: string;

  /** Whether to include recording notice */
  recordingNotice?: boolean;

  /** The transcript turns that simulate the conversation */
  transcript: TranscriptTurn[];

  /** Expected outcomes to validate */
  expectations: ScenarioExpectations;

  /** Optional: ID of a golden response to compare against */
  goldenId?: string;
}

/**
 * A turn in the scenario transcript.
 * Simpler than ConversationTurn - just speaker and text.
 */
export interface TranscriptTurn {
  speaker: 'caller' | 'assistant' | 'ivr';
  text: string;
}

/**
 * Expected outcomes for a scenario.
 */
export interface ScenarioExpectations {
  /**
   * Invariants that must pass (from validators).
   * If empty, all default invariants are run.
   */
  invariants?: InvariantCheck[];

  /**
   * Patterns that the assistant response SHOULD contain.
   * Uses regex or substring matching.
   */
  shouldContain?: string[];

  /**
   * Patterns that the assistant response should NOT contain.
   * Uses regex or substring matching.
   */
  shouldNotContain?: string[];

  /**
   * Whether the assistant should ask a follow-up question.
   */
  shouldAskFollowUp?: boolean;

  /**
   * Whether the assistant should attempt to close the call.
   */
  shouldClose?: boolean;

  /**
   * Whether the response should preserve relative dates.
   */
  mustPreserveRelativeDates?: boolean;

  /**
   * Whether this is expected to trigger an escalation.
   */
  shouldEscalate?: boolean;

  /**
   * Custom validation function name (for advanced cases).
   */
  customValidator?: string;
}

/**
 * An invariant check to run.
 */
export interface InvariantCheck {
  /** Name of the validator function */
  validator:
    | 'messageOrdering'
    | 'systemPromptRoles'
    | 'ownerInstructionsConfig'
    | 'assistantFormat'
    | 'noCalendarDate'
    | 'notConfigResponse';

  /** Whether this check is required (error) or optional (warning) */
  required: boolean;
}

/**
 * Result of running a single scenario.
 */
export interface ScenarioResult {
  /** The scenario that was run */
  scenario: Scenario;

  /** Whether the scenario passed all checks */
  passed: boolean;

  /** List of errors that caused failure */
  errors: string[];

  /** List of warnings (non-fatal issues) */
  warnings: string[];

  /** The messages sent to the LLM (for debugging) */
  messages: ChatMessage[];

  /** The assistant's response (if LIVE mode) */
  response?: string;

  /** Time taken to run the scenario (ms) */
  durationMs: number;

  /** Whether this was run in LIVE mode */
  isLiveMode: boolean;
}

/**
 * Result of running a full test suite.
 */
export interface SuiteResult {
  /** Total scenarios run */
  total: number;

  /** Number of scenarios that passed */
  passed: number;

  /** Number of scenarios that failed */
  failed: number;

  /** Number of scenarios that were skipped */
  skipped: number;

  /** Individual scenario results */
  results: ScenarioResult[];

  /** Total duration (ms) */
  totalDurationMs: number;

  /** Whether this was run in LIVE mode */
  isLiveMode: boolean;
}

/**
 * A fixture is a reusable transcript snippet.
 */
export interface Fixture {
  /** Unique identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description of what this fixture represents */
  description: string;

  /** The transcript turns */
  turns: TranscriptTurn[];
}

/**
 * A golden response for snapshot testing.
 */
export interface GoldenResponse {
  /** Unique identifier */
  id: string;

  /** The scenario this golden is for */
  scenarioId: string;

  /** The expected response */
  response: string;

  /** Timestamp when this golden was created */
  createdAt: string;

  /** Model used to generate this golden */
  model: string;
}

/**
 * Configuration for the prompt lab runner.
 */
export interface RunnerConfig {
  /** Run in LIVE mode (calls actual LLM) */
  liveMode: boolean;

  /** Filter scenarios by tag */
  tags?: string[];

  /** Filter scenarios by ID pattern */
  idPattern?: string;

  /** Update golden responses after run */
  updateGoldens?: boolean;

  /** Verbose output */
  verbose?: boolean;

  /** Stop on first failure */
  failFast?: boolean;
}

/**
 * Default invariant checks to run on every scenario.
 */
export const DEFAULT_INVARIANTS: InvariantCheck[] = [
  { validator: 'messageOrdering', required: true },
  { validator: 'systemPromptRoles', required: true },
  { validator: 'ownerInstructionsConfig', required: true },
  { validator: 'assistantFormat', required: true },
  { validator: 'noCalendarDate', required: true },
];
