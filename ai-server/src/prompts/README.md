# System Prompts Module

This module handles dynamic system prompt generation for the AI phone agent, with seamless integration to Supabase user data and dashboard-provided call goals.

## Architecture Overview

The prompts module maintains separation of concerns while preserving all data flows:

```
┌─────────────────────────────────────────────────────────────────┐
│                    UI DASHBOARD                                │
│         (delegate-call.tsx form submission)                    │
└─────────────────────┬───────────────────────────────────────────┘
                      │ POST /api/delegate
                      ↓
┌─────────────────────────────────────────────────────────────────┐
│              NEXT.JS API (delegate.ts)                          │
│  • Fetches from Supabase: custom_assistant_name, first_name    │
│  • Passes to AI Server: goal, assistantName, userName           │
└─────────────────────┬───────────────────────────────────────────┘
                      │ POST /api/outbound-call
                      ↓
┌─────────────────────────────────────────────────────────────────┐
│          AI SERVER OUTBOUND CALL (routes/outbound-call.ts)     │
│  • Encodes data in Telnyx client_state (base64 JSON)           │
│  • Sends to Telnyx Call Control API                            │
└─────────────────────┬───────────────────────────────────────────┘
                      │ Telnyx WebSocket
                      ↓
┌─────────────────────────────────────────────────────────────────┐
│            AI SERVER (index.ts WebSocket Handler)              │
│  • Decodes client_state from "start" event                     │
│  • Populates CallContext: goal, userId, assistantName, userName│
└─────────────────────┬───────────────────────────────────────────┘
                      │ CallContext with dynamic data
                      ↓
┌─────────────────────────────────────────────────────────────────┐
│       LLM PIPELINE (pipeline/llm.ts)                            │
│  • Calls generateAssistantReply(userText, context)             │
│  • Calls buildSystemPrompt(context) with populated context     │
└─────────────────────┬───────────────────────────────────────────┘
                      │ Populated CallContext
                      ↓
┌─────────────────────────────────────────────────────────────────┐
│   PROMPTS MODULE (prompts/system-prompt.ts)                    │
│  • buildSystemPrompt(context) receives CallContext             │
│  • Interpolates {{PLACEHOLDER}} with context values            │
│  • Returns system prompt with custom names and goal            │
└─────────────────────┬───────────────────────────────────────────┘
                      │ Complete system prompt
                      ↓
┌─────────────────────────────────────────────────────────────────┐
│          GROQ LLM API                                          │
│  • Sends system prompt with injected context                   │
│  • Gets AI response for call                                   │
└─────────────────────────────────────────────────────────────────┘
```

## File Structure

### `system-prompt.ts`
Core module responsible for:
- **`BASE_SYSTEM_PROMPT`**: Template with `{{PLACEHOLDER}}` markers for safe substitution
- **`GOAL_SECTION_TEMPLATE`**: Optional goal-specific rules appended when goal is provided
- **`interpolate()`**: Safe placeholder replacement function
- **`buildSystemPrompt(context?)`**: Main function that builds the complete prompt

### How Data Flows

1. **Dashboard Form** → Custom names and goal entered by user
2. **Next.js API** → Fetches Supabase profile data (custom_assistant_name, first_name)
3. **AI Server** → Encodes all data in Telnyx's client_state parameter
4. **WebSocket Handler** → Decodes client_state, populates CallContext
5. **LLM Pipeline** → Passes CallContext to buildSystemPrompt()
6. **Prompts Module** → Interpolates placeholders with context values
7. **Groq LLM** → Receives customized prompt with injected data

## Integration Points

### Supabase Connection
- Profile data is fetched in `/pages/api/delegate.ts` (lines 51-60)
- Fetched fields: `custom_assistant_name`, `first_name`
- Passed to AI server as: `assistantName`, `userName`
- Flow is **read-only** (no new writes to database from prompts module)

### Dashboard Dynamic Data
- User submits form with `goal` (required) and target phone number
- Custom names come from user's Supabase profile (not form input)
- Goal flows through: form → delegate API → outbound-call → client_state → CallContext
- Prompts module receives goal in CallContext and appends it to system prompt

### Call Lifecycle
1. Call initiated with data in client_state
2. On call start, CallContext populated with all data
3. For each user utterance:
   - CallContext passed to generateAssistantReply()
   - buildSystemPrompt(context) builds customized prompt
   - Groq receives prompt with injected goal and custom names

## Key Design Decisions

### 1. **Placeholder Syntax (`{{PLACEHOLDER}}`)**
- **Why**: Safe, explicit, won't accidentally replace data in goal text
- **Previous approach**: Regex like `/Ferguson/g` could replace names inside goal text
- **Example**: If goal contained "I'm Ferguson's customer", it would be corrupted

### 2. **Separation of Concerns**
- **config.ts**: Configuration only (API keys, server settings)
- **llm.ts**: LLM pipeline orchestration and backward compatibility
- **prompts/system-prompt.ts**: All prompt template and interpolation logic
- **Benefit**: Easy to test, maintain, and modify prompts independently

### 3. **No Persistence to Database**
- Prompts are generated per-request
- No writes to Supabase from prompts module
- CallContext persists data in-memory during call
- Ensures system prompt always reflects latest user settings

### 4. **Environment Variable Override**
- `config.llm.systemPromptOverride` can override entire prompt via `LLM_SYSTEM_PROMPT` env var
- Falls back to buildSystemPrompt() for normal operation
- Allows experimentation without code changes

## Usage

### Normal Operation (via LLM Pipeline)
```typescript
import { buildSystemPrompt } from "./prompts/system-prompt";

const context = {
  goal: "Get store hours for next Monday",
  assistantName: "Bob",
  userName: "Alice",
  // ... other CallContext fields
};

const prompt = buildSystemPrompt(context);
// Returns complete system prompt with names interpolated and goal appended
```

### Testing
```typescript
import { BASE_SYSTEM_PROMPT, GOAL_SECTION_TEMPLATE, buildSystemPrompt } from "./prompts/system-prompt";

// Test placeholder replacement
const prompt = buildSystemPrompt({
  assistantName: "Custom Name",
  userName: "Custom User",
  goal: "Test goal"
});

// Verify template exports work
console.log(BASE_SYSTEM_PROMPT); // Full base template
console.log(GOAL_SECTION_TEMPLATE); // Goal section template
```

## Maintenance Notes

### Adding New Placeholders
1. Add placeholder to template: `"Hello {{NEW_PLACEHOLDER}}"`
2. Update `interpolate()` call to pass replacement value
3. Update type definitions if adding new CallContext fields

### Modifying System Prompt Rules
- Edit `BASE_SYSTEM_PROMPT` constant for core rules
- Edit `GOAL_SECTION_TEMPLATE` for goal-specific rules
- Changes apply immediately to all new LLM calls

### Debugging
- System prompt is logged when LLM calls are made
- Check logs for interpolation results
- Verify CallContext is populated in WebSocket start handler (index.ts:1105-1111)

## Backward Compatibility

The `llm.ts` file re-exports `buildSystemPrompt` for backward compatibility:
```typescript
export { buildSystemPrompt };
```

This allows existing code importing from `llm.ts` to continue working without changes.
