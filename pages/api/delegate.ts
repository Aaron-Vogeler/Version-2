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
    const { goal, context, to_number, custom_system_prompt, rolling_summary_prompt, tts_debounce_ms, barge_in_cooldown_ms, caller_utterance_flush_ms, hold_check_in_interval_ms, hold_max_check_ins, ivr_debounce_ms, ivr_utterance_flush_ms, ivr_dtmf_min_pause_ms, ivr_dtmf_duration_ms, ivr_auto_detect_threshold, ivr_response_timeout_ms, ivr_max_dtmf_retries, ivr_disable_barge_in_grace_period, human_detection_enabled, human_detection_utterance_flush_ms, human_detection_human_wait_ms, human_detection_ivr_wait_ms, human_detection_min_utterances, human_detection_min_transcript_length, human_detection_hold_silence_ms, human_detection_human_turns_after_hold, human_detection_max_unsure, model, temperature, max_tokens, top_p, reasoning, stream, json_mode } = req.body;

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
        humanDetectionMinTranscriptLength: human_detection_min_transcript_length,
        humanDetectionHoldSilenceMs: human_detection_hold_silence_ms,
        humanDetectionHumanTurnsAfterHold: human_detection_human_turns_after_hold,
        humanDetectionMaxUnsure: human_detection_max_unsure,
        // LLM settings
        model: model,
        temperature: temperature,
        maxTokens: max_tokens,
        topP: top_p,
        reasoning: reasoning,
        stream: stream,
        jsonMode: json_mode,
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
