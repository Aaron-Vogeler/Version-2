import OpenAI from "openai";
import config from "../config";
import * as contextMgr from "../callContextManager";
import type { PromptSettings } from "../callContextManager";

// Create Groq client configured with API key and base URL
const groq = new OpenAI({
  apiKey: config.groq.apiKey,
  baseURL: "https://api.groq.com/openai/v1",
});

// ============================================================================
// LOGGING UTILITIES
// ============================================================================

const COL_WIDTH = 50;
const DIVIDER = "─".repeat(COL_WIDTH);
const DOUBLE_DIVIDER = "═".repeat(COL_WIDTH * 2 + 3);

/**
 * Truncate text to fit column width, adding ellipsis if needed.
 */
function truncate(text: string, maxLen: number = COL_WIDTH - 2): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * Wrap text to multiple lines of specified width.
 */
function wrapText(text: string, width: number = COL_WIDTH - 4): string[] {
  const lines: string[] = [];
  const words = text.split(/\s+/);
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= width) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word.length > width ? word.slice(0, width - 3) + "..." : word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.length ? lines : [""];
}

/**
 * Format a message for display in the log.
 */
function formatMessage(msg: { role: string; content: string }, index: number): string[] {
  const roleLabel = msg.role.toUpperCase().padEnd(9);
  const lines: string[] = [];

  // First line of content preview
  const contentPreview = msg.content.replace(/\n/g, " ").slice(0, 200);
  const wrapped = wrapText(contentPreview, COL_WIDTH - 14);

  lines.push(`  [${index}] ${roleLabel} ${wrapped[0] || "(empty)"}`);
  for (let i = 1; i < Math.min(wrapped.length, 3); i++) {
    lines.push(`              ${wrapped[i]}`);
  }
  if (wrapped.length > 3) {
    lines.push(`              ... (+${wrapped.length - 3} more lines)`);
  }

  return lines;
}

/**
 * Log Groq request and response side-by-side.
 */
function logGroqExchange(
  requestOptions: OpenAI.Chat.ChatCompletionCreateParams,
  response: OpenAI.Chat.ChatCompletion,
  durationMs: number
): void {
  const output = response.choices[0]?.message?.content || "(empty)";
  const usage = response.usage;

  console.log("");
  console.log(`╔${DOUBLE_DIVIDER}╗`);
  console.log(`║ GROQ LLM EXCHANGE                                                                                     ║`);
  console.log(`╠${"═".repeat(COL_WIDTH)}╦${"═".repeat(COL_WIDTH + 2)}╣`);
  console.log(`║ ${"INPUT".padEnd(COL_WIDTH - 1)}║ ${"OUTPUT".padEnd(COL_WIDTH + 1)}║`);
  console.log(`╠${DIVIDER}╬${DIVIDER}══╣`);

  // Build input lines
  const inputLines: string[] = [];
  inputLines.push(`  Model: ${requestOptions.model}`);
  inputLines.push(`  Temperature: ${requestOptions.temperature}`);
  inputLines.push(`  Max Tokens: ${requestOptions.max_tokens}`);
  if (requestOptions.top_p !== undefined) inputLines.push(`  Top P: ${requestOptions.top_p}`);
  if (requestOptions.frequency_penalty) inputLines.push(`  Freq Penalty: ${requestOptions.frequency_penalty}`);
  if (requestOptions.presence_penalty) inputLines.push(`  Pres Penalty: ${requestOptions.presence_penalty}`);
  if (requestOptions.stop) inputLines.push(`  Stop: ${JSON.stringify(requestOptions.stop)}`);
  inputLines.push(`  ${DIVIDER.slice(0, COL_WIDTH - 4)}`);
  inputLines.push(`  Messages (${requestOptions.messages.length}):`);

  for (let i = 0; i < requestOptions.messages.length; i++) {
    const msgLines = formatMessage(requestOptions.messages[i] as { role: string; content: string }, i);
    inputLines.push(...msgLines);
  }

  // Build output lines
  const outputLines: string[] = [];
  outputLines.push(`  Duration: ${durationMs}ms`);
  outputLines.push(`  Tokens: ${usage?.prompt_tokens || "?"} in → ${usage?.completion_tokens || "?"} out`);
  outputLines.push(`  Total: ${usage?.total_tokens || "?"} tokens`);
  outputLines.push(`  Finish: ${response.choices[0]?.finish_reason || "?"}`);
  outputLines.push(`  ${DIVIDER.slice(0, COL_WIDTH - 4)}`);
  outputLines.push(`  Response:`);

  const responseWrapped = wrapText(output, COL_WIDTH - 4);
  for (const line of responseWrapped) {
    outputLines.push(`  ${line}`);
  }

  // Print side by side
  const maxLines = Math.max(inputLines.length, outputLines.length);
  for (let i = 0; i < maxLines; i++) {
    const left = (inputLines[i] || "").padEnd(COL_WIDTH - 1);
    const right = (outputLines[i] || "").padEnd(COL_WIDTH + 1);
    console.log(`║${left}║${right}║`);
  }

  console.log(`╚${"═".repeat(COL_WIDTH)}╩${"═".repeat(COL_WIDTH + 2)}╝`);
  console.log("");
}

// Default goal template (used when no custom template is provided)
const DEFAULT_GOAL_TEMPLATE = `CALL GOAL (YOUR ONLY MISSION):
"{goal}"

EXECUTION RULES FOR THIS CALL:
- Ask ONLY questions necessary to achieve the goal above
- Preserve the EXACT specificity of the goal (dates, times, details)
- Do NOT reinterpret dates/times (e.g., if goal says "next Monday", ask about "next Monday", not "tomorrow")
- Do NOT ask for names, store info, account details, or anything else unless directly needed
- Example: If goal is "get store hours for next Monday", ask ONLY about next Monday's hours—not tomorrow, not "the next day", not today
- When you have what you need: confirm it back ("Just to confirm, [info]. Is that correct?")
- After confirmation: end with "Thank you. Chow."
- Do NOT deviate from this goal

Remember: You are an AI phone agent. Strict scope control is mandatory.`;

/**
 * Re-export CallContext and PromptSettings from the context manager for backward compatibility.
 */
export type CallContext = contextMgr.CallContext;
export type { PromptSettings } from "../callContextManager";

/**
 * Build the system prompt dynamically, optionally injecting call goal context.
 * Replaces the hardcoded assistant name and user name with custom names from the call context.
 * Uses custom prompt settings if provided, otherwise falls back to defaults.
 * @param context - Optional call context with goal, assistantName, userName, and promptSettings
 * @returns The complete system prompt
 */
function buildSystemPrompt(context?: CallContext): string {
  const settings = context?.promptSettings;

  // Use custom system prompt if provided, otherwise use default from config
  let prompt = settings?.systemPrompt || config.llm.systemPrompt;

  // Replace the hardcoded assistant name "Ferguson" with the custom name if provided
  // Priority: promptSettings.assistantName > context.assistantName > "Ferguson"
  const assistantName = settings?.assistantName || context?.assistantName || "Ferguson";

  // Replace all occurrences of "Ferguson" with the custom assistant name
  prompt = prompt.replace(/Ferguson/g, assistantName);

  // Also handle lowercase "ferguson" if it appears
  prompt = prompt.replace(/ferguson/g, assistantName.toLowerCase());

  // Replace the hardcoded user name "Aaron" with the custom name if provided
  // Priority: promptSettings.userName > context.userName > "Aaron"
  const userName = settings?.userName || context?.userName || "Aaron";

  // Replace all occurrences of "Aaron" with the custom user name
  prompt = prompt.replace(/Aaron/g, userName);

  // Inject goal using custom template or default
  if (context?.goal) {
    const goalTemplate = settings?.goalTemplate || DEFAULT_GOAL_TEMPLATE;
    const goalSection = goalTemplate.replace("{goal}", context.goal);
    prompt += "\n\n" + goalSection;
  }

  return prompt;
}

/**
 * Generate a rolling summary of the call by calling the LLM.
 * This is called periodically as new turns accumulate.
 * @param callId - The call ID
 * @param config_override - Optional context configuration
 * @returns The updated summary, or existing summary if generation fails
 */
export async function generateRollingSummary(
  callId: string,
  config_override?: contextMgr.ContextConfig
): Promise<string> {
  const config_params = config_override || contextMgr.DEFAULT_CONFIG;
  const context = contextMgr.getContext(callId);
  if (!context) {
    console.warn(`[${callId}] Cannot generate summary: context not found`);
    return "";
  }

  const newTurns = contextMgr.getNewTurnsForSummary(callId);
  if (newTurns.length === 0) {
    console.log(`[${callId}] No new turns to summarize`);
    return context.rollingSummary;
  }

  const turnsText = contextMgr.formatTurnsForSummary(newTurns);
  const existingSummary = context.rollingSummary || "(empty)";

  const summaryPrompt = `You are updating a rolling summary of a phone call between an AI assistant and a caller, and possibly multiple human agents.

EXISTING SUMMARY (may be empty or partial):
${existingSummary}

NEW TRANSCRIPT TURNS (since that summary was created):
${turnsText}

Please return an UPDATED, CONCISE summary (max ~${config_params.maxSummaryTokensHint} tokens) that preserves:
- The caller's main goal(s)
- Key facts (names, dates, constraints, identifiers)
- Important decisions / outcomes so far
- Current status (who we're talking to, which department, on hold or not, etc.)
- Any critical context for continuing the conversation

Be concise and focus on what's most important to continue this call effectively.`;

  try {
    console.log(`[${callId}] Generating rolling summary...`);
    const response = await groq.chat.completions.create({
      model: config.groq.model,
      messages: [
        {
          role: "system",
          content:
            "You are a concise call summary generator. Create summaries that preserve the most important context for continuing phone conversations.",
        },
        { role: "user", content: summaryPrompt },
      ],
      temperature: 0.2, // Lower temperature for consistency
      max_tokens: config_params.maxSummaryTokensHint,
    });

    const newSummary = response.choices[0]?.message?.content || "";
    if (!newSummary) {
      console.warn(`[${callId}] LLM returned empty summary`);
      return context.rollingSummary;
    }

    console.log(`[${callId}] Summary updated (${newSummary.length} chars)`);
    return newSummary;
  } catch (error) {
    console.error(
      `[${callId}] Failed to generate rolling summary:`,
      error instanceof Error ? error.message : error
    );
    // Return existing summary on error (resilient fallback)
    return context.rollingSummary;
  }
}

/**
 * Check if we should update the summary and do so if needed.
 * Call this after processing each turn.
 * @param callId - The call ID
 * @param config_override - Optional context configuration
 */
export async function maybeUpdateSummaryForCall(
  callId: string,
  config_override?: contextMgr.ContextConfig
): Promise<void> {
  const config_params = config_override || contextMgr.DEFAULT_CONFIG;

  if (!contextMgr.shouldUpdateSummary(callId, config_params)) {
    return;
  }

  const newSummary = await generateRollingSummary(callId, config_params);
  const context = contextMgr.getContext(callId);
  if (context) {
    contextMgr.updateSummary(callId, newSummary, context.turns.length - 1);
  }
}

/**
 * Call Groq LLM with user text and return the AI response.
 * Includes rolling summary and recent turns for rich per-call context.
 * Uses custom prompt settings if provided for model, temperature, max_tokens, etc.
 * @param userText - The user's input text
 * @param context - Call context with goal, call ID, promptSettings, and other metadata
 * @returns The AI-generated response, or an empty string if no response
 */
export async function generateAssistantReply(
  userText: string,
  context?: CallContext
): Promise<string> {
  const settings = context?.promptSettings;
  const systemPrompt = buildSystemPrompt(context);
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  // Check if rolling summary should be included (default: true)
  const includeRollingSummary = settings?.includeRollingSummary !== false;

  // Get max context turns (default: 12)
  const maxContextTurns = settings?.maxContextTurns ?? 12;

  // Add rolling summary if available, non-empty, and not disabled
  if (context?.callId && includeRollingSummary) {
    const callContext = contextMgr.getContext(context.callId);
    if (callContext?.rollingSummary) {
      messages.push({
        role: "user",
        content: `CALL CONTEXT SUMMARY:\n${callContext.rollingSummary}`,
      });
    }
  }

  // Add recent turns from the sliding window
  if (context?.callId) {
    const recentTurns = contextMgr.getRecentTurns(context.callId, maxContextTurns);
    const recentMessages = contextMgr.formatTurnsAsMessages(recentTurns);
    messages.push(...recentMessages);
  }

  // Add the current user input as the final message
  messages.push({ role: "user", content: userText });

  // Build LLM request options with custom settings
  const model = settings?.model || config.groq.model;
  const temperature = settings?.temperature ?? 0.4; // Default to 0.4 for consistent phone agent behavior
  const maxTokens = settings?.maxTokens ?? 150; // Default to 150 for short phone responses

  // Build the request options
  const requestOptions: OpenAI.Chat.ChatCompletionCreateParams = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  // Add optional parameters if provided
  if (settings?.topP !== undefined) {
    requestOptions.top_p = settings.topP;
  }
  if (settings?.frequencyPenalty !== undefined) {
    requestOptions.frequency_penalty = settings.frequencyPenalty;
  }
  if (settings?.presencePenalty !== undefined) {
    requestOptions.presence_penalty = settings.presencePenalty;
  }
  if (settings?.stopSequences && settings.stopSequences.length > 0) {
    requestOptions.stop = settings.stopSequences;
  }

  // Execute request and log exchange
  const startTime = Date.now();
  const response = await groq.chat.completions.create(requestOptions);
  const durationMs = Date.now() - startTime;

  // Log the full input/output exchange side-by-side
  logGroqExchange(requestOptions, response, durationMs);

  return response.choices[0]?.message?.content || "";
}
