import express, { Router, Request, Response } from "express";
import axios from "axios";
import config from "../config";
import { upsertCall, isSupabaseConfigured } from "../utils/supabase";

const router = Router();

interface OutboundCallRequest {
  goal: string;
  toNumber: string;
  userId: string;
}

interface TelnyxCallResponse {
  data: {
    id: string;
    [key: string]: any;
  };
}

/**
 * POST /api/outbound-call
 * Initiates an outbound call via Telnyx Call Control API
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const { goal, toNumber, userId } = req.body as OutboundCallRequest;

    // Validate required fields
    if (!goal || !toNumber || !userId) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: goal, toNumber, userId",
      });
    }

    // Encode client state (goal + userId) in base64
    const clientStatePayload = JSON.stringify({ goal, userId });
    const clientStateBase64 = Buffer.from(clientStatePayload).toString("base64");

    // Call Telnyx Call Control API
    const telnyxResponse = await axios.post<TelnyxCallResponse>(
      "https://api.telnyx.com/v2/calls",
      {
        connection_id: config.telnyx.sipConnectionId,
        to: toNumber,
        from: config.telnyx.fromNumber,
        client_state: clientStateBase64,
      },
      {
        headers: {
          Authorization: `Bearer ${config.telnyx.apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Extract call_control_id from Telnyx response
    const callControlId = telnyxResponse.data.data.id;
    const timestamp = new Date().toISOString();

    // Log call to Supabase
    if (isSupabaseConfigured()) {
      await upsertCall({
        id: callControlId,
        user_id: userId,
        direction: "outbound",
        from_e164: config.telnyx.fromNumber,
        to_e164: toNumber,
        status: "initiated",
        goal: goal,
        started_at: timestamp,
        metadata: {
          initiated_by: "ai-server",
        },
      });
      console.log("📊 Call logged to Supabase:", callControlId);
    }

    return res.status(200).json({
      status: "outbound_call_created",
      call_control_id: callControlId,
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
