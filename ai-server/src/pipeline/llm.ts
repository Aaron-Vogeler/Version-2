import OpenAI from "openai";
import config from "../config";

// Create Groq client configured with API key and base URL
const groq = new OpenAI({
  apiKey: config.groq.apiKey,
  baseURL: "https://api.groq.com/openai/v1",
});

/**
 * Optional context information about the current call, sourced from Telnyx client_state.
 */
export interface CallContext {
  goal?: string;
  userId?: string;
  callControlId?: string;
  streamId?: string;
  initiatedAt?: string;
  // Debounce and call state tracking
  lastUserTranscript?: string;
  lastTranscriptAt?: number;
  ttsDebounceTimer?: NodeJS.Timeout;
  isCallActive?: boolean;
  // Deepgram connection reference for cleanup
  deepgramSocket?: any;
}

/**
 * Build the system prompt dynamically, optionally injecting call goal context.
 * @param context - Optional call context with goal
 * @returns The complete system prompt
 */
function buildSystemPrompt(context?: CallContext): string {
  let prompt = config.llm.systemPrompt;

  if (context?.goal) {
    prompt += `

The high-level goal for this phone call is:
"${context.goal}".

Always steer the conversation toward achieving this goal efficiently,
while being polite and concise. You are an AI phone agent; do NOT
mention internal metadata like user IDs or client state.`;
  }

  return prompt;
}

/**
 * Call Groq LLM with user text and return the AI response.
 * @param userText - The user's input text
 * @param context - Optional call context with goal and other metadata
 * @returns The AI-generated response, or an empty string if no response
 */
export async function generateAssistantReply(
  userText: string,
  context?: CallContext
): Promise<string> {
  const systemPrompt = buildSystemPrompt(context);

  const response = await groq.chat.completions.create({
    model: config.groq.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
  });

  return response.choices[0]?.message?.content || "";
}
