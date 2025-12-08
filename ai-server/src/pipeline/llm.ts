import OpenAI from "openai";
import config from "../config";
import * as contextMgr from "../callContextManager";
import { logLLMEvent } from "../utils/supabase";

// Create Groq client configured with API key and base URL
const groq = new OpenAI({
  apiKey: config.groq.apiKey,
  baseURL: "https://api.groq.com/openai/v1",
});

/**
 * Log an LLM event to Supabase
 */
async function emitLLMEvent(
  type: 'request' | 'response' | 'error' | 'summary_request' | 'summary_response' | 'summary_error',
  callId: string,
  data: any
) {
  // Fire and forget - don't block LLM operations on logging
  logLLMEvent(callId, {
    type,
    timestamp: new Date().toISOString(),
    data,
  }).catch((err) => {
    console.error(`[LLM] Failed to log ${type} event:`, err);
  });
}

/**
 * Re-export CallContext from the context manager for backward compatibility.
 */
export type CallContext = contextMgr.CallContext;

/**
 * Build the system prompt dynamically, optionally injecting call goal context.
 * Checks for custom system prompt in aiConfig first, falling back to default.
 * Replaces the hardcoded assistant name and user name with custom names from the call context.
 * @param context - Optional call context with goal, assistantName, userName, and aiConfig
 * @returns The complete system prompt
 */
function buildSystemPrompt(context?: CallContext): string {
  // Use custom system prompt from aiConfig if provided, otherwise use default
  let prompt = context?.aiConfig?.systemPrompt || config.llm.systemPrompt;

  // Replace the hardcoded assistant name "Ferguson" with the custom name if provided
  const assistantName = context?.assistantName || "Ferguson";

  // Replace all occurrences of "Ferguson" with the custom assistant name
  prompt = prompt.replace(/Ferguson/g, assistantName);

  // Also handle lowercase "ferguson" if it appears
  prompt = prompt.replace(/ferguson/g, assistantName.toLowerCase());

  // Replace the hardcoded user name "Aaron" with the custom name if provided
  const userName = context?.userName || "Aaron";

  // Replace all occurrences of "Aaron" with the custom user name
  prompt = prompt.replace(/Aaron/g, userName);

  if (context?.goal) {
    prompt += `

CALL GOAL (YOUR ONLY MISSION):
"${context.goal}"`;
  }

  return prompt;
}

// Default summary prompt template (can be overridden via aiConfig.summaryPrompt)
const DEFAULT_SUMMARY_PROMPT_TEMPLATE = `You are updating a rolling summary of a phone call between an AI assistant and a caller, and possibly multiple human agents.

EXISTING SUMMARY (may be empty or partial):
{{existingSummary}}

NEW TRANSCRIPT TURNS (since that summary was created):
{{turnsText}}

Please return an UPDATED, CONCISE summary (max ~{{maxTokens}} tokens) that preserves:
- The caller's main goal(s)
- Key facts (names, dates, constraints, identifiers)
- Important decisions / outcomes so far
- Current status (who we're talking to, which department, on hold or not, etc.)
- Any critical context for continuing the conversation

Be concise and focus on what's most important to continue this call effectively.`;

/**
 * Generate a rolling summary of the call by calling the LLM.
 * This is called periodically as new turns accumulate.
 * Uses aiConfig.summaryPrompt if provided, otherwise uses default template.
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

  // Use custom summary prompt from aiConfig if provided, otherwise use default template
  const promptTemplate = context.aiConfig?.summaryPrompt || DEFAULT_SUMMARY_PROMPT_TEMPLATE;

  // Replace placeholders in the prompt template
  const summaryPrompt = promptTemplate
    .replace(/\{\{existingSummary\}\}/g, existingSummary)
    .replace(/\{\{turnsText\}\}/g, turnsText)
    .replace(/\{\{maxTokens\}\}/g, String(config_params.maxSummaryTokensHint));

  const startTime = Date.now();

  try {
    const summaryRequestLog = {
      turnsCount: newTurns.length,
      existingSummaryLength: existingSummary.length,
      newTurnsLength: turnsText.length,
      promptTemplateLength: promptTemplate.length,
    };
    console.log(`
📝 ========================================
📝 ROLLING SUMMARY REQUEST
📝 ========================================
[${callId}] Generating rolling summary from ${newTurns.length} turns
  - Existing summary: ${existingSummary.length} chars
  - New turns: ${turnsText.length} chars
  - Prompt template: ${promptTemplate.length} chars`);

    emitLLMEvent('summary_request', callId, summaryRequestLog);

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
    const latency = Date.now() - startTime;

    if (!newSummary) {
      console.warn(`[${callId}] LLM returned empty summary`);
      return context.rollingSummary;
    }

    const summaryResponseLog = {
      summary: newSummary.slice(0, 200),
      length: newSummary.length,
      latency,
      tokens: {
        input: response.usage?.prompt_tokens || 0,
        output: response.usage?.completion_tokens || 0,
      },
    };
    console.log(`
📝 ========================================
📝 ROLLING SUMMARY RESPONSE
📝 ========================================
[${callId}] Summary updated in ${latency}ms
  - New summary: ${newSummary.length} chars
  - Tokens: input=${response.usage?.prompt_tokens || 0}, output=${response.usage?.completion_tokens || 0}
  - Content preview: "${newSummary.slice(0, 100)}${newSummary.length > 100 ? "..." : ""}"`);

    emitLLMEvent('summary_response', callId, summaryResponseLog);

    return newSummary;
  } catch (error) {
    const latency = Date.now() - startTime;
    const summaryErrorLog = {
      error: error instanceof Error ? error.message : String(error),
      latency,
    };
    console.error(`
❌ ========================================
❌ ROLLING SUMMARY ERROR
❌ ========================================
[${callId}] Failed to generate rolling summary after ${latency}ms
  - Error: ${error instanceof Error ? error.message : String(error)}`);

    emitLLMEvent('summary_error', callId, summaryErrorLog);

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
 * @param userText - The user's input text
 * @param context - Call context with goal, call ID, and other metadata
 * @returns The AI-generated response, or an empty string if no response
 */
export async function generateAssistantReply(
  userText: string,
  context?: CallContext
): Promise<string> {
  const callId = context?.callId || "unknown";
  const startTime = Date.now();

  const systemPrompt = buildSystemPrompt(context);
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  // Add rolling summary if available and non-empty
  if (context?.callId) {
    const callContext = contextMgr.getContext(context.callId);
    if (callContext?.rollingSummary) {
      messages.push({
        role: "user",
        content: `CALL CONTEXT SUMMARY:\n${callContext.rollingSummary}`,
      });
    }

    // Use per-call maxTurnsInWindow from aiConfig if available, otherwise use default (12)
    const maxTurns = context.aiConfig?.maxTurnsInWindow ?? 12;

    // Add recent turns from the sliding window
    const recentTurns = contextMgr.getRecentTurns(context.callId, maxTurns);
    const recentMessages = contextMgr.formatTurnsAsMessages(recentTurns);
    messages.push(...recentMessages);
  }

  // Add the current user input as the final message
  messages.push({ role: "user", content: userText });

  try {
    // Log the LLM request details
    const requestLog = {
      messages: messages.length,
      systemPromptLength: systemPrompt.length,
      userInput: userText.slice(0, 100),
      model: config.groq.model,
    };
    console.log(`
🤖 ========================================
🤖 LLM REQUEST (${config.groq.model})
🤖 ========================================
[${callId}] Calling Groq with ${messages.length} messages
  - System: ${systemPrompt.length} chars
  - Messages: ${messages.map((m, i) => `${m.role}(${m.content.length} chars)`).join(", ")}
  - User input: "${userText.slice(0, 100)}${userText.length > 100 ? "..." : ""}"`);

    emitLLMEvent('request', callId, requestLog);

    const response = await groq.chat.completions.create({
      model: config.groq.model,
      messages,
    });

    const aiText = response.choices[0]?.message?.content || "";
    const latency = Date.now() - startTime;

    // Log the LLM response details
    const responseLog = {
      response: aiText.slice(0, 200),
      length: aiText.length,
      latency,
      tokens: {
        input: response.usage?.prompt_tokens || 0,
        output: response.usage?.completion_tokens || 0,
        total: response.usage?.total_tokens || 0,
      },
      model: response.model,
      finishReason: response.choices[0]?.finish_reason || "unknown",
    };
    console.log(`
🤖 ========================================
🤖 LLM RESPONSE
🤖 ========================================
[${callId}] Groq responded in ${latency}ms
  - Response: "${aiText.slice(0, 100)}${aiText.length > 100 ? "..." : ""}"
  - Length: ${aiText.length} chars
  - Tokens used: input=${response.usage?.prompt_tokens || 0}, output=${response.usage?.completion_tokens || 0}, total=${response.usage?.total_tokens || 0}
  - Model: ${response.model}
  - Finish reason: ${response.choices[0]?.finish_reason || "unknown"}`);

    emitLLMEvent('response', callId, responseLog);

    return aiText;
  } catch (error) {
    const latency = Date.now() - startTime;
    const errorLog = {
      error: error instanceof Error ? error.message : String(error),
      latency,
      userInput: userText.slice(0, 100),
    };
    console.error(`
❌ ========================================
❌ LLM ERROR
❌ ========================================
[${callId}] Groq API call failed after ${latency}ms
  - Error: ${error instanceof Error ? error.message : String(error)}
  - User input: "${userText.slice(0, 100)}${userText.length > 100 ? "..." : ""}"
  ${error instanceof Error && error.stack ? `\n  Stack: ${error.stack}` : ""}`);

    emitLLMEvent('error', callId, errorLog);

    // Rethrow to allow caller to handle
    throw error;
  }
}
