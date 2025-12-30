/**
 * Secure API proxy for delegating calls to Fly.io AI server
 * Requires authentication via NextAuth
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from './auth/[...nextauth]';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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
    // Validate request body
    const { goal, context, to_number, custom_system_prompt, rolling_summary_prompt, tts_voice_id, tts_debounce_ms, barge_in_cooldown_ms, caller_utterance_flush_ms, hold_check_in_interval_ms, hold_max_check_ins, ivr_debounce_ms, ivr_utterance_flush_ms, ivr_dtmf_min_pause_ms, ivr_dtmf_duration_ms, ivr_auto_detect_threshold, ivr_response_timeout_ms, ivr_max_dtmf_retries, ivr_disable_barge_in_grace_period, human_detection_enabled, human_detection_utterance_flush_ms, human_detection_human_wait_ms, human_detection_ivr_wait_ms, human_detection_min_utterances, human_detection_hold_silence_ms, human_detection_human_turns_after_hold, human_detection_max_unsure, human_detection_classification_model, human_detection_classification_prompt, music_detection_enabled, music_detection_window_size, music_detection_music_threshold, music_detection_silence_threshold, music_detection_hysteresis_ms, music_detection_audit_logging, music_detection_use_transcript_patterns, diarization_enabled, diarization_debounce_ms, diarization_min_confidence, diarization_audit_logging, model, temperature, max_tokens, top_p, reasoning, stream, json_mode, chunk_first_turn_by_punctuation, manual_mode } = req.body;

    if (!goal || !to_number) {
      return res.status(400).json({ error: 'Missing required fields: goal and to_number' });
    }

    // Extract user ID from NextAuth session
    // session.user.id is set in the jwt callback of [...nextauth].ts
    const userId = (session.user as any).id;
    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in session' });
    }

    // Fetch custom assistant name, first name, and groq_settings from profile
    let customAssistantName = null;
    let firstName = null;
    let savedGroqSettings: any = null;
    if (supabaseUrl && supabaseServiceKey) {
      try {
        const supabase = createClient(supabaseUrl, supabaseServiceKey);
        const { data, error } = await supabase
          .from('profiles')
          .select('custom_assistant_name, first_name, groq_settings')
          .eq('user_id', userId)
          .single();

        if (!error && data) {
          customAssistantName = data.custom_assistant_name;
          firstName = data.first_name;
          savedGroqSettings = data.groq_settings;
        }
      } catch (error) {
        console.error('Error fetching profile data:', error);
      }
    }

    // Use saved groq_settings as defaults, allow request body to override
    const effectiveSystemPrompt = custom_system_prompt || savedGroqSettings?.customSystemPrompt;
    const effectiveRollingSummaryPrompt = rolling_summary_prompt || savedGroqSettings?.rollingSummaryPrompt;
    const effectiveTtsVoiceId = tts_voice_id || savedGroqSettings?.ttsVoiceId;
    const effectiveGeminiCachedPrompt = savedGroqSettings?.geminiCachedPrompt;
    const effectiveModel = model || savedGroqSettings?.model;

    // Debug logging for Gemini cached prompt
    console.log('[Delegate] groq_settings keys:', savedGroqSettings ? Object.keys(savedGroqSettings) : 'null');
    console.log('[Delegate] geminiCachedPrompt:', effectiveGeminiCachedPrompt ? `${effectiveGeminiCachedPrompt.length} chars` : 'not set');
    const effectiveTemperature = temperature ?? savedGroqSettings?.temperature;
    const effectiveMaxTokens = max_tokens ?? savedGroqSettings?.maxTokens;
    const effectiveTopP = top_p ?? savedGroqSettings?.topP;
    const effectiveReasoning = reasoning || savedGroqSettings?.reasoning;
    const effectiveStream = stream ?? savedGroqSettings?.stream;
    const effectiveJsonMode = json_mode ?? savedGroqSettings?.jsonMode;
    const effectiveChunkFirstTurn = chunk_first_turn_by_punctuation ?? savedGroqSettings?.chunkFirstTurnByPunctuation;
    const effectiveManualMode = manual_mode ?? savedGroqSettings?.manualMode;

    // Merge call control settings
    const savedCallControl = savedGroqSettings?.callControlSettings || {};
    const effectiveTtsDebounceMs = tts_debounce_ms ?? savedCallControl.ttsDebounceMs;
    const effectiveBargeInCooldownMs = barge_in_cooldown_ms ?? savedCallControl.bargeInCooldownMs;
    const effectiveCallerUtteranceFlushMs = caller_utterance_flush_ms ?? savedCallControl.callerUtteranceFlushMs;
    const effectiveHoldCheckInIntervalMs = hold_check_in_interval_ms ?? savedCallControl.holdCheckInIntervalMs;
    const effectiveHoldMaxCheckIns = hold_max_check_ins ?? savedCallControl.holdMaxCheckIns;

    // Merge IVR settings
    const savedIvrSettings = savedGroqSettings?.ivrSettings || {};
    const effectiveIvrDebounceMs = ivr_debounce_ms ?? savedIvrSettings.debounceMs;
    const effectiveIvrUtteranceFlushMs = ivr_utterance_flush_ms ?? savedIvrSettings.utteranceFlushMs;
    const effectiveIvrDtmfMinPauseMs = ivr_dtmf_min_pause_ms ?? savedIvrSettings.dtmfMinPauseMs;
    const effectiveIvrDtmfDurationMs = ivr_dtmf_duration_ms ?? savedIvrSettings.dtmfDurationMs;
    const effectiveIvrAutoDetectThreshold = ivr_auto_detect_threshold ?? savedIvrSettings.autoDetectThreshold;
    const effectiveIvrResponseTimeoutMs = ivr_response_timeout_ms ?? savedIvrSettings.responseTimeoutMs;
    const effectiveIvrMaxDtmfRetries = ivr_max_dtmf_retries ?? savedIvrSettings.maxDtmfRetries;
    const effectiveIvrDisableBargeInGracePeriod = ivr_disable_barge_in_grace_period ?? savedIvrSettings.disableBargeInGracePeriod;

    // Merge human detection settings
    const savedHumanDetection = savedGroqSettings?.humanDetectionSettings || {};
    const effectiveHumanDetectionEnabled = human_detection_enabled ?? savedHumanDetection.enabled;
    const effectiveHumanDetectionUtteranceFlushMs = human_detection_utterance_flush_ms ?? savedHumanDetection.utteranceFlushMs;
    const effectiveHumanDetectionHumanWaitMs = human_detection_human_wait_ms ?? savedHumanDetection.humanWaitMs;
    const effectiveHumanDetectionIvrWaitMs = human_detection_ivr_wait_ms ?? savedHumanDetection.ivrWaitMs;
    const effectiveHumanDetectionMinUtterances = human_detection_min_utterances ?? savedHumanDetection.minUtterances;
    const effectiveHumanDetectionHoldSilenceMs = human_detection_hold_silence_ms ?? savedHumanDetection.holdSilenceMs;
    const effectiveHumanDetectionHumanTurnsAfterHold = human_detection_human_turns_after_hold ?? savedHumanDetection.humanTurnsAfterHold;
    const effectiveHumanDetectionMaxUnsure = human_detection_max_unsure ?? savedHumanDetection.maxUnsure;
    const effectiveHumanDetectionClassificationModel = human_detection_classification_model || savedHumanDetection.classificationModel;
    const effectiveHumanDetectionClassificationPrompt = human_detection_classification_prompt || savedHumanDetection.classificationPrompt;

    // Merge music detection settings
    const savedMusicDetection = savedGroqSettings?.musicDetectionSettings || {};
    const effectiveMusicDetectionEnabled = music_detection_enabled ?? savedMusicDetection.enabled;
    const effectiveMusicDetectionWindowSize = music_detection_window_size ?? savedMusicDetection.windowSize;
    const effectiveMusicDetectionMusicThreshold = music_detection_music_threshold ?? savedMusicDetection.musicThreshold;
    const effectiveMusicDetectionSilenceThreshold = music_detection_silence_threshold ?? savedMusicDetection.silenceThreshold;
    const effectiveMusicDetectionHysteresisMs = music_detection_hysteresis_ms ?? savedMusicDetection.hysteresisMs;
    const effectiveMusicDetectionAuditLogging = music_detection_audit_logging ?? savedMusicDetection.auditLogging;
    const effectiveMusicDetectionUseTranscriptPatterns = music_detection_use_transcript_patterns ?? savedMusicDetection.useTranscriptPatterns;

    // Validate that we have a system prompt (either from request or saved settings)
    if (!effectiveSystemPrompt) {
      return res.status(400).json({ error: 'Missing required field: custom_system_prompt (not provided and no saved settings found)' });
    }

    // Forward request to Fly.io AI server
    const flyUrl = 'https://version-2-cr4fsa.fly.dev/api/outbound-call';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const flyResponse = await fetch(flyUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        goal,
        additionalContext: context,
        toNumber: to_number,
        userId,
        assistantName: customAssistantName,
        userName: firstName,
        // Use effective values (merged from request and saved settings)
        systemPrompt: effectiveSystemPrompt,
        rollingSummaryPrompt: effectiveRollingSummaryPrompt,
        geminiCachedPrompt: effectiveGeminiCachedPrompt,
        // TTS settings
        ttsVoiceId: effectiveTtsVoiceId,
        // Call control settings
        ttsDebounceMs: effectiveTtsDebounceMs,
        bargeInCooldownMs: effectiveBargeInCooldownMs,
        callerUtteranceFlushMs: effectiveCallerUtteranceFlushMs,
        holdCheckInIntervalMs: effectiveHoldCheckInIntervalMs,
        holdMaxCheckIns: effectiveHoldMaxCheckIns,
        // IVR/Phone Tree settings
        ivrDebounceMs: effectiveIvrDebounceMs,
        ivrUtteranceFlushMs: effectiveIvrUtteranceFlushMs,
        ivrDtmfMinPauseMs: effectiveIvrDtmfMinPauseMs,
        ivrDtmfDurationMs: effectiveIvrDtmfDurationMs,
        ivrAutoDetectThreshold: effectiveIvrAutoDetectThreshold,
        ivrResponseTimeoutMs: effectiveIvrResponseTimeoutMs,
        ivrMaxDtmfRetries: effectiveIvrMaxDtmfRetries,
        ivrDisableBargeInGracePeriod: effectiveIvrDisableBargeInGracePeriod,
        // Human Detection settings (IVR vs Human state machine)
        humanDetectionEnabled: effectiveHumanDetectionEnabled,
        humanDetectionUtteranceFlushMs: effectiveHumanDetectionUtteranceFlushMs,
        humanDetectionHumanWaitMs: effectiveHumanDetectionHumanWaitMs,
        humanDetectionIvrWaitMs: effectiveHumanDetectionIvrWaitMs,
        humanDetectionMinUtterances: effectiveHumanDetectionMinUtterances,
        humanDetectionHoldSilenceMs: effectiveHumanDetectionHoldSilenceMs,
        humanDetectionHumanTurnsAfterHold: effectiveHumanDetectionHumanTurnsAfterHold,
        humanDetectionMaxUnsure: effectiveHumanDetectionMaxUnsure,
        humanDetectionClassificationModel: effectiveHumanDetectionClassificationModel,
        humanDetectionClassificationPrompt: effectiveHumanDetectionClassificationPrompt,
        // Music Detection settings (Energy Floor)
        musicDetectionEnabled: effectiveMusicDetectionEnabled,
        musicDetectionWindowSize: effectiveMusicDetectionWindowSize,
        musicDetectionMusicThreshold: effectiveMusicDetectionMusicThreshold,
        musicDetectionSilenceThreshold: effectiveMusicDetectionSilenceThreshold,
        musicDetectionHysteresisMs: effectiveMusicDetectionHysteresisMs,
        musicDetectionAuditLogging: effectiveMusicDetectionAuditLogging,
        musicDetectionUseTranscriptPatterns: effectiveMusicDetectionUseTranscriptPatterns,
        // Diarization settings (Speaker Change Detection) - keep original values as they're not in groq_settings
        diarizationEnabled: diarization_enabled,
        diarizationDebounceMs: diarization_debounce_ms,
        diarizationMinConfidence: diarization_min_confidence,
        diarizationAuditLogging: diarization_audit_logging,
        // LLM settings
        model: effectiveModel,
        temperature: effectiveTemperature,
        maxTokens: effectiveMaxTokens,
        topP: effectiveTopP,
        reasoning: effectiveReasoning,
        stream: effectiveStream,
        jsonMode: effectiveJsonMode,
        chunkFirstTurnByPunctuation: effectiveChunkFirstTurn,
        // Manual mode
        manualMode: effectiveManualMode,
      }),
    });

    // Get response body
    const responseData = await flyResponse.json().catch(() => ({}));

    // If Fly.io returns an error, forward that status + message
    if (!flyResponse.ok) {
      return res.status(flyResponse.status).json(responseData);
    }

    // If successful, return status ok with fly response
    return res.status(200).json({
      status: 'ok',
      flyResponse: responseData,
    });
  } catch (error: any) {
    console.error('Delegate API error:', error);
    return res.status(500).json({
      error: 'Failed to delegate call',
      message: error.message
    });
  }
}
