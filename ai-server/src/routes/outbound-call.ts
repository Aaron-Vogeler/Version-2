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

  // =============================================================================
  // CALL CONTROL SETTINGS (TTS & Response Timing)
  // =============================================================================
  ttsDebounceMs?: number;           // Silence before AI responds (default: 500ms)
  bargeInCooldownMs?: number;       // Time between stop commands (default: 300ms)
  bargeInGracePeriodMs?: number;    // Delay before enabling barge-in (default: 800ms)
  callerUtteranceFlushMs?: number;  // Wait before flushing utterance (default: 300ms)
  hangupDelayMs?: number;           // Wait for TTS before hangup (default: 2000ms)

  // =============================================================================
  // HOLD SETTINGS
  // =============================================================================
  holdCheckInIntervalMs?: number;   // Time between AI check-ins while on hold (default: 30000ms)
  holdMaxCheckIns?: number;         // Max check-ins before ending call (default: 5)

  // =============================================================================
  // IVR/PHONE TREE SETTINGS
  // =============================================================================
  ivrDebounceMs?: number;                  // Silence before responding to IVR (default: 150ms)
  ivrUtteranceFlushMs?: number;            // Quick utterance finalization (default: 200ms)
  ivrDtmfMinPauseMs?: number;              // Min pause between DTMF sends (default: 500ms)
  ivrDtmfDurationMs?: number;              // Duration of each DTMF tone (default: 250ms)
  ivrAutoDetectThreshold?: number;         // Confidence threshold for IVR mode (default: 0.7)
  ivrResponseTimeoutMs?: number;           // Wait time before retry (default: 8000ms)
  ivrMaxDtmfRetries?: number;              // Max retries for same option (default: 2)
  ivrDisableBargeInGracePeriod?: boolean;  // Skip grace period for IVRs (default: true)

  // =============================================================================
  // LLM PARAMETERS
  // =============================================================================
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  reasoning?: 'low' | 'medium' | 'high';
  stream?: boolean;
  jsonMode?: boolean;

  // =============================================================================
  // CONTEXT MANAGEMENT SETTINGS
  // =============================================================================
  maxTurnsInWindow?: number;           // Recent turns to keep (default: 12)
  summaryUpdateIntervalTurns?: number; // Turns before updating summary (default: 6)
  maxSummaryTokensHint?: number;       // Token limit for summaries (default: 300)

  // =============================================================================
  // PARTY DETECTION SETTINGS (Human vs IVR)
  // =============================================================================
  partyDetectionEnabled?: boolean;           // Enable auto party detection (default: true)
  partyDetectionTemperature?: number;        // LLM temperature for detection (default: 0.1)
  partyDetectionMaxTokens?: number;          // Max tokens for detection (default: 10)
  partyDetectionSystemPrompt?: string;       // Custom detection prompt
  partyDetectionMinTranscriptLength?: number; // Min chars before detection (default: 20)

  // =============================================================================
  // AUDIO PROCESSING SETTINGS
  // =============================================================================
  audioSilenceThreshold?: number;       // PCM amplitude for silence (default: 3000)
  audioHysteresisPackets?: number;      // Packets to confirm state change (default: 8)
  audioDiscontinuityThreshold?: number; // Sample jump to trigger smoothing (default: 25000)
  audioFadeSamples?: number;            // Fade length for discontinuities (default: 16)
  audioSilenceFadeSamples?: number;     // Fade length for silence transitions (default: 32)

  // =============================================================================
  // SPEECH ESTIMATION SETTINGS
  // =============================================================================
  speechWordsPerSecond?: number;        // Speaking rate for barge-in (default: 2.5)
  speechMinMeaningfulDuration?: number; // Min duration for meaningful speech (default: 0.5)

  // =============================================================================
  // TRANSCRIPT SETTINGS
  // =============================================================================
  deepgramEndpointing?: number;    // End-of-speech detection ms (default: 100)
  transcriptAppendSegments?: boolean; // Append vs replace segments (default: true)

  // =============================================================================
  // TTS/VOICE SETTINGS
  // =============================================================================
  ttsVoiceId?: string;             // Telnyx TTS voice (default: Telnyx.KokoroTTS.bm_george)

  // =============================================================================
  // STT/DEEPGRAM SETTINGS
  // =============================================================================
  deepgramModel?: string;          // Deepgram model (default: nova-2)

  // =============================================================================
  // RECORDING SETTINGS
  // =============================================================================
  customRecordingEnabled?: boolean;  // Enable self-hosted recording (default: true)
  customRecordingMaxBytes?: number;  // Max recording buffer size (default: 50MB)

  // =============================================================================
  // ROLLING SUMMARY SETTINGS
  // =============================================================================
  rollingSummarySystemMessage?: string; // System message for summary generation
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
    const {
      // Required fields
      goal, additionalContext, toNumber, userId, assistantName, userName, systemPrompt, rollingSummaryPrompt,
      // Call control settings
      ttsDebounceMs, bargeInCooldownMs, bargeInGracePeriodMs, callerUtteranceFlushMs, hangupDelayMs,
      // Hold settings
      holdCheckInIntervalMs, holdMaxCheckIns,
      // IVR settings
      ivrDebounceMs, ivrUtteranceFlushMs, ivrDtmfMinPauseMs, ivrDtmfDurationMs, ivrAutoDetectThreshold,
      ivrResponseTimeoutMs, ivrMaxDtmfRetries, ivrDisableBargeInGracePeriod,
      // LLM parameters
      model, temperature, maxTokens, topP, reasoning, stream, jsonMode,
      // Context management
      maxTurnsInWindow, summaryUpdateIntervalTurns, maxSummaryTokensHint,
      // Party detection
      partyDetectionEnabled, partyDetectionTemperature, partyDetectionMaxTokens, partyDetectionSystemPrompt, partyDetectionMinTranscriptLength,
      // Audio processing
      audioSilenceThreshold, audioHysteresisPackets, audioDiscontinuityThreshold, audioFadeSamples, audioSilenceFadeSamples,
      // Speech estimation
      speechWordsPerSecond, speechMinMeaningfulDuration,
      // Transcript settings
      deepgramEndpointing, transcriptAppendSegments,
      // TTS/Voice settings
      ttsVoiceId,
      // STT/Deepgram settings
      deepgramModel,
      // Recording settings
      customRecordingEnabled, customRecordingMaxBytes,
      // Rolling summary settings
      rollingSummarySystemMessage,
    } = req.body as OutboundCallRequest;

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

    // Encode all call settings in client state for retrieval during call handling
    const clientStatePayload = JSON.stringify({
      // Basic call info
      goal,
      additionalContext: additionalContext || null,
      userId,
      assistantName: assistantName || null,
      userName: userName || null,
      systemPrompt: systemPrompt,
      rollingSummaryPrompt: rollingSummaryPrompt || null,

      // Call control settings (TTS & Response Timing)
      ttsDebounceMs: ttsDebounceMs ?? null,
      bargeInCooldownMs: bargeInCooldownMs ?? null,
      bargeInGracePeriodMs: bargeInGracePeriodMs ?? null,
      callerUtteranceFlushMs: callerUtteranceFlushMs ?? null,
      hangupDelayMs: hangupDelayMs ?? null,

      // Hold settings
      holdCheckInIntervalMs: holdCheckInIntervalMs ?? null,
      holdMaxCheckIns: holdMaxCheckIns ?? null,

      // IVR/Phone Tree settings
      ivrDebounceMs: ivrDebounceMs ?? null,
      ivrUtteranceFlushMs: ivrUtteranceFlushMs ?? null,
      ivrDtmfMinPauseMs: ivrDtmfMinPauseMs ?? null,
      ivrDtmfDurationMs: ivrDtmfDurationMs ?? null,
      ivrAutoDetectThreshold: ivrAutoDetectThreshold ?? null,
      ivrResponseTimeoutMs: ivrResponseTimeoutMs ?? null,
      ivrMaxDtmfRetries: ivrMaxDtmfRetries ?? null,
      ivrDisableBargeInGracePeriod: ivrDisableBargeInGracePeriod ?? null,

      // LLM parameters
      model: model || null,
      temperature: temperature ?? null,
      maxTokens: maxTokens ?? null,
      topP: topP ?? null,
      reasoning: reasoning || null,
      stream: stream ?? null,
      jsonMode: jsonMode ?? null,

      // Context management settings
      maxTurnsInWindow: maxTurnsInWindow ?? null,
      summaryUpdateIntervalTurns: summaryUpdateIntervalTurns ?? null,
      maxSummaryTokensHint: maxSummaryTokensHint ?? null,

      // Party detection settings (Human vs IVR)
      partyDetectionEnabled: partyDetectionEnabled ?? null,
      partyDetectionTemperature: partyDetectionTemperature ?? null,
      partyDetectionMaxTokens: partyDetectionMaxTokens ?? null,
      partyDetectionSystemPrompt: partyDetectionSystemPrompt || null,
      partyDetectionMinTranscriptLength: partyDetectionMinTranscriptLength ?? null,

      // Audio processing settings
      audioSilenceThreshold: audioSilenceThreshold ?? null,
      audioHysteresisPackets: audioHysteresisPackets ?? null,
      audioDiscontinuityThreshold: audioDiscontinuityThreshold ?? null,
      audioFadeSamples: audioFadeSamples ?? null,
      audioSilenceFadeSamples: audioSilenceFadeSamples ?? null,

      // Speech estimation settings
      speechWordsPerSecond: speechWordsPerSecond ?? null,
      speechMinMeaningfulDuration: speechMinMeaningfulDuration ?? null,

      // Transcript settings
      deepgramEndpointing: deepgramEndpointing ?? null,
      transcriptAppendSegments: transcriptAppendSegments ?? null,

      // TTS/Voice settings
      ttsVoiceId: ttsVoiceId || null,

      // STT/Deepgram settings
      deepgramModel: deepgramModel || null,

      // Recording settings
      customRecordingEnabled: customRecordingEnabled ?? null,
      customRecordingMaxBytes: customRecordingMaxBytes ?? null,

      // Rolling summary settings
      rollingSummarySystemMessage: rollingSummarySystemMessage || null,
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
