import OpenAI from "openai";
import config from "../config";

// Create Groq client configured with API key and base URL
const groq = new OpenAI({
  apiKey: config.groq.apiKey,
  baseURL: "https://api.groq.com/openai/v1",
});

/**
 * Call Groq LLM with user text and return the AI response.
 * @param userText - The user's input text
 * @returns The AI-generated response, or an empty string if no response
 */
export async function generateAssistantReply(userText: string): Promise<string> {
  const response = await groq.chat.completions.create({
    model: config.groq.model,
    messages: [
      { role: "system", content: config.llm.systemPrompt },
      { role: "user", content: userText },
    ],
  });

  return response.choices[0]?.message?.content || "";
}
