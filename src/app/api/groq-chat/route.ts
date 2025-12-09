/**
 * API route for direct Groq LLM chat with call-like features
 * Supports: goal injection, rolling summary, context management
 */

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/../pages/api/auth/[...nextauth]';

// Groq API configuration
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Available Groq models for selection
const GROQ_MODELS = [
  { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant', description: 'Fast, efficient model for quick responses' },
  { id: 'llama-3.1-70b-versatile', name: 'Llama 3.1 70B Versatile', description: 'Larger model with better reasoning' },
  { id: 'llama-3.2-1b-preview', name: 'Llama 3.2 1B Preview', description: 'Smallest, fastest model' },
  { id: 'llama-3.2-3b-preview', name: 'Llama 3.2 3B Preview', description: 'Small but capable model' },
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', description: 'Latest large model' },
  { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', description: 'Mixture of experts model' },
  { id: 'gemma2-9b-it', name: 'Gemma 2 9B IT', description: 'Google Gemma 2 instruction-tuned' },
  { id: 'gpt-oss-20b', name: 'GPT OSS 20B', description: 'GPT open-source 20B model' },
];

// =============================================================================
// VARIABLE KEYS (use these placeholders in prompts)
// =============================================================================
// {ASSISTANT_NAME} - Replaced with the assistant's name (default: "Ferguson")
// {USER_NAME} - Replaced with the user's name (default: "Aaron")
// =============================================================================

// No default system prompt - must be provided by caller
// Goal is always injected at the bottom in format: CALL GOAL (YOUR ONLY MISSION): "{goal}"

// Turn type for conversation history
interface Turn {
  speaker: 'caller' | 'agent' | 'assistant' | 'user';
  text: string;
  timestamp: string;
}

// Message type for chat
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}


// Default rolling summary template
// Use placeholders: {existingSummary}, {turnsText}
const DEFAULT_SUMMARY_TEMPLATE = `You are updating a rolling summary of a conversation between an AI assistant and a caller.

EXISTING SUMMARY (may be empty or partial):
{existingSummary}

NEW TRANSCRIPT TURNS (since that summary was created):
{turnsText}

Please return an UPDATED, CONCISE summary (max ~300 tokens) that preserves:
- The caller's main goal(s)
- Key facts (names, dates, constraints, identifiers)
- Important decisions / outcomes so far
- Current status (who we're talking to, which department, on hold or not, etc.)
- Any critical context for continuing the conversation

Be concise and focus on what's most important to continue this conversation effectively.`;

// Default summary system message
const DEFAULT_SUMMARY_SYSTEM_MESSAGE = `You are a concise conversation summary generator. Create summaries that preserve the most important context for continuing conversations.`;

// Request body interface
interface GroqChatRequest {
  // New message
  userMessage: string;

  // Call-like context
  goal?: string;
  additionalContext?: string;
  assistantName?: string;
  userName?: string;

  // Conversation state
  turns?: Turn[];
  rollingSummary?: string;

  // Summary generation options
  summaryTemplate?: string;
  summarySystemMessage?: string;

  // LLM settings
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;

  // System prompt (REQUIRED - no default)
  customSystemPrompt?: string;

  // Request type
  requestType?: 'chat' | 'generate_summary';
}

// Groq API response types
interface GroqChoice {
  index: number;
  message: {
    role: string;
    content: string;
  };
  finish_reason: string;
}

interface GroqUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface GroqResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: GroqChoice[];
  usage: GroqUsage;
}

/**
 * Build the system prompt dynamically with goal injection
 * Uses variable keys: {ASSISTANT_NAME}, {USER_NAME} for placeholder replacement.
 * Goal is always injected at the bottom in format: CALL GOAL (YOUR ONLY MISSION): "{goal}"
 */
function buildSystemPrompt(
  basePrompt: string,
  goal?: string,
  assistantName?: string,
  userName?: string,
  additionalContext?: string
): string {
  let prompt = basePrompt;

  // Get names or use defaults
  const finalAssistantName = assistantName || 'Ferguson';
  const finalUserName = userName || 'Aaron';

  // Replace variable keys {ASSISTANT_NAME} and {USER_NAME}
  prompt = prompt.replace(/\{ASSISTANT_NAME\}/g, finalAssistantName);
  prompt = prompt.replace(/\{USER_NAME\}/g, finalUserName);

  // Also replace legacy hardcoded names for backwards compatibility
  prompt = prompt.replace(/Ferguson/g, finalAssistantName);
  prompt = prompt.replace(/ferguson/g, finalAssistantName.toLowerCase());
  prompt = prompt.replace(/Aaron/g, finalUserName);

  // Add additional context if provided
  if (additionalContext) {
    prompt += `\n\nADDITIONAL CONTEXT:\n${additionalContext}`;
  }

  // Goal is always injected at the bottom in simple format
  if (goal) {
    prompt += `\n\nCALL GOAL (YOUR ONLY MISSION): "${goal}"`;
  }

  return prompt;
}

/**
 * Format turns as messages for the LLM
 */
function formatTurnsAsMessages(turns: Turn[]): ChatMessage[] {
  return turns.map((turn) => {
    const role: 'user' | 'assistant' = turn.speaker === 'assistant' ? 'assistant' : 'user';
    const speakerLabel = turn.speaker === 'assistant' ? '' : `[${turn.speaker.toUpperCase()}] `;
    return {
      role,
      content: `${speakerLabel}${turn.text}`,
    };
  });
}

/**
 * Format turns for summary generation
 */
function formatTurnsForSummary(turns: Turn[]): string {
  if (turns.length === 0) return '(no turns)';
  return turns
    .map((turn) => `[${turn.timestamp}] ${turn.speaker.toUpperCase()}: ${turn.text}`)
    .join('\n');
}

/**
 * Call Groq API
 */
async function callGroqAPI(
  messages: ChatMessage[],
  model: string,
  temperature: number,
  max_tokens: number,
  top_p: number
): Promise<{ response: GroqResponse; latency_ms: number }> {
  const startTime = Date.now();

  const groqResponse = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens,
      top_p,
    }),
  });

  const endTime = Date.now();

  if (!groqResponse.ok) {
    const errorData = await groqResponse.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Groq API error: ${groqResponse.status}`);
  }

  const data: GroqResponse = await groqResponse.json();
  return { response: data, latency_ms: endTime - startTime };
}

export async function POST(req: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Validate API key
    if (!GROQ_API_KEY) {
      return NextResponse.json(
        { error: 'Groq API key not configured' },
        { status: 500 }
      );
    }

    // Parse request body
    const body: GroqChatRequest = await req.json();
    const {
      userMessage,
      goal,
      additionalContext,
      assistantName,
      userName,
      turns = [],
      rollingSummary,
      model = DEFAULT_MODEL,
      temperature = 0.7,
      max_tokens = 1024,
      top_p = 1,
      customSystemPrompt,
      requestType = 'chat',
    } = body;

    // Handle summary generation request
    if (requestType === 'generate_summary') {
      const existingSummary = rollingSummary || '(empty)';
      const turnsText = formatTurnsForSummary(turns);

      // Use custom template or default, replacing placeholders
      const template = body.summaryTemplate || DEFAULT_SUMMARY_TEMPLATE;
      const summaryPrompt = template
        .replace('{existingSummary}', existingSummary)
        .replace('{turnsText}', turnsText);

      // Use custom system message or default
      const systemMessage = body.summarySystemMessage || DEFAULT_SUMMARY_SYSTEM_MESSAGE;

      const summaryMessages: ChatMessage[] = [
        {
          role: 'system',
          content: systemMessage,
        },
        { role: 'user', content: summaryPrompt },
      ];

      const { response, latency_ms } = await callGroqAPI(
        summaryMessages,
        model,
        0.2, // Lower temperature for consistency
        300, // Max tokens for summary
        top_p
      );

      const newSummary = response.choices[0]?.message?.content || '';

      return NextResponse.json({
        success: true,
        requestType: 'generate_summary',
        summary: newSummary,
        model: response.model,
        usage: response.usage,
        latency_ms,
        // Debug info
        debug: {
          existingSummary,
          turnsForSummary: turns.length,
        },
      });
    }

    // Regular chat request
    if (!userMessage) {
      return NextResponse.json(
        { error: 'userMessage is required' },
        { status: 400 }
      );
    }

    // System prompt is REQUIRED - no default
    if (!customSystemPrompt) {
      return NextResponse.json(
        { error: 'customSystemPrompt is required' },
        { status: 400 }
      );
    }

    // Build the system prompt with variable replacement and goal injection
    const systemPrompt = buildSystemPrompt(
      customSystemPrompt,
      goal,
      assistantName,
      userName,
      additionalContext
    );

    // Build messages array
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add rolling summary if available
    if (rollingSummary) {
      messages.push({
        role: 'user',
        content: `CONVERSATION CONTEXT SUMMARY:\n${rollingSummary}`,
      });
    }

    // Add recent turns
    const recentTurnMessages = formatTurnsAsMessages(turns.slice(-12)); // Keep last 12 turns
    messages.push(...recentTurnMessages);

    // Add current user message
    messages.push({ role: 'user', content: userMessage });

    // Call Groq API
    const { response, latency_ms } = await callGroqAPI(
      messages,
      model,
      temperature,
      max_tokens,
      top_p
    );

    const completion = response.choices[0]?.message?.content || '';

    return NextResponse.json({
      success: true,
      requestType: 'chat',
      response: completion,
      model: response.model,
      usage: {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0,
      },
      latency_ms,
      // Return built context for visibility
      builtContext: {
        systemPrompt,
        rollingSummaryIncluded: !!rollingSummary,
        turnsIncluded: Math.min(turns.length, 12),
        totalMessagesInRequest: messages.length,
      },
    });
  } catch (error: any) {
    console.error('Groq chat error:', error);

    if (error.message?.includes('Rate limit')) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Please try again in a moment.' },
        { status: 429 }
      );
    }

    return NextResponse.json(
      { error: error.message || 'Failed to generate response' },
      { status: 500 }
    );
  }
}

// GET endpoint to return available models, default settings, and variable keys info
export async function GET() {
  return NextResponse.json({
    models: GROQ_MODELS,
    defaultModel: DEFAULT_MODEL,
    defaultSettings: {
      temperature: 0.7,
      max_tokens: 1024,
      top_p: 1,
    },
    // No default system prompt - must be provided by caller
    // Variable keys for prompt customization
    variableKeys: {
      assistantName: '{ASSISTANT_NAME}',
      userName: '{USER_NAME}',
    },
    // Goal is always injected at bottom: CALL GOAL (YOUR ONLY MISSION): "{goal}"
    goalFormat: 'CALL GOAL (YOUR ONLY MISSION): "{goal}"',
    defaultSummaryTemplate: DEFAULT_SUMMARY_TEMPLATE,
    defaultSummarySystemMessage: DEFAULT_SUMMARY_SYSTEM_MESSAGE,
    rollingSummaryPrompt: DEFAULT_SUMMARY_TEMPLATE, // Alias for frontend consistency
    contextConfig: {
      maxTurnsInWindow: 12,
      summaryUpdateIntervalTurns: 6,
      maxSummaryTokensHint: 300,
    },
    callControlDefaults: {
      ttsDebounceMs: 500,
      bargeInCooldownMs: 300,
      callerUtteranceFlushMs: 300,
      hangupDelayMs: 2000,
    },
  });
}
