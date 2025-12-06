#!/usr/bin/env ts-node
/**
 * Prompt Lab Runner
 * ==================
 * CLI tool to run prompt scenarios in MOCK or LIVE mode.
 *
 * Usage:
 *   npx ts-node prompt-lab/run.ts [options]
 *
 * Options:
 *   --live           Run in LIVE mode (calls actual LLM)
 *   --tags=<tags>    Filter by tags (comma-separated)
 *   --id=<pattern>   Filter by scenario ID pattern
 *   --verbose        Show detailed output
 *   --fail-fast      Stop on first failure
 *   --update-goldens Update golden responses after run
 *
 * Examples:
 *   npx ts-node prompt-lab/run.ts                     # Run all in MOCK mode
 *   npx ts-node prompt-lab/run.ts --tags=date-policy  # Run date-policy scenarios
 *   npx ts-node prompt-lab/run.ts --live              # Run with actual LLM (requires env vars)
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  Scenario,
  ScenarioResult,
  SuiteResult,
  RunnerConfig,
  TranscriptTurn,
  DEFAULT_INVARIANTS,
} from './types';

import {
  createPromptConfig,
  renderPromptBundle,
  buildMessages,
  validateMessageOrdering,
  validateSystemPromptContainsRoleRules,
  validateOwnerInstructionsConfigOnly,
  validateAssistantUtteranceFormat,
  validateNoCalendarDateGenerated,
  looksLikeConfigResponse,
  ConversationTurn,
  ChatMessage,
  PromptBundle,
} from '../ai-server/src/prompts';

import { generateReport, printSummary } from './report';

// ═══════════════════════════════════════════════════════════════════
// Scenario Loading
// ═══════════════════════════════════════════════════════════════════

const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const GOLDEN_DIR = path.join(__dirname, 'golden');

/**
 * Load all scenarios from the scenarios directory.
 */
function loadScenarios(): Scenario[] {
  const scenarios: Scenario[] = [];

  if (!fs.existsSync(SCENARIOS_DIR)) {
    console.error(`Scenarios directory not found: ${SCENARIOS_DIR}`);
    return scenarios;
  }

  const files = fs.readdirSync(SCENARIOS_DIR);

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    const filePath = path.join(SCENARIOS_DIR, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const scenario = JSON.parse(content) as Scenario;
      scenarios.push(scenario);
    } catch (error) {
      console.error(`Error loading scenario ${file}:`, error);
    }
  }

  return scenarios;
}

/**
 * Filter scenarios based on config.
 */
function filterScenarios(scenarios: Scenario[], config: RunnerConfig): Scenario[] {
  let filtered = scenarios;

  if (config.tags && config.tags.length > 0) {
    filtered = filtered.filter((s) =>
      config.tags!.some((tag) => s.tags.includes(tag))
    );
  }

  if (config.idPattern) {
    const pattern = new RegExp(config.idPattern);
    filtered = filtered.filter((s) => pattern.test(s.id));
  }

  return filtered;
}

// ═══════════════════════════════════════════════════════════════════
// Scenario Execution
// ═══════════════════════════════════════════════════════════════════

/**
 * Convert TranscriptTurn to ConversationTurn.
 */
function toConversationTurn(turn: TranscriptTurn): ConversationTurn {
  return {
    speaker: turn.speaker as 'caller' | 'assistant' | 'ivr',
    text: turn.text,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Run a single scenario in MOCK mode.
 * Validates invariants without calling the LLM.
 */
function runScenarioMock(scenario: Scenario): ScenarioResult {
  const startTime = Date.now();
  const errors: string[] = [];
  const warnings: string[] = [];

  // Build the prompt config
  const config = createPromptConfig({
    goalText: scenario.goal,
    assistantName: scenario.assistantName || 'Pigeon',
    ownerName: scenario.ownerName || 'the owner',
    recordingNotice: scenario.recordingNotice || false,
  });

  // Render the prompt bundle
  const bundle = renderPromptBundle(config);

  // Convert transcript turns
  const transcriptTurns = scenario.transcript.map(toConversationTurn);

  // Build messages
  const messages = buildMessages({
    bundle,
    transcriptTurns,
  });

  // Run invariant validators
  const invariants = scenario.expectations.invariants || DEFAULT_INVARIANTS;

  for (const invariant of invariants) {
    let result;

    switch (invariant.validator) {
      case 'messageOrdering':
        result = validateMessageOrdering(messages);
        break;
      case 'systemPromptRoles':
        result = validateSystemPromptContainsRoleRules(bundle.system);
        break;
      case 'ownerInstructionsConfig':
        result = validateOwnerInstructionsConfigOnly(bundle.ownerInstructions);
        break;
      case 'assistantFormat':
        // In mock mode, check the assistant turns in transcript
        const assistantTurns = scenario.transcript.filter(
          (t) => t.speaker === 'assistant'
        );
        for (const turn of assistantTurns) {
          const formatResult = validateAssistantUtteranceFormat(turn.text);
          if (!formatResult.valid) {
            if (invariant.required) {
              errors.push(...formatResult.errors);
            } else {
              warnings.push(...formatResult.errors);
            }
          }
          warnings.push(...formatResult.warnings);
        }
        continue;
      case 'noCalendarDate':
        // In mock mode, check the assistant turns in transcript
        const calendarTurns = scenario.transcript.filter(
          (t) => t.speaker === 'assistant'
        );
        for (const turn of calendarTurns) {
          const dateResult = validateNoCalendarDateGenerated(
            turn.text,
            scenario.goal
          );
          if (!dateResult.valid) {
            if (invariant.required) {
              errors.push(...dateResult.errors);
            } else {
              warnings.push(...dateResult.errors);
            }
          }
          warnings.push(...dateResult.warnings);
        }
        continue;
      case 'notConfigResponse':
        // Check if any assistant response looks like config acknowledgment
        const configTurns = scenario.transcript.filter(
          (t) => t.speaker === 'assistant'
        );
        if (configTurns.length > 0 && looksLikeConfigResponse(configTurns[0].text)) {
          const msg =
            'First assistant response looks like it responded to config as dialogue';
          if (invariant.required) {
            errors.push(msg);
          } else {
            warnings.push(msg);
          }
        }
        continue;
      default:
        warnings.push(`Unknown validator: ${invariant.validator}`);
        continue;
    }

    if (result && !result.valid) {
      if (invariant.required) {
        errors.push(...result.errors);
      } else {
        warnings.push(...result.errors);
      }
    }
    if (result) {
      warnings.push(...result.warnings);
    }
  }

  const durationMs = Date.now() - startTime;

  return {
    scenario,
    passed: errors.length === 0,
    errors,
    warnings,
    messages,
    durationMs,
    isLiveMode: false,
  };
}

/**
 * Run a single scenario in LIVE mode.
 * Calls the actual LLM and validates the response.
 */
async function runScenarioLive(scenario: Scenario): Promise<ScenarioResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  const warnings: string[] = [];

  // First run mock validation
  const mockResult = runScenarioMock(scenario);
  errors.push(...mockResult.errors);
  warnings.push(...mockResult.warnings);

  // If mock validation failed, don't call LLM
  if (mockResult.errors.length > 0) {
    return {
      ...mockResult,
      isLiveMode: true,
      durationMs: Date.now() - startTime,
    };
  }

  // Check if we have the required environment variables
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    warnings.push('GROQ_API_KEY not set - skipping LLM call');
    return {
      ...mockResult,
      isLiveMode: true,
      durationMs: Date.now() - startTime,
    };
  }

  try {
    // Dynamic import to avoid requiring groq in mock mode
    const OpenAI = (await import('openai')).default;

    const groq = new OpenAI({
      apiKey: groqApiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });

    const response = await groq.chat.completions.create({
      model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
      messages: mockResult.messages,
      temperature: 0.2,
    });

    const assistantResponse = response.choices[0]?.message?.content || '';

    // Validate the response
    const formatResult = validateAssistantUtteranceFormat(assistantResponse);
    if (!formatResult.valid) {
      errors.push(...formatResult.errors);
    }
    warnings.push(...formatResult.warnings);

    // Check date policy
    if (scenario.expectations.mustPreserveRelativeDates) {
      const dateResult = validateNoCalendarDateGenerated(
        assistantResponse,
        scenario.goal
      );
      if (!dateResult.valid) {
        errors.push(...dateResult.errors);
      }
      warnings.push(...dateResult.warnings);
    }

    // Check for config response
    if (looksLikeConfigResponse(assistantResponse)) {
      errors.push('Assistant responded to config as dialogue');
    }

    // Check shouldContain
    if (scenario.expectations.shouldContain) {
      for (const pattern of scenario.expectations.shouldContain) {
        if (!assistantResponse.toLowerCase().includes(pattern.toLowerCase())) {
          errors.push(`Response should contain: "${pattern}"`);
        }
      }
    }

    // Check shouldNotContain
    if (scenario.expectations.shouldNotContain) {
      for (const pattern of scenario.expectations.shouldNotContain) {
        if (assistantResponse.toLowerCase().includes(pattern.toLowerCase())) {
          errors.push(`Response should NOT contain: "${pattern}"`);
        }
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      scenario,
      passed: errors.length === 0,
      errors,
      warnings,
      messages: mockResult.messages,
      response: assistantResponse,
      durationMs,
      isLiveMode: true,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    errors.push(`LLM call failed: ${error}`);

    return {
      scenario,
      passed: false,
      errors,
      warnings,
      messages: mockResult.messages,
      durationMs,
      isLiveMode: true,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Main Runner
// ═══════════════════════════════════════════════════════════════════

/**
 * Run all scenarios matching the config.
 */
async function runSuite(config: RunnerConfig): Promise<SuiteResult> {
  const allScenarios = loadScenarios();
  const scenarios = filterScenarios(allScenarios, config);

  console.log(`\nPrompt Lab - ${config.liveMode ? 'LIVE' : 'MOCK'} Mode`);
  console.log(`Running ${scenarios.length} of ${allScenarios.length} scenarios\n`);

  const results: ScenarioResult[] = [];
  const startTime = Date.now();

  for (const scenario of scenarios) {
    if (config.verbose) {
      console.log(`  Running: ${scenario.id}...`);
    }

    const result = config.liveMode
      ? await runScenarioLive(scenario)
      : runScenarioMock(scenario);

    results.push(result);

    if (config.verbose) {
      const status = result.passed ? 'PASS' : 'FAIL';
      console.log(`    ${status} (${result.durationMs}ms)`);
      if (!result.passed) {
        for (const error of result.errors) {
          console.log(`      ERROR: ${error}`);
        }
      }
    } else {
      process.stdout.write(result.passed ? '.' : 'F');
    }

    if (config.failFast && !result.passed) {
      console.log('\n\nStopping on first failure (--fail-fast)');
      break;
    }
  }

  if (!config.verbose) {
    console.log('');
  }

  const totalDurationMs = Date.now() - startTime;

  return {
    total: scenarios.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    skipped: allScenarios.length - scenarios.length,
    results,
    totalDurationMs,
    isLiveMode: config.liveMode,
  };
}

// ═══════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════

function parseArgs(): RunnerConfig {
  const args = process.argv.slice(2);
  const config: RunnerConfig = {
    liveMode: false,
    verbose: false,
    failFast: false,
  };

  for (const arg of args) {
    if (arg === '--live') {
      config.liveMode = true;
    } else if (arg === '--verbose' || arg === '-v') {
      config.verbose = true;
    } else if (arg === '--fail-fast') {
      config.failFast = true;
    } else if (arg === '--update-goldens') {
      config.updateGoldens = true;
    } else if (arg.startsWith('--tags=')) {
      config.tags = arg.substring(7).split(',');
    } else if (arg.startsWith('--id=')) {
      config.idPattern = arg.substring(5);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Prompt Lab Runner

Usage:
  npx ts-node prompt-lab/run.ts [options]

Options:
  --live           Run in LIVE mode (calls actual LLM)
  --tags=<tags>    Filter by tags (comma-separated)
  --id=<pattern>   Filter by scenario ID pattern
  --verbose, -v    Show detailed output
  --fail-fast      Stop on first failure
  --update-goldens Update golden responses after run
  --help, -h       Show this help message

Examples:
  npx ts-node prompt-lab/run.ts                     # Run all in MOCK mode
  npx ts-node prompt-lab/run.ts --tags=date-policy  # Run date-policy scenarios
  npx ts-node prompt-lab/run.ts --live              # Run with actual LLM
`);
      process.exit(0);
    }
  }

  return config;
}

// Main entry point
async function main() {
  const config = parseArgs();
  const result = await runSuite(config);

  printSummary(result);

  // Generate detailed report
  const reportPath = path.join(__dirname, 'last-run.json');
  const report = generateReport(result);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  if (config.verbose) {
    console.log(`\nDetailed report saved to: ${reportPath}`);
  }

  // Exit with error code if any failures
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
