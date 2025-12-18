import express, { Router, Request, Response } from "express";
import axios from "axios";
import config from "../config";
import { upsertCall, isSupabaseConfigured } from "../utils/supabase";

const router = Router();

interface OutboundCallRequest {
  goal: string;
  additionalContext?: string;
  toNumber: string;
  userId: string;
  assistantName?: string;
  userName?: string;
  systemPrompt?: string;
  rollingSummaryPrompt?: string;
  // TTS settings
  ttsVoiceId?: string; // Custom Telnyx TTS voice ID (e.g., "Telnyx.KokoroTTS.bm_george")
  // Call control settings
  ttsDebounceMs?: number;
  bargeInCooldownMs?: number;
  callerUtteranceFlushMs?: number;
  holdCheckInIntervalMs?: number;
  holdMaxCheckIns?: number;
  // IVR/Phone Tree settings
  ivrDebounceMs?: number;
  ivrUtteranceFlushMs?: number;
  ivrDtmfMinPauseMs?: number;
  ivrDtmfDurationMs?: number;
  ivrAutoDetectThreshold?: number;
  ivrResponseTimeoutMs?: number;
  ivrMaxDtmfRetries?: number;
  ivrDisableBargeInGracePeriod?: boolean;
  // Human Detection settings (IVR vs Human state machine)
  humanDetectionEnabled?: boolean;
  humanDetectionUtteranceFlushMs?: number;
  humanDetectionHumanWaitMs?: number;
  humanDetectionIvrWaitMs?: number;
  humanDetectionMinUtterances?: number;
  humanDetectionHoldSilenceMs?: number;
  humanDetectionHumanTurnsAfterHold?: number;
  humanDetectionMaxUnsure?: number;
  humanDetectionClassificationModel?: string;
  humanDetectionClassificationPrompt?: string;
  // Music Detection settings (Energy Floor)
  musicDetectionEnabled?: boolean;
  musicDetectionWindowSize?: number;
  musicDetectionMusicThreshold?: number;
  musicDetectionSilenceThreshold?: number;
  musicDetectionHysteresisMs?: number;
  musicDetectionAuditLogging?: boolean;
  musicDetectionUseTranscriptPatterns?: boolean;
  // Diarization settings (Speaker Change Detection)
  diarizationEnabled?: boolean;
  diarizationDebounceMs?: number;
  diarizationMinConfidence?: number;
  diarizationAuditLogging?: boolean;
  // LLM settings
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  reasoning?: 'low' | 'medium' | 'high';
  stream?: boolean;
  jsonMode?: boolean;
  chunkFirstTurnByPunctuation?: boolean;
}

interface TelnyxCallResponse {
  data: {
    call_control_id?: string;
    call_session_id?: string;
    call_leg_id?: string;
    [key: string]: any;
  };
}

/**
 * POST /api/outbound-call
 * Initiates an outbound call via Telnyx Call Control API
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const { goal, additionalContext, toNumber, userId, assistantName, userName, systemPrompt, rollingSummaryPrompt, ttsVoiceId, ttsDebounceMs, bargeInCooldownMs, callerUtteranceFlushMs, holdCheckInIntervalMs, holdMaxCheckIns, ivrDebounceMs, ivrUtteranceFlushMs, ivrDtmfMinPauseMs, ivrDtmfDurationMs, ivrAutoDetectThreshold, ivrResponseTimeoutMs, ivrMaxDtmfRetries, ivrDisableBargeInGracePeriod, humanDetectionEnabled, humanDetectionUtteranceFlushMs, humanDetectionHumanWaitMs, humanDetectionIvrWaitMs, humanDetectionMinUtterances, humanDetectionHoldSilenceMs, humanDetectionHumanTurnsAfterHold, humanDetectionMaxUnsure, humanDetectionClassificationModel, humanDetectionClassificationPrompt, musicDetectionEnabled, musicDetectionWindowSize, musicDetectionMusicThreshold, musicDetectionSilenceThreshold, musicDetectionHysteresisMs, musicDetectionAuditLogging, musicDetectionUseTranscriptPatterns, diarizationEnabled, diarizationDebounceMs, diarizationMinConfidence, diarizationAuditLogging, model, temperature, maxTokens, topP, reasoning, stream, jsonMode, chunkFirstTurnByPunctuation } = req.body as OutboundCallRequest;

    // Validate required fields
    if (!goal || !toNumber || !userId) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: goal, toNumber, userId",
      });
    }

    // System prompt is required
    if (!systemPrompt) {
      return res.status(400).json({
        status: "error",
        message: "Missing required field: systemPrompt",
      });
    }

    // Encode client state (goal + userId + assistantName + userName + systemPrompt + additionalContext + rollingSummaryPrompt + call control settings + IVR settings + human detection settings + model + LLM params) in base64
    const clientStatePayload = JSON.stringify({
      goal,
      additionalContext: additionalContext || null,
      userId,
      assistantName: assistantName || null,
      userName: userName || null,
      systemPrompt: systemPrompt,
      rollingSummaryPrompt: rollingSummaryPrompt || null,
      // TTS settings
      ttsVoiceId: ttsVoiceId || null,
      // Call control settings
      ttsDebounceMs: ttsDebounceMs || null,
      bargeInCooldownMs: bargeInCooldownMs || null,
      callerUtteranceFlushMs: callerUtteranceFlushMs || null,
      holdCheckInIntervalMs: holdCheckInIntervalMs || null,
      holdMaxCheckIns: holdMaxCheckIns || null,
      // IVR/Phone Tree settings
      ivrDebounceMs: ivrDebounceMs || null,
      ivrUtteranceFlushMs: ivrUtteranceFlushMs || null,
      ivrDtmfMinPauseMs: ivrDtmfMinPauseMs || null,
      ivrDtmfDurationMs: ivrDtmfDurationMs || null,
      ivrAutoDetectThreshold: ivrAutoDetectThreshold || null,
      ivrResponseTimeoutMs: ivrResponseTimeoutMs || null,
      ivrMaxDtmfRetries: ivrMaxDtmfRetries || null,
      ivrDisableBargeInGracePeriod: ivrDisableBargeInGracePeriod ?? null,
      // Human Detection settings (IVR vs Human state machine)
      humanDetectionEnabled: humanDetectionEnabled ?? null,
      humanDetectionUtteranceFlushMs: humanDetectionUtteranceFlushMs || null,
      humanDetectionHumanWaitMs: humanDetectionHumanWaitMs || null,
      humanDetectionIvrWaitMs: humanDetectionIvrWaitMs || null,
      humanDetectionMinUtterances: humanDetectionMinUtterances || null,
      humanDetectionHoldSilenceMs: humanDetectionHoldSilenceMs || null,
      humanDetectionHumanTurnsAfterHold: humanDetectionHumanTurnsAfterHold || null,
      humanDetectionMaxUnsure: humanDetectionMaxUnsure || null,
      humanDetectionClassificationModel: humanDetectionClassificationModel || null,
      humanDetectionClassificationPrompt: humanDetectionClassificationPrompt || null,
      // Music Detection settings (Energy Floor)
      musicDetectionEnabled: musicDetectionEnabled ?? null,
      musicDetectionWindowSize: musicDetectionWindowSize || null,
      musicDetectionMusicThreshold: musicDetectionMusicThreshold || null,
      musicDetectionSilenceThreshold: musicDetectionSilenceThreshold || null,
      musicDetectionHysteresisMs: musicDetectionHysteresisMs || null,
      musicDetectionAuditLogging: musicDetectionAuditLogging ?? null,
      musicDetectionUseTranscriptPatterns: musicDetectionUseTranscriptPatterns ?? null,
      // Diarization settings (Speaker Change Detection)
      diarizationEnabled: diarizationEnabled ?? null,
      diarizationDebounceMs: diarizationDebounceMs || null,
      diarizationMinConfidence: diarizationMinConfidence || null,
      diarizationAuditLogging: diarizationAuditLogging ?? null,
      // LLM settings
      model: model || null,
      temperature: temperature || null,
      maxTokens: maxTokens || null,
      topP: topP || null,
      reasoning: reasoning || null,
      stream: stream || null,
      jsonMode: jsonMode || null,
      chunkFirstTurnByPunctuation: chunkFirstTurnByPunctuation ?? null,
    });
    const clientStateBase64 = Buffer.from(clientStatePayload).toString("base64");

    // Call Telnyx Call Control API
    const telnyxResponse = await axios.post<TelnyxCallResponse>(
      "https://api.telnyx.com/v2/calls",
      {
        connection_id: config.telnyx.sipConnectionId,
        to: toNumber,
        from: config.telnyx.fromNumber,
        client_state: clientStateBase64,
        // Telnyx recording disabled - using custom recording pipeline instead
      },
      {
        headers: {
          Authorization: `Bearer ${config.telnyx.apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Extract call IDs from Telnyx response (matching Cloudflare worker pattern)
    const responseData = telnyxResponse.data.data;
    const callSessionId = responseData?.call_session_id || null;
    const callControlId = responseData?.call_control_id || null;

    // Use call_control_id as primary ID (consistent with webhooks)
    const primaryId = callControlId || callSessionId;

    if (!primaryId) {
      console.error("❌ Telnyx response missing call identifiers:", responseData);
      return res.status(500).json({
        status: "error",
        message: "Telnyx response missing call_control_id",
      });
    }

    const timestamp = new Date().toISOString();

    // Log call to Supabase
    if (isSupabaseConfigured()) {
      const result = await upsertCall({
        id: primaryId,
        user_id: userId,
        direction: "outbound",
        from_e164: config.telnyx.fromNumber,
        to_e164: toNumber,
        status: "initiated",
        goal: goal,
        started_at: timestamp,
        metadata: {
          call_control_id: callControlId,
          call_session_id: callSessionId,
          initiated_by: "ai-server",
        },
      });

      if (result.success) {
        console.log("📊 Call logged to Supabase:", primaryId);
      } else {
        console.error("❌ Failed to log call to Supabase:", result.error);
      }
    }

    return res.status(200).json({
      status: "outbound_call_created",
      call_control_id: callControlId,
      call_session_id: callSessionId,
    });
  } catch (error: any) {
    console.error("❌ Outbound call error:", error);

    if (axios.isAxiosError(error)) {
      return res.status(error.response?.status || 500).json({
        status: "error",
        message: error.response?.data?.errors?.[0]?.detail || error.message,
      });
    }

    return res.status(500).json({
      status: "error",
      message: "Failed to create outbound call",
    });
  }
});

export default router;
