import express, { Router, Request, Response } from "express";
import axios from "axios";
import config from "../config";
import { upsertCall, isSupabaseConfigured } from "../utils/supabase";

const router = Router();

/**
 * Per-call AI configuration (mirrors frontend AIConfig)
 */
interface AIConfig {
  systemPrompt?: string;
  summaryPrompt?: string;
  maxTurnsInWindow?: number;
  summaryUpdateInterval?: number;
  silenceTimeoutMs?: number;
}

interface OutboundCallRequest {
  goal: string;
  toNumber: string;
  userId: string;
  assistantName?: string;
  userName?: string;
  aiConfig?: AIConfig;
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
    const { goal, toNumber, userId, assistantName, userName, aiConfig } = req.body as OutboundCallRequest;

    // Validate required fields
    if (!goal || !toNumber || !userId) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: goal, toNumber, userId",
      });
    }

    // Build client state payload with minimal JSON (only include non-null values)
    // This keeps the base64 encoded state within Telnyx size limits
    const clientStateObj: Record<string, any> = {
      goal,
      userId,
    };

    // Only include optional fields if they have values
    if (assistantName) clientStateObj.assistantName = assistantName;
    if (userName) clientStateObj.userName = userName;

    // Include aiConfig if provided (minified to save space)
    if (aiConfig && Object.keys(aiConfig).length > 0) {
      clientStateObj.aiConfig = aiConfig;
    }

    const clientStatePayload = JSON.stringify(clientStateObj);
    const clientStateBase64 = Buffer.from(clientStatePayload).toString("base64");

    // Log client_state size for monitoring (Telnyx has a ~1000 char limit for client_state)
    console.log(`📊 client_state size: ${clientStateBase64.length} chars`);

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
