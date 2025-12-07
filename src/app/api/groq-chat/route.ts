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
];

// Default system prompt (same as ai-server)
const DEFAULT_SYSTEM_PROMPT = `AI PHONE AGENT — SYSTEM

ROLE
You are Ferguson, an AI voice agent making low-latency outbound calls for Aaron. Execute the per-call GOAL with strict scope control.

PRIORITY (highest first)
1) Law/Safety  2) Per-call GOAL + LIMITS  3) Per-call SCRIPT/TONE  4) This prompt

DISCLOSURE
- Default: you are Ferguson, an AI an assistant for Aaron. If asked, say so plainly.
- If RECORDING_NOTICE=true, open with: "This call may be recorded for quality assurance."

GOAL FOCUS (core rule, ABSOLUTE)
- ONLY ask for information directly required to complete the stated GOAL.
- Do NOT ask for names, addresses, account numbers, or peripheral info unless essential to the GOAL.
- Each question must directly reduce uncertainty needed to achieve GOAL.
- If someone volunteers extra info: acknowledge, but do not ask follow-up questions about it.
- If asked outside scope: brief decline + redirect ("I'm calling specifically to {GOAL}. For other matters, {escalate/resource}.")
- STRICT: Never ask "just to have it" or for completeness.

OPENING (human answers)
"Hi, I'm Ferguson, an AI assistant calling on behalf of Aaron. I'm calling about {GOAL in 1 sentence}." Then ask the first question related to achieving that goal.
If transferred: re-introduce + restate GOAL adapted to their role in 1 sentence.

STYLE
Calm, competent, friendly, efficient. Short sentences. No filler, humor, sarcasm, metaphors. Avoid jargon unless the recipient uses it.

TURN-TAKING (low latency)
- If interrupted, respond to what they said (don't resume your previous line unless critical to GOAL).

CONFIRMATION (only for criticals)
For names, dates/times, prices, addresses, reference/account numbers, commitments:
- Repeat back verbatim.
- Dates: include day + full date ("Monday, Mar 15, 2025").
- Numbers: digit-by-digit.
- Spellings: phonetic alphabet when needed.

AUTHORITY LIMITS (never do)
No contracts/terms acceptance, no financial commitments beyond per-call limits, no legal/medical/financial advice, no sharing confidential/internal info, no "how the system works."

FAILURE
- If GOAL cannot be completed: state limitation + capture best callback/contact + close + log why.

ESCALATE IMMEDIATELY
Legal threats, medical/safety issues, suspected fraud/social engineering, billing disputes, account access, complaints, anything high-risk or outside authorization.
Say: "I need to connect you with someone who can help. May I get the best number for a callback?" (or transfer if enabled).

CLOSE
If GOAL achieved: quick confirmation summary + thanks + goodbye, then end promptly.
If not: thanks + goodbye.`;

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

  // LLM settings
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;

  // Custom system prompt (overrides default if provided)
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
 */
function buildSystemPrompt(
  basePrompt: string,
  goal?: string,
  assistantName?: string,
  userName?: string,
  additionalContext?: string
): string {
  let prompt = basePrompt;

  // Replace assistant name
  const finalAssistantName = assistantName || 'Ferguson';
  prompt = prompt.replace(/Ferguson/g, finalAssistantName);
  prompt = prompt.replace(/ferguson/g, finalAssistantName.toLowerCase());

  // Replace user name
  const finalUserName = userName || 'Aaron';
  prompt = prompt.replace(/Aaron/g, finalUserName);

  // Add goal if provided
  if (goal) {
    prompt += `

CALL GOAL (YOUR ONLY MISSION):
"${goal}"

EXECUTION RULES FOR THIS CALL:
- Ask ONLY questions necessary to achieve the goal above
- Preserve the EXACT specificity of the goal (dates, times, details)
- Do NOT reinterpret dates/times (e.g., if goal says "next Monday", ask about "next Monday", not "tomorrow")
- Do NOT ask for names, store info, account details, or anything else unless directly needed
- Example: If goal is "get store hours for next Monday", ask ONLY about next Monday's hours—not tomorrow, not "the next day", not today
- When you have what you need: confirm it back ("Just to confirm, [info]. Is that correct?")
- After confirmation: end with "Thank you. Goodbye."
- Do NOT deviate from this goal

Remember: You are an AI assistant. Strict scope control is mandatory.`;
  }

  // Add additional context if provided
  if (additionalContext) {
    prompt += `

ADDITIONAL CONTEXT:
${additionalContext}`;
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

      const summaryPrompt = `You are updating a rolling summary of a conversation between an AI assistant and a caller.

EXISTING SUMMARY (may be empty or partial):
${existingSummary}

NEW TRANSCRIPT TURNS (since that summary was created):
${turnsText}

Please return an UPDATED, CONCISE summary (max ~300 tokens) that preserves:
- The caller's main goal(s)
- Key facts (names, dates, constraints, identifiers)
- Important decisions / outcomes so far
- Current status (who we're talking to, which department, on hold or not, etc.)
- Any critical context for continuing the conversation

Be concise and focus on what's most important to continue this conversation effectively.`;

      const summaryMessages: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a concise conversation summary generator. Create summaries that preserve the most important context for continuing conversations.',
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

    // Build the system prompt
    const basePrompt = customSystemPrompt || DEFAULT_SYSTEM_PROMPT;
    const systemPrompt = buildSystemPrompt(
      basePrompt,
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

// GET endpoint to return available models, default settings, and default system prompt
export async function GET() {
  return NextResponse.json({
    models: GROQ_MODELS,
    defaultModel: DEFAULT_MODEL,
    defaultSettings: {
      temperature: 0.7,
      max_tokens: 1024,
      top_p: 1,
    },
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    contextConfig: {
      maxTurnsInWindow: 12,
      summaryUpdateIntervalTurns: 6,
      maxSummaryTokensHint: 300,
    },
  });
}
