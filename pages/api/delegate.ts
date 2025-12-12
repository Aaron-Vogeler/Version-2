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
    // Validate request body - extract all call control parameters
    const {
      // Basic call info
      goal, context, to_number, custom_system_prompt, rolling_summary_prompt,
      // Call control settings (TTS & Response Timing)
      tts_debounce_ms, barge_in_cooldown_ms, barge_in_grace_period_ms, caller_utterance_flush_ms, hangup_delay_ms,
      // Hold settings
      hold_check_in_interval_ms, hold_max_check_ins,
      // IVR settings
      ivr_debounce_ms, ivr_utterance_flush_ms, ivr_dtmf_min_pause_ms, ivr_dtmf_duration_ms,
      ivr_auto_detect_threshold, ivr_response_timeout_ms, ivr_max_dtmf_retries, ivr_disable_barge_in_grace_period,
      // LLM parameters
      model, temperature, max_tokens, top_p, reasoning, stream, json_mode,
      // Context management
      max_turns_in_window, summary_update_interval_turns, max_summary_tokens_hint,
      // Party detection settings
      party_detection_enabled, party_detection_temperature, party_detection_max_tokens,
      party_detection_system_prompt, party_detection_min_transcript_length,
      // Audio processing settings
      audio_silence_threshold, audio_hysteresis_packets, audio_discontinuity_threshold,
      audio_fade_samples, audio_silence_fade_samples,
      // Speech estimation settings
      speech_words_per_second, speech_min_meaningful_duration,
      // Transcript settings
      deepgram_endpointing, transcript_append_segments, deepgram_vad_events, deepgram_interim_results,
      // Audio normalization settings
      audio_norm_target_peak, audio_norm_min_threshold, audio_norm_max_gain, audio_soft_clip_threshold,
      audio_soft_clip_factor, audio_pre_mulaw_min_peak, audio_pre_mulaw_target_peak,
      // Downsampling filter settings
      downsample_cutoff_hz, downsample_num_taps,
      // TTS/Voice settings
      tts_voice_id,
      // STT/Deepgram settings
      deepgram_model,
      // Recording settings
      custom_recording_enabled, custom_recording_max_bytes,
      // Rolling summary settings
      rolling_summary_system_message, rolling_summary_temperature,
    } = req.body;

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
        // Basic call info
        goal,
        additionalContext: context,
        toNumber: to_number,
        userId,
        assistantName: customAssistantName,
        userName: firstName,
        systemPrompt: custom_system_prompt,
        rollingSummaryPrompt: rolling_summary_prompt,

        // Call control settings (TTS & Response Timing)
        ttsDebounceMs: tts_debounce_ms,
        bargeInCooldownMs: barge_in_cooldown_ms,
        bargeInGracePeriodMs: barge_in_grace_period_ms,
        callerUtteranceFlushMs: caller_utterance_flush_ms,
        hangupDelayMs: hangup_delay_ms,

        // Hold settings
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

        // LLM parameters
        model,
        temperature,
        maxTokens: max_tokens,
        topP: top_p,
        reasoning,
        stream,
        jsonMode: json_mode,

        // Context management settings
        maxTurnsInWindow: max_turns_in_window,
        summaryUpdateIntervalTurns: summary_update_interval_turns,
        maxSummaryTokensHint: max_summary_tokens_hint,

        // Party detection settings
        partyDetectionEnabled: party_detection_enabled,
        partyDetectionTemperature: party_detection_temperature,
        partyDetectionMaxTokens: party_detection_max_tokens,
        partyDetectionSystemPrompt: party_detection_system_prompt,
        partyDetectionMinTranscriptLength: party_detection_min_transcript_length,

        // Audio processing settings
        audioSilenceThreshold: audio_silence_threshold,
        audioHysteresisPackets: audio_hysteresis_packets,
        audioDiscontinuityThreshold: audio_discontinuity_threshold,
        audioFadeSamples: audio_fade_samples,
        audioSilenceFadeSamples: audio_silence_fade_samples,

        // Speech estimation settings
        speechWordsPerSecond: speech_words_per_second,
        speechMinMeaningfulDuration: speech_min_meaningful_duration,

        // Transcript settings
        deepgramEndpointing: deepgram_endpointing,
        transcriptAppendSegments: transcript_append_segments,
        deepgramVadEvents: deepgram_vad_events,
        deepgramInterimResults: deepgram_interim_results,

        // Audio normalization settings
        audioNormTargetPeak: audio_norm_target_peak,
        audioNormMinThreshold: audio_norm_min_threshold,
        audioNormMaxGain: audio_norm_max_gain,
        audioSoftClipThreshold: audio_soft_clip_threshold,
        audioSoftClipFactor: audio_soft_clip_factor,
        audioPreMulawMinPeak: audio_pre_mulaw_min_peak,
        audioPreMulawTargetPeak: audio_pre_mulaw_target_peak,

        // Downsampling filter settings
        downsampleCutoffHz: downsample_cutoff_hz,
        downsampleNumTaps: downsample_num_taps,

        // TTS/Voice settings
        ttsVoiceId: tts_voice_id,

        // STT/Deepgram settings
        deepgramModel: deepgram_model,

        // Recording settings
        customRecordingEnabled: custom_recording_enabled,
        customRecordingMaxBytes: custom_recording_max_bytes,

        // Rolling summary settings
        rollingSummarySystemMessage: rolling_summary_system_message,
        rollingSummaryTemperature: rolling_summary_temperature,
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
