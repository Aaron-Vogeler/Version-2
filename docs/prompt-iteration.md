# How to Iterate on Prompts Safely

This guide explains how to make changes to the AI phone agent's prompts without risking production stability.

## Architecture Overview

The prompt system is built on a **THREE-PARTY MODEL**:

```
1. OWNER/DEVELOPER  - Sets system prompt + first user message (config only)
2. AI AGENT         - Outputs spoken words only
3. CALLEE           - Provides live transcript (all later user messages)
```

### Key Files

| File | Purpose |
|------|---------|
| `ai-server/src/prompts/systemPrompt.ts` | Agent role definition (WHO the agent is) |
| `ai-server/src/prompts/ownerInstructionsTemplate.ts` | Per-call goal config (WHAT to do) |
| `ai-server/src/prompts/types.ts` | Type definitions and config structure |
| `ai-server/src/prompts/render.ts` | Template rendering with strict allowlist |
| `ai-server/src/prompts/buildMessages.ts` | Message array construction |
| `ai-server/src/prompts/validators.ts` | Invariant checking functions |

## Safe Iteration Workflow

### 1. Make Your Change

Edit the prompt templates in `ai-server/src/prompts/`:

```typescript
// ai-server/src/prompts/systemPrompt.ts
export const SYSTEM_PROMPT_TEMPLATE = `
AI PHONE AGENT — SYSTEM

ROLE
You are {{assistant_name}}, an AI voice agent...
// ... your changes here
`;
```

### 2. Run MOCK Validation

```bash
npm run prompt:lab
```

This validates:
- Message ordering is correct
- Required sections are present
- Three-party rules are enforced
- No format violations (JSON, markdown, etc.)

### 3. Run Prompt-Specific Tests

```bash
npm run test:prompts
```

This runs the automated test suite for:
- Invariants (structure, ordering)
- Role switching (config vs. dialogue)
- Date policy (no calendar conversion)
- Output format (spoken words only)

### 4. Test with Specific Scenarios

```bash
# Test date-related scenarios
npm run prompt:lab -- --tags=date-policy --verbose

# Test a specific scenario
npm run prompt:lab -- --id=which-monday --verbose
```

### 5. (Optional) Run LIVE Validation

If you have `GROQ_API_KEY` set:

```bash
npm run prompt:lab:live -- --tags=critical
```

This calls the actual LLM and validates responses.

### 6. Deploy

Once all tests pass, deploy your changes normally.

## Adding a New Prompt Section

1. Add the section to `systemPrompt.ts`
2. Add validation for it in `validators.ts`
3. Add a test case in `tests/prompts/invariants.test.ts`
4. Create a scenario in `prompt-lab/scenarios/` to test behavior

## Template Variables

The following variables can be used in templates:

| Variable | Description |
|----------|-------------|
| `{{assistant_name}}` | Name of the AI assistant |
| `{{owner_name}}` | Name of the owner/user |
| `{{recording_notice}}` | Recording disclosure text |
| `{{goal_text}}` | The specific call goal |
| `{{tone_override}}` | Optional tone customization |

**IMPORTANT:** Only these variables are allowed. The renderer uses a strict allowlist.

## Common Pitfalls

### Treating Config as Dialogue

The owner instructions are CONFIG, not conversation. The AI should:
- Output an opening greeting
- NOT say "Understood" or "Got it"

Test this with:
```bash
npm run test:prompts -- --testNamePattern="Config vs Dialogue"
```

### Calendar Date Conversion

If the goal says "next Monday", the agent must NOT convert to "January 15".

Test this with:
```bash
npm run prompt:lab -- --tags=date-policy
```

### Output Format Violations

The agent must output ONLY spoken words. No JSON, markdown, or stage directions.

Test this with:
```bash
npm run test:prompts -- --testNamePattern="Output Format"
```

## Scenario-Based Testing

See [prompt-lab/README.md](../prompt-lab/README.md) for detailed scenario documentation.

### Quick Examples

```bash
# Run all scenarios
npm run prompt:lab

# Run with verbose output
npm run prompt:lab:verbose

# Run critical scenarios only
npm run prompt:lab -- --tags=critical

# Run escalation scenarios
npm run prompt:lab -- --tags=escalation
```

## Rollback

If issues are detected in production:

1. Revert your prompt changes
2. Re-run tests to confirm fix
3. Deploy the revert

The prompt module is isolated from telephony logic, so prompt changes don't affect call routing, recording, or other infrastructure.
