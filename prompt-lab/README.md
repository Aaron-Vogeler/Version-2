# Prompt Lab

Fast iteration workspace for testing and improving AI phone agent prompts.

## Quick Start

```bash
# Run all scenarios in MOCK mode (no LLM calls)
npm run prompt:lab

# Run with verbose output
npm run prompt:lab -- --verbose

# Run only date-policy scenarios
npm run prompt:lab -- --tags=date-policy

# Run in LIVE mode (requires GROQ_API_KEY)
npm run prompt:lab:live
```

## Modes

### MOCK Mode (Default)

Validates prompt structure, message ordering, and invariants **without** calling the LLM. This mode is:

- Fast (milliseconds per scenario)
- Free (no API costs)
- Deterministic (same input = same result)
- CI-friendly (no environment variables required)

Use MOCK mode for:
- Quick iteration on prompt structure
- Validating message ordering
- Checking invariants before deploying

### LIVE Mode

Calls the actual LLM (Groq) and validates the response. Requires:
- `GROQ_API_KEY` environment variable
- `GROQ_MODEL` (optional, defaults to `llama-3.1-8b-instant`)

Use LIVE mode for:
- Testing actual LLM responses
- Validating complex behaviors
- Generating golden responses

## Adding Scenarios

Create a new JSON file in `prompt-lab/scenarios/`:

```json
{
  "id": "my-scenario-id",
  "name": "Human-Readable Name",
  "description": "What this scenario tests",
  "tags": ["tag1", "tag2"],
  "goal": "The call goal text",
  "transcript": [
    {
      "speaker": "caller",
      "text": "Hello, how can I help you?"
    }
  ],
  "expectations": {
    "shouldContain": ["keyword1", "keyword2"],
    "shouldNotContain": ["badword"],
    "mustPreserveRelativeDates": true
  }
}
```

### Scenario Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier |
| `name` | Yes | Human-readable name |
| `description` | Yes | What this scenario tests |
| `tags` | Yes | Array of tags for filtering |
| `goal` | Yes | The call goal text |
| `assistantName` | No | Custom assistant name (default: "Pigeon") |
| `ownerName` | No | Custom owner name (default: "the owner") |
| `recordingNotice` | No | Include recording notice (default: false) |
| `transcript` | Yes | Array of transcript turns |
| `expectations` | Yes | Expected outcomes |

### Expectations

| Field | Type | Description |
|-------|------|-------------|
| `invariants` | Array | Custom invariant checks to run |
| `shouldContain` | Array | Patterns response SHOULD contain |
| `shouldNotContain` | Array | Patterns response should NOT contain |
| `shouldAskFollowUp` | Boolean | Agent should ask a follow-up |
| `shouldClose` | Boolean | Agent should close the call |
| `mustPreserveRelativeDates` | Boolean | No calendar date conversion |
| `shouldEscalate` | Boolean | Should trigger escalation |

## Using Fixtures

Fixtures are reusable transcript snippets in `prompt-lab/fixtures/`. Use them to avoid repeating common patterns.

## Invariant Validators

The following validators run automatically:

| Validator | Description |
|-----------|-------------|
| `messageOrdering` | System first, then owner instructions, then transcript |
| `systemPromptRoles` | System prompt contains required sections |
| `ownerInstructionsConfig` | Owner instructions are config, not dialogue |
| `assistantFormat` | Output is spoken words only (no JSON/markdown) |
| `noCalendarDate` | Relative dates not converted to calendar dates |
| `notConfigResponse` | First response isn't acknowledging config |

## CLI Options

```
--live           Run in LIVE mode (calls actual LLM)
--tags=<tags>    Filter by tags (comma-separated)
--id=<pattern>   Filter by scenario ID pattern (regex)
--verbose, -v    Show detailed output
--fail-fast      Stop on first failure
--update-goldens Update golden responses after run
--help, -h       Show help
```

## Examples

### Test date policy scenarios
```bash
npm run prompt:lab -- --tags=date-policy --verbose
```

### Test a specific scenario
```bash
npm run prompt:lab -- --id=which-monday
```

### Run critical scenarios in LIVE mode
```bash
GROQ_API_KEY=xxx npm run prompt:lab:live -- --tags=critical
```

## Directory Structure

```
prompt-lab/
├── scenarios/          # Scenario definitions (JSON)
│   ├── store-hours.json
│   ├── ivr-transfer.json
│   └── ...
├── fixtures/           # Reusable transcript snippets
│   ├── common-greetings.json
│   └── edge-cases.json
├── golden/             # Stored expected outputs (optional)
├── run.ts              # CLI runner
├── report.ts           # Report generation
├── types.ts            # Type definitions
└── README.md           # This file
```

## Integration with Tests

The prompt lab uses the same validators as the test suite. To run both:

```bash
# Run unit tests
npm test

# Run prompt lab
npm run prompt:lab

# Run prompt-specific tests only
npm run test:prompts
```

## Tips

1. **Start in MOCK mode** - Validate structure before calling LLM
2. **Use tags** - Group related scenarios for focused testing
3. **Check date policy** - Always test relative date preservation
4. **Watch for scope creep** - Test that agent stays on-goal
5. **Test edge cases** - IVR, transfers, hostile callers, etc.
