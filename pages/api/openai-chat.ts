/**
 * OpenAI Chat API Endpoint
 * Provides AI assistance for configuring AI outbound call settings.
 *
 * This endpoint uses OpenAI's GPT models to help users understand
 * and configure their call settings properly.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from './auth/[...nextauth]';

// OpenAI API Key from environment
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// System prompt for the AI assistant
const SYSTEM_PROMPT = `You are an expert AI assistant specializing in configuring AI outbound phone call systems. You help users understand and configure settings for professional AI phone calls.

You have deep knowledge of:
1. **Human vs IVR Detection**: How AI distinguishes between human callers and automated phone systems (IVRs/phone trees)
2. **Voice & Timing Settings**: TTS debounce, barge-in cooldown, utterance flush timing
3. **DTMF/Phone Tree Navigation**: How to configure tones for navigating automated systems
4. **LLM Configuration**: Model selection, temperature, tokens, and prompt engineering
5. **Hold Handling**: Managing calls when placed on hold

Key concepts you should explain clearly:
- **Debounce**: The silence threshold before the AI responds. Humans need longer (400-600ms for natural pace), IVRs need shorter (100-200ms for quick response).
- **Utterance Flush**: How long to wait before finalizing what was heard. Affects transcription accuracy.
- **Barge-In**: When the caller interrupts the AI speaking. Grace period prevents echo-triggered stops.
- **DTMF**: Dual-tone multi-frequency signaling - the button press tones for phone menus.
- **Auto-Detection Threshold**: Confidence level (0-1) for classifying a call as IVR vs human.

When answering:
- Be concise but thorough
- Give specific recommended values when asked
- Explain the "why" behind settings
- If a user describes a problem, diagnose it based on their settings
- Suggest adjustments based on their use case

Current user context will be provided with each message including their current settings and configuration status.`;

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface RequestBody {
  messages: ChatMessage[];
  context?: {
    currentSettings?: any;
    assistantName?: string;
    userName?: string;
    checklistStats?: {
      complete: number;
      warning: number;
      error: number;
      total: number;
    };
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check authentication
  const session = await getServerSession(req, res, authOptions);
  if (!session || !session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Check for API key
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OpenAI API key not configured' });
  }

  try {
    const body: RequestBody = req.body;
    const { messages, context } = body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // Build context string for the AI
    let contextString = '';
    if (context) {
      contextString = '\n\n---\nCURRENT USER CONTEXT:\n';

      if (context.checklistStats) {
        contextString += `Configuration Progress: ${context.checklistStats.complete}/${context.checklistStats.total} complete`;
        if (context.checklistStats.warning > 0) {
          contextString += `, ${context.checklistStats.warning} warnings`;
        }
        if (context.checklistStats.error > 0) {
          contextString += `, ${context.checklistStats.error} errors`;
        }
        contextString += '\n';
      }

      if (context.assistantName) {
        contextString += `Assistant Name: ${context.assistantName}\n`;
      }

      if (context.userName) {
        contextString += `User Name: ${context.userName}\n`;
      }

      if (context.currentSettings) {
        const settings = context.currentSettings;
        contextString += '\nCurrent Settings:\n';

        // LLM Settings
        if (settings.model) contextString += `- Model: ${settings.model}\n`;
        if (settings.temperature !== undefined) contextString += `- Temperature: ${settings.temperature}\n`;
        if (settings.maxTokens) contextString += `- Max Tokens: ${settings.maxTokens}\n`;
        if (settings.reasoning) contextString += `- Reasoning: ${settings.reasoning}\n`;

        // Call Control Settings
        if (settings.callControlSettings) {
          const cc = settings.callControlSettings;
          contextString += '\nCall Control:\n';
          if (cc.ttsDebounceMs) contextString += `- TTS Debounce: ${cc.ttsDebounceMs}ms\n`;
          if (cc.bargeInCooldownMs) contextString += `- Barge-In Cooldown: ${cc.bargeInCooldownMs}ms\n`;
          if (cc.callerUtteranceFlushMs) contextString += `- Utterance Flush: ${cc.callerUtteranceFlushMs}ms\n`;
          if (cc.holdCheckInIntervalMs) contextString += `- Hold Check-In: ${cc.holdCheckInIntervalMs}ms\n`;
          if (cc.holdMaxCheckIns) contextString += `- Max Hold Check-Ins: ${cc.holdMaxCheckIns}\n`;
        }

        // IVR Settings
        if (settings.ivrSettings) {
          const ivr = settings.ivrSettings;
          contextString += '\nIVR Settings:\n';
          if (ivr.debounceMs) contextString += `- IVR Debounce: ${ivr.debounceMs}ms\n`;
          if (ivr.utteranceFlushMs) contextString += `- IVR Utterance Flush: ${ivr.utteranceFlushMs}ms\n`;
          if (ivr.dtmfDurationMs) contextString += `- DTMF Duration: ${ivr.dtmfDurationMs}ms\n`;
          if (ivr.dtmfMinPauseMs) contextString += `- DTMF Min Pause: ${ivr.dtmfMinPauseMs}ms\n`;
          if (ivr.autoDetectThreshold !== undefined) contextString += `- Auto-Detect Threshold: ${ivr.autoDetectThreshold}\n`;
        }

        // System Prompt Status
        if (settings.customSystemPrompt) {
          contextString += `\nSystem Prompt: Set (${settings.customSystemPrompt.length} characters)\n`;
        } else {
          contextString += '\nSystem Prompt: NOT SET (REQUIRED!)\n';
        }
      }
    }

    // Build the messages array for OpenAI
    const openaiMessages = [
      { role: 'system', content: SYSTEM_PROMPT + contextString },
      ...messages.slice(-10), // Keep last 10 messages for context window
    ];

    // Call OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // Using GPT-4o-mini for cost-effectiveness
        messages: openaiMessages,
        temperature: 0.7,
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('OpenAI API error:', errorData);
      return res.status(response.status).json({
        error: 'Failed to get AI response',
        details: errorData.error?.message || 'Unknown error',
      });
    }

    const data = await response.json();
    const assistantMessage = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';

    return res.status(200).json({
      message: assistantMessage,
      usage: data.usage,
    });
  } catch (error: any) {
    console.error('OpenAI chat error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message,
    });
  }
}
