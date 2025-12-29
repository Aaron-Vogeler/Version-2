/**
 * API route to update user's Groq call settings
 * Saves all configuration including model, prompts, and call control settings
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Define the shape of Groq settings
interface GroqSettings {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  reasoning?: 'low' | 'medium' | 'high';
  stream?: boolean;
  jsonMode?: boolean;
  chunkFirstTurnByPunctuation?: boolean;
  customSystemPrompt?: string;
  rollingSummaryPrompt?: string;
  geminiCachedPrompt?: string;
  ttsVoiceId?: string;
  manualMode?: boolean;
  callControlSettings?: {
    ttsDebounceMs?: number;
    bargeInCooldownMs?: number;
    callerUtteranceFlushMs?: number;
    hangupDelayMs?: number;
    holdCheckInIntervalMs?: number;
    holdMaxCheckIns?: number;
  };
  ivrSettings?: {
    debounceMs?: number;
    utteranceFlushMs?: number;
    dtmfMinPauseMs?: number;
    dtmfDurationMs?: number;
    autoDetectThreshold?: number;
    responseTimeoutMs?: number;
    maxDtmfRetries?: number;
    disableBargeInGracePeriod?: boolean;
  };
  humanDetectionSettings?: {
    enabled?: boolean;
    utteranceFlushMs?: number;
    humanWaitMs?: number;
    ivrWaitMs?: number;
    minUtterances?: number;
    holdSilenceMs?: number;
    humanTurnsAfterHold?: number;
    maxUnsure?: number;
    classificationModel?: string;
    classificationPrompt?: string;
  };
  musicDetectionSettings?: {
    enabled?: boolean;
    windowSize?: number;
    musicThreshold?: number;
    silenceThreshold?: number;
    hysteresisMs?: number;
    auditLogging?: boolean;
    useTranscriptPatterns?: boolean;
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check authentication
  const session = await getServerSession(req, res, authOptions);

  if (!session || !session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const groqSettings: GroqSettings = req.body;

    // Validate input is an object
    if (!groqSettings || typeof groqSettings !== 'object') {
      return res.status(400).json({ error: 'Invalid settings format' });
    }

    // Sanitize and validate settings
    const sanitizedSettings: GroqSettings = {};

    // Model (string, max 100 chars)
    if (groqSettings.model !== undefined) {
      if (typeof groqSettings.model !== 'string') {
        return res.status(400).json({ error: 'Invalid model format' });
      }
      sanitizedSettings.model = groqSettings.model.substring(0, 100);
    }

    // Temperature (number between 0 and 2)
    if (groqSettings.temperature !== undefined) {
      const temp = Number(groqSettings.temperature);
      if (isNaN(temp) || temp < 0 || temp > 2) {
        return res.status(400).json({ error: 'Temperature must be between 0 and 2' });
      }
      sanitizedSettings.temperature = temp;
    }

    // Max Tokens (number between 1 and 32768)
    if (groqSettings.maxTokens !== undefined) {
      const tokens = Number(groqSettings.maxTokens);
      if (isNaN(tokens) || tokens < 1 || tokens > 32768) {
        return res.status(400).json({ error: 'Max tokens must be between 1 and 32768' });
      }
      sanitizedSettings.maxTokens = Math.floor(tokens);
    }

    // Top P (number between 0 and 1)
    if (groqSettings.topP !== undefined) {
      const topP = Number(groqSettings.topP);
      if (isNaN(topP) || topP < 0 || topP > 1) {
        return res.status(400).json({ error: 'Top P must be between 0 and 1' });
      }
      sanitizedSettings.topP = topP;
    }

    // Reasoning (enum)
    if (groqSettings.reasoning !== undefined) {
      if (!['low', 'medium', 'high'].includes(groqSettings.reasoning)) {
        return res.status(400).json({ error: 'Invalid reasoning value' });
      }
      sanitizedSettings.reasoning = groqSettings.reasoning;
    }

    // Stream (boolean)
    if (groqSettings.stream !== undefined) {
      sanitizedSettings.stream = Boolean(groqSettings.stream);
    }

    // JSON Mode (boolean)
    if (groqSettings.jsonMode !== undefined) {
      sanitizedSettings.jsonMode = Boolean(groqSettings.jsonMode);
    }

    // Custom System Prompt (string, max 10000 chars)
    if (groqSettings.customSystemPrompt !== undefined) {
      if (typeof groqSettings.customSystemPrompt !== 'string') {
        return res.status(400).json({ error: 'Invalid system prompt format' });
      }
      sanitizedSettings.customSystemPrompt = groqSettings.customSystemPrompt.substring(0, 10000);
    }

    // Rolling Summary Prompt (string, max 5000 chars)
    if (groqSettings.rollingSummaryPrompt !== undefined) {
      if (typeof groqSettings.rollingSummaryPrompt !== 'string') {
        return res.status(400).json({ error: 'Invalid rolling summary prompt format' });
      }
      sanitizedSettings.rollingSummaryPrompt = groqSettings.rollingSummaryPrompt.substring(0, 5000);
    }

    // Gemini Cached Prompt (string, max 50000 chars - can be very long)
    if (groqSettings.geminiCachedPrompt !== undefined) {
      if (typeof groqSettings.geminiCachedPrompt !== 'string') {
        return res.status(400).json({ error: 'Invalid Gemini cached prompt format' });
      }
      sanitizedSettings.geminiCachedPrompt = groqSettings.geminiCachedPrompt.substring(0, 50000);
    }

    // TTS Voice ID (string, max 100 chars)
    if (groqSettings.ttsVoiceId !== undefined) {
      if (typeof groqSettings.ttsVoiceId !== 'string') {
        return res.status(400).json({ error: 'Invalid TTS voice ID format' });
      }
      sanitizedSettings.ttsVoiceId = groqSettings.ttsVoiceId.substring(0, 100);
    }

    // Manual Mode (boolean)
    if (groqSettings.manualMode !== undefined) {
      sanitizedSettings.manualMode = Boolean(groqSettings.manualMode);
    }

    // Chunk First Turn By Punctuation (boolean)
    if (groqSettings.chunkFirstTurnByPunctuation !== undefined) {
      sanitizedSettings.chunkFirstTurnByPunctuation = Boolean(groqSettings.chunkFirstTurnByPunctuation);
    }

    // Call Control Settings
    if (groqSettings.callControlSettings !== undefined) {
      if (typeof groqSettings.callControlSettings !== 'object') {
        return res.status(400).json({ error: 'Invalid call control settings format' });
      }
      sanitizedSettings.callControlSettings = {};
      const ccs = groqSettings.callControlSettings;

      if (ccs.ttsDebounceMs !== undefined) {
        const val = Number(ccs.ttsDebounceMs);
        if (!isNaN(val) && val >= 100 && val <= 5000) {
          sanitizedSettings.callControlSettings.ttsDebounceMs = Math.floor(val);
        }
      }
      if (ccs.bargeInCooldownMs !== undefined) {
        const val = Number(ccs.bargeInCooldownMs);
        if (!isNaN(val) && val >= 100 && val <= 2000) {
          sanitizedSettings.callControlSettings.bargeInCooldownMs = Math.floor(val);
        }
      }
      if (ccs.callerUtteranceFlushMs !== undefined) {
        const val = Number(ccs.callerUtteranceFlushMs);
        if (!isNaN(val) && val >= 100 && val <= 2000) {
          sanitizedSettings.callControlSettings.callerUtteranceFlushMs = Math.floor(val);
        }
      }
      if (ccs.hangupDelayMs !== undefined) {
        const val = Number(ccs.hangupDelayMs);
        if (!isNaN(val) && val >= 500 && val <= 10000) {
          sanitizedSettings.callControlSettings.hangupDelayMs = Math.floor(val);
        }
      }
      if (ccs.holdCheckInIntervalMs !== undefined) {
        const val = Number(ccs.holdCheckInIntervalMs);
        if (!isNaN(val) && val >= 5000 && val <= 300000) {
          sanitizedSettings.callControlSettings.holdCheckInIntervalMs = Math.floor(val);
        }
      }
      if (ccs.holdMaxCheckIns !== undefined) {
        const val = Number(ccs.holdMaxCheckIns);
        if (!isNaN(val) && val >= 1 && val <= 50) {
          sanitizedSettings.callControlSettings.holdMaxCheckIns = Math.floor(val);
        }
      }
    }

    // IVR Settings
    if (groqSettings.ivrSettings !== undefined) {
      if (typeof groqSettings.ivrSettings !== 'object') {
        return res.status(400).json({ error: 'Invalid IVR settings format' });
      }
      sanitizedSettings.ivrSettings = {};
      const ivr = groqSettings.ivrSettings;

      if (ivr.debounceMs !== undefined) {
        const val = Number(ivr.debounceMs);
        if (!isNaN(val) && val >= 50 && val <= 1000) {
          sanitizedSettings.ivrSettings.debounceMs = Math.floor(val);
        }
      }
      if (ivr.utteranceFlushMs !== undefined) {
        const val = Number(ivr.utteranceFlushMs);
        if (!isNaN(val) && val >= 50 && val <= 1000) {
          sanitizedSettings.ivrSettings.utteranceFlushMs = Math.floor(val);
        }
      }
      if (ivr.dtmfMinPauseMs !== undefined) {
        const val = Number(ivr.dtmfMinPauseMs);
        if (!isNaN(val) && val >= 100 && val <= 2000) {
          sanitizedSettings.ivrSettings.dtmfMinPauseMs = Math.floor(val);
        }
      }
      if (ivr.dtmfDurationMs !== undefined) {
        const val = Number(ivr.dtmfDurationMs);
        if (!isNaN(val) && val >= 100 && val <= 1000) {
          sanitizedSettings.ivrSettings.dtmfDurationMs = Math.floor(val);
        }
      }
      if (ivr.autoDetectThreshold !== undefined) {
        const val = Number(ivr.autoDetectThreshold);
        if (!isNaN(val) && val >= 0.1 && val <= 1.0) {
          sanitizedSettings.ivrSettings.autoDetectThreshold = val;
        }
      }
      if (ivr.responseTimeoutMs !== undefined) {
        const val = Number(ivr.responseTimeoutMs);
        if (!isNaN(val) && val >= 1000 && val <= 30000) {
          sanitizedSettings.ivrSettings.responseTimeoutMs = Math.floor(val);
        }
      }
      if (ivr.maxDtmfRetries !== undefined) {
        const val = Number(ivr.maxDtmfRetries);
        if (!isNaN(val) && val >= 0 && val <= 10) {
          sanitizedSettings.ivrSettings.maxDtmfRetries = Math.floor(val);
        }
      }
      if (ivr.disableBargeInGracePeriod !== undefined) {
        sanitizedSettings.ivrSettings.disableBargeInGracePeriod = Boolean(ivr.disableBargeInGracePeriod);
      }
    }

    // Human Detection Settings
    if (groqSettings.humanDetectionSettings !== undefined) {
      if (typeof groqSettings.humanDetectionSettings !== 'object') {
        return res.status(400).json({ error: 'Invalid human detection settings format' });
      }
      sanitizedSettings.humanDetectionSettings = {};
      const hd = groqSettings.humanDetectionSettings;

      if (hd.enabled !== undefined) {
        sanitizedSettings.humanDetectionSettings.enabled = Boolean(hd.enabled);
      }
      if (hd.utteranceFlushMs !== undefined) {
        const val = Number(hd.utteranceFlushMs);
        if (!isNaN(val) && val >= 100 && val <= 5000) {
          sanitizedSettings.humanDetectionSettings.utteranceFlushMs = Math.floor(val);
        }
      }
      if (hd.humanWaitMs !== undefined) {
        const val = Number(hd.humanWaitMs);
        if (!isNaN(val) && val >= 100 && val <= 10000) {
          sanitizedSettings.humanDetectionSettings.humanWaitMs = Math.floor(val);
        }
      }
      if (hd.ivrWaitMs !== undefined) {
        const val = Number(hd.ivrWaitMs);
        if (!isNaN(val) && val >= 100 && val <= 10000) {
          sanitizedSettings.humanDetectionSettings.ivrWaitMs = Math.floor(val);
        }
      }
      if (hd.minUtterances !== undefined) {
        const val = Number(hd.minUtterances);
        if (!isNaN(val) && val >= 1 && val <= 10) {
          sanitizedSettings.humanDetectionSettings.minUtterances = Math.floor(val);
        }
      }
      if (hd.holdSilenceMs !== undefined) {
        const val = Number(hd.holdSilenceMs);
        if (!isNaN(val) && val >= 1000 && val <= 60000) {
          sanitizedSettings.humanDetectionSettings.holdSilenceMs = Math.floor(val);
        }
      }
      if (hd.humanTurnsAfterHold !== undefined) {
        const val = Number(hd.humanTurnsAfterHold);
        if (!isNaN(val) && val >= 1 && val <= 10) {
          sanitizedSettings.humanDetectionSettings.humanTurnsAfterHold = Math.floor(val);
        }
      }
      if (hd.maxUnsure !== undefined) {
        const val = Number(hd.maxUnsure);
        if (!isNaN(val) && val >= 1 && val <= 20) {
          sanitizedSettings.humanDetectionSettings.maxUnsure = Math.floor(val);
        }
      }
      if (hd.classificationModel !== undefined && typeof hd.classificationModel === 'string') {
        sanitizedSettings.humanDetectionSettings.classificationModel = hd.classificationModel.substring(0, 100);
      }
      if (hd.classificationPrompt !== undefined && typeof hd.classificationPrompt === 'string') {
        sanitizedSettings.humanDetectionSettings.classificationPrompt = hd.classificationPrompt.substring(0, 5000);
      }
    }

    // Music Detection Settings
    if (groqSettings.musicDetectionSettings !== undefined) {
      if (typeof groqSettings.musicDetectionSettings !== 'object') {
        return res.status(400).json({ error: 'Invalid music detection settings format' });
      }
      sanitizedSettings.musicDetectionSettings = {};
      const md = groqSettings.musicDetectionSettings;

      if (md.enabled !== undefined) {
        sanitizedSettings.musicDetectionSettings.enabled = Boolean(md.enabled);
      }
      if (md.windowSize !== undefined) {
        const val = Number(md.windowSize);
        if (!isNaN(val) && val >= 1 && val <= 100) {
          sanitizedSettings.musicDetectionSettings.windowSize = Math.floor(val);
        }
      }
      if (md.musicThreshold !== undefined) {
        const val = Number(md.musicThreshold);
        if (!isNaN(val) && val >= 0 && val <= 1) {
          sanitizedSettings.musicDetectionSettings.musicThreshold = val;
        }
      }
      if (md.silenceThreshold !== undefined) {
        const val = Number(md.silenceThreshold);
        if (!isNaN(val) && val >= 0 && val <= 1) {
          sanitizedSettings.musicDetectionSettings.silenceThreshold = val;
        }
      }
      if (md.hysteresisMs !== undefined) {
        const val = Number(md.hysteresisMs);
        if (!isNaN(val) && val >= 100 && val <= 10000) {
          sanitizedSettings.musicDetectionSettings.hysteresisMs = Math.floor(val);
        }
      }
      if (md.auditLogging !== undefined) {
        sanitizedSettings.musicDetectionSettings.auditLogging = Boolean(md.auditLogging);
      }
      if (md.useTranscriptPatterns !== undefined) {
        sanitizedSettings.musicDetectionSettings.useTranscriptPatterns = Boolean(md.useTranscriptPatterns);
      }
    }

    const userId = (session.user as any).id;

    // Create Supabase client with service role key for admin access
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Update the profile with groq_settings
    const { error } = await supabase
      .from('profiles')
      .update({
        groq_settings: sanitizedSettings,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    if (error) {
      console.error('Error updating groq settings:', error);
      return res.status(500).json({ error: 'Failed to save settings' });
    }

    return res.status(200).json({
      success: true,
      groq_settings: sanitizedSettings
    });
  } catch (error: any) {
    console.error('Update groq settings error:', error);
    return res.status(500).json({
      error: 'Failed to save settings',
      message: error.message
    });
  }
}
