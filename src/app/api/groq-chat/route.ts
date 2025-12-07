import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import OpenAI from 'openai';

// Groq API configuration
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

// Available Groq models for selection
export const GROQ_MODELS = [
  { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant', description: 'Fast, efficient model for quick responses' },
  { id: 'llama-3.1-70b-versatile', name: 'Llama 3.1 70B Versatile', description: 'Larger model with better reasoning' },
  { id: 'llama-3.2-1b-preview', name: 'Llama 3.2 1B Preview', description: 'Smallest, fastest model' },
  { id: 'llama-3.2-3b-preview', name: 'Llama 3.2 3B Preview', description: 'Small but capable model' },
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', description: 'Latest large model' },
  { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', description: 'Mixture of experts model' },
  { id: 'gemma2-9b-it', name: 'Gemma 2 9B IT', description: 'Google Gemma 2 instruction-tuned' },
];

// Message type for chat
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Request body interface
interface GroqChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
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
      messages,
      model = DEFAULT_MODEL,
      temperature = 0.7,
      max_tokens = 1024,
      top_p = 1,
    } = body;

    // Validate messages
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: 'Messages array is required' },
        { status: 400 }
      );
    }

    // Create Groq client (using OpenAI-compatible interface)
    const groq = new OpenAI({
      apiKey: GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
    });

    // Call Groq API
    const startTime = Date.now();
    const response = await groq.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens,
      top_p,
    });
    const endTime = Date.now();

    // Extract response data
    const completion = response.choices[0]?.message?.content || '';
    const usage = response.usage;

    return NextResponse.json({
      success: true,
      response: completion,
      model: response.model,
      usage: {
        prompt_tokens: usage?.prompt_tokens || 0,
        completion_tokens: usage?.completion_tokens || 0,
        total_tokens: usage?.total_tokens || 0,
      },
      latency_ms: endTime - startTime,
    });
  } catch (error: any) {
    console.error('Groq chat error:', error);

    // Handle specific error types
    if (error?.status === 429) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Please try again in a moment.' },
        { status: 429 }
      );
    }

    if (error?.status === 400) {
      return NextResponse.json(
        { error: error.message || 'Invalid request to Groq API' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: error.message || 'Failed to generate response' },
      { status: 500 }
    );
  }
}

// GET endpoint to return available models and default settings
export async function GET() {
  return NextResponse.json({
    models: GROQ_MODELS,
    defaultModel: DEFAULT_MODEL,
    defaultSettings: {
      temperature: 0.7,
      max_tokens: 1024,
      top_p: 1,
    },
  });
}
