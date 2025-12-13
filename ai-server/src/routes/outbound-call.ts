import express, { Router, Request, Response } from "express";
import axios from "axios";
import config from "../config";
import { upsertCall, isSupabaseConfigured } from "../utils/supabase";

// Log the stream URL at startup for debugging
console.log(`[Outbound Call] Stream URL configured: ${config.telnyx.streamUrl}`);

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
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  reasoning?: 'low' | 'medium' | 'high';
  stream?: boolean;
  jsonMode?: boolean;
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
    const { goal, additionalContext, toNumber, userId, assistantName, userName, systemPrompt, rollingSummaryPrompt, ttsDebounceMs, bargeInCooldownMs, callerUtteranceFlushMs, holdCheckInIntervalMs, holdMaxCheckIns, ivrDebounceMs, ivrUtteranceFlushMs, ivrDtmfMinPauseMs, ivrDtmfDurationMs, ivrAutoDetectThreshold, ivrResponseTimeoutMs, ivrMaxDtmfRetries, ivrDisableBargeInGracePeriod, model, temperature, maxTokens, topP, reasoning, stream, jsonMode } = req.body as OutboundCallRequest;

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

    // Encode client state (goal + userId + assistantName + userName + systemPrompt + additionalContext + rollingSummaryPrompt + call control settings + IVR settings + model + LLM params) in base64
    const clientStatePayload = JSON.stringify({
      goal,
      additionalContext: additionalContext || null,
      userId,
      assistantName: assistantName || null,
      userName: userName || null,
      systemPrompt: systemPrompt,
      rollingSummaryPrompt: rollingSummaryPrompt || null,
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
      model: model || null,
      temperature: temperature || null,
      maxTokens: maxTokens || null,
      topP: topP || null,
      reasoning: reasoning || null,
      stream: stream || null,
      jsonMode: jsonMode || null,
    });
    const clientStateBase64 = Buffer.from(clientStatePayload).toString("base64");

    // Call Telnyx Call Control API
    // IMPORTANT: Include stream_url at call creation for instant streaming when call connects
    // This eliminates the delay of waiting for call.answered webhook then calling streaming_start
    const telnyxResponse = await axios.post<TelnyxCallResponse>(
      "https://api.telnyx.com/v2/calls",
      {
        connection_id: config.telnyx.sipConnectionId,
        to: toNumber,
        from: config.telnyx.fromNumber,
        client_state: clientStateBase64,
        // Enable streaming at call creation for instant audio when call connects
        stream_url: config.telnyx.streamUrl,
        stream_track: "both_tracks",
        stream_bidirectional_mode: "rtp",
        // Telnyx recording disabled - using custom recording pipeline instead
      },
      {
        headers: {
          Authorization: `Bearer ${config.telnyx.apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`[Outbound Call] ✅ Call created with instant streaming to ${config.telnyx.streamUrl}`);

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
