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
    const { goal, context, to_number, custom_system_prompt, rolling_summary_prompt, tts_voice_id, tts_debounce_ms, barge_in_cooldown_ms, caller_utterance_flush_ms, hold_check_in_interval_ms, hold_max_check_ins, ivr_debounce_ms, ivr_utterance_flush_ms, ivr_dtmf_min_pause_ms, ivr_dtmf_duration_ms, ivr_auto_detect_threshold, ivr_response_timeout_ms, ivr_max_dtmf_retries, ivr_disable_barge_in_grace_period, human_detection_enabled, human_detection_utterance_flush_ms, human_detection_human_wait_ms, human_detection_ivr_wait_ms, human_detection_min_utterances, human_detection_hold_silence_ms, human_detection_human_turns_after_hold, human_detection_max_unsure, human_detection_classification_model, human_detection_classification_prompt, music_detection_enabled, music_detection_window_size, music_detection_music_threshold, music_detection_silence_threshold, music_detection_hysteresis_ms, music_detection_audit_logging, music_detection_use_transcript_patterns, diarization_enabled, diarization_debounce_ms, diarization_min_confidence, diarization_audit_logging, model, temperature, max_tokens, top_p, reasoning, stream, json_mode, chunk_first_turn_by_punctuation, gemini_use_custom_prompt } = req.body;

    if (!goal || !to_number) {
      return res.status(400).json({ error: 'Missing required fields: goal and to_number' });
    }

    // System prompt is required for calls
    if (!custom_system_prompt) {
      return res.status(400).json({ error: 'Missing required field: custom_system_prompt' });
    }

    // Extract user ID from NextAuth session
    // session.user.id is set in the jwt callback of [...nextauth].ts
    const userId = (session.user as any).id;
    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in session' });
    }

    // Fetch custom assistant name and first name from profile
    let customAssistantName = null;
    let firstName = null;
    if (supabaseUrl && supabaseServiceKey) {
      try {
        const supabase = createClient(supabaseUrl, supabaseServiceKey);
        const { data, error } = await supabase
          .from('profiles')
          .select('custom_assistant_name, first_name')
          .eq('user_id', userId)
          .single();

        if (!error && data) {
          customAssistantName = data.custom_assistant_name;
          firstName = data.first_name;
        }
      } catch (error) {
        console.error('Error fetching profile data:', error);
      }
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
        systemPrompt: custom_system_prompt,
        rollingSummaryPrompt: rolling_summary_prompt,
        // TTS settings
        ttsVoiceId: tts_voice_id,
        // Call control settings
        ttsDebounceMs: tts_debounce_ms,
        bargeInCooldownMs: barge_in_cooldown_ms,
        callerUtteranceFlushMs: caller_utterance_flush_ms,
        holdCheckInIntervalMs: hold_check_in_interval_ms,
        holdMaxCheckIns: hold_max_check_ins,
        // IVR/Phone Tree settings
        ivrDebounceMs: ivr_debounce_ms,
        ivrUtteranceFlushMs: ivr_utterance_flush_ms,
        ivrDtmfMinPauseMs: ivr_dtmf_min_pause_ms,
        ivrDtmfDurationMs: ivr_dtmf_duration_ms,
        ivrAutoDetectThreshold: ivr_auto_detect_threshold,
        ivrResponseTimeoutMs: ivr_response_timeout_ms,
        ivrMaxDtmfRetries: ivr_max_dtmf_retries,
        ivrDisableBargeInGracePeriod: ivr_disable_barge_in_grace_period,
        // Human Detection settings (IVR vs Human state machine)
        humanDetectionEnabled: human_detection_enabled,
        humanDetectionUtteranceFlushMs: human_detection_utterance_flush_ms,
        humanDetectionHumanWaitMs: human_detection_human_wait_ms,
        humanDetectionIvrWaitMs: human_detection_ivr_wait_ms,
        humanDetectionMinUtterances: human_detection_min_utterances,
        humanDetectionHoldSilenceMs: human_detection_hold_silence_ms,
        humanDetectionHumanTurnsAfterHold: human_detection_human_turns_after_hold,
        humanDetectionMaxUnsure: human_detection_max_unsure,
        humanDetectionClassificationModel: human_detection_classification_model,
        humanDetectionClassificationPrompt: human_detection_classification_prompt,
        // Music Detection settings (Energy Floor)
        musicDetectionEnabled: music_detection_enabled,
        musicDetectionWindowSize: music_detection_window_size,
        musicDetectionMusicThreshold: music_detection_music_threshold,
        musicDetectionSilenceThreshold: music_detection_silence_threshold,
        musicDetectionHysteresisMs: music_detection_hysteresis_ms,
        musicDetectionAuditLogging: music_detection_audit_logging,
        musicDetectionUseTranscriptPatterns: music_detection_use_transcript_patterns,
        // Diarization settings (Speaker Change Detection)
        diarizationEnabled: diarization_enabled,
        diarizationDebounceMs: diarization_debounce_ms,
        diarizationMinConfidence: diarization_min_confidence,
        diarizationAuditLogging: diarization_audit_logging,
        // LLM settings
        model: model,
        temperature: temperature,
        maxTokens: max_tokens,
        topP: top_p,
        reasoning: reasoning,
        stream: stream,
        jsonMode: json_mode,
        chunkFirstTurnByPunctuation: chunk_first_turn_by_punctuation,
        // Gemini custom prompt mode - bypass cache and use custom system prompt
        geminiUseCustomPrompt: gemini_use_custom_prompt,
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
