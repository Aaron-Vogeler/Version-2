import express from "express";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import axios from "axios";
import config from "./config";
import outboundCallRouter from "./routes/outbound-call";
import { downsample24kHzTo8kHz, pcmToMulaw, chunkAudio, normalizePcm, boostBeforeMulaw } from "./pipeline/audio";
import { createDeepgramClient } from "./pipeline/stt";
import { generateAssistantReply, type CallContext, maybeUpdateSummaryForCall } from "./pipeline/llm";
import { synthesizeSpeech, stopSpeaking, hangupCall } from "./pipeline/tts";
import * as contextMgr from "./callContextManager";

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

// Debounce timing configuration for different scenarios
const DEBOUNCE_CONFIG = {
  NORMAL: 800,           // 800ms: Normal pause between utterances
  POST_INTERRUPT: 200,   // 200ms: Faster response after interrupting AI
};

// TTS playback tracking from Telnyx webhooks
interface TtsPlaybackState {
  startedAt: number;     // Timestamp when webhook said playback started
  callControlId: string;
  commandId?: string;    // Optional command_id from Telnyx for targeted stops
  timeoutId?: NodeJS.Timeout; // Fallback timeout for missing webhooks
}

// Global map to track actual TTS playback state per call (from Telnyx webhooks)
// Maps callControlId -> TtsPlaybackState
const activeTtsPlayback = new Map<string, TtsPlaybackState>();

// Webhook deduplication to prevent processing the same event twice
const processedWebhooks = new Map<string, number>();  // webhook_id -> timestamp
const WEBHOOK_DEDUP_TTL_MS = 60000;  // Keep dedup records for 1 minute
const TTS_WEBHOOK_TIMEOUT_MS = 10000; // 10 seconds to receive call.speak.started

// Deepgram connection health tracking
let deepgramLastActivity = Date.now();
const DEEPGRAM_INACTIVITY_THRESHOLD_MS = 30000;

// Stale TTS state cleanup interval
const TTS_STALE_CLEANUP_INTERVAL_MS = 60000; // Run cleanup every minute
const TTS_STALE_THRESHOLD_MS = 120000; // Consider state stale after 2 minutes

// ============================================================================
// CLIENTS
// ============================================================================

const deepgram = createDeepgramClient();

// ============================================================================
// HELPER FUNCTIONS - Webhook Management
// ============================================================================

/**
 * Check if a webhook has already been processed (deduplication).
 * Returns true if this webhook was already processed recently.
 */
function isWebhookDuplicate(webhookId: string | undefined): boolean {
  if (!webhookId) return false;
  if (processedWebhooks.has(webhookId)) {
    console.log(`⚠️ Duplicate webhook ignored: ${webhookId}`);
    return true;
  }

  // Mark as processed
  processedWebhooks.set(webhookId, Date.now());

  // Cleanup old entries periodically
  const now = Date.now();
  for (const [id, timestamp] of processedWebhooks) {
    if (now - timestamp > WEBHOOK_DEDUP_TTL_MS) {
      processedWebhooks.delete(id);
    }
  }

  return false;
}

/**
 * Extract call control ID from webhook payload (handles multiple paths).
 */
function extractCallControlId(req: any): string | undefined {
  return (
    req.body?.data?.payload?.call_control_id ||
    req.body?.data?.payload?.call_control_id ||
    req.body?.payload?.call_control_id
  );
}

// ============================================================================
// HELPER FUNCTIONS - TTS State Management
// ============================================================================

/**
 * Get the current TTS playback state for a call.
 * Returns null if TTS is not actively playing.
 */
function getTtsPlaybackState(callControlId: string | undefined): TtsPlaybackState | null {
  if (!callControlId) return null;
  return activeTtsPlayback.get(callControlId) ?? null;
}

/**
 * Check if TTS is actually playing on a call (from webhook confirmation).
 */
function isTtsActuallyPlaying(callControlId: string | undefined): boolean {
  return getTtsPlaybackState(callControlId) !== null;
}

/**
 * Clear stale TTS playback entries (prevent memory leak).
 */
function cleanupStaleTtsState(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [callControlId, state] of activeTtsPlayback) {
    if (now - state.startedAt > TTS_STALE_THRESHOLD_MS) {
      console.warn(`🧹 Cleaning stale TTS state for ${callControlId}`);
      activeTtsPlayback.delete(callControlId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} stale TTS entries`);
  }
}

// Start periodic cleanup
setInterval(cleanupStaleTtsState, TTS_STALE_CLEANUP_INTERVAL_MS);

// ============================================================================
// HELPER FUNCTIONS - Transcript & Response Handling
// ============================================================================

/**
 * Queue a user transcript for processing with debounce.
 * Only processes FINAL transcripts, but uses interim for interrupt detection.
 * Applies different debounce times based on context.
 */
function queueUserTranscript(
  callContext: CallContext,
  transcript: string,
  ws: WebSocket,
  debounceMs: number = DEBOUNCE_CONFIG.NORMAL
): void {
  // Update the transcript and timestamp
  callContext.lastUserTranscript = transcript;
  callContext.lastTranscriptAt = Date.now();

  // Clear any existing debounce timer
  if (callContext.ttsDebounceTimer) {
    clearTimeout(callContext.ttsDebounceTimer);
  }

  // Schedule new TTS response with appropriate debounce
  callContext.ttsDebounceTimer = setTimeout(() => {
    scheduleTtsResponse(callContext, ws);
  }, debounceMs);

  console.log(`⏱️ Response scheduled in ${debounceMs}ms`);
}

/**
 * Check if the call is still active and ready for TTS.
 */
function canSpeak(callContext: CallContext, ws: WebSocket): boolean {
  return callContext.isCallActive === true && ws.readyState === WebSocket.OPEN;
}

/**
 * Handle interrupt: stop TTS, clear debounce, prepare for new response.
 */
async function handleInterrupt(callContext: CallContext, latencyMs: number): Promise<void> {
  console.log(`🛑 Handling interrupt (latency: ${latencyMs}ms)`);

  if (!callContext.callControlId) return;

  // Clear pending debounce timer
  if (callContext.ttsDebounceTimer) {
    clearTimeout(callContext.ttsDebounceTimer);
    callContext.ttsDebounceTimer = undefined;
  }

  // Get current TTS state and attempt to stop
  const ttsState = getTtsPlaybackState(callContext.callControlId);

  if (ttsState) {
    try {
      // Use command_id if available for targeted stop
      await stopSpeaking(callContext.callControlId, ttsState.commandId);
      console.log("✅ Stop command sent successfully");
    } catch (stopError) {
      // stopSpeaking handles 404/409 gracefully, so we only log warnings here
      console.warn("⚠️ Error stopping TTS on interrupt:", stopError);
    }

    // Clear from map (webhook will confirm with call.speak.ended)
    // But don't wait for webhook—remove optimistically
    activeTtsPlayback.delete(callContext.callControlId);
  }

  // Record interrupt timestamp for analytics
  callContext.lastInterruptAt = Date.now();
}

/**
 * When the debounce timer fires, process the accumulated transcript.
 */
async function scheduleTtsResponse(
  callContext: CallContext,
  ws: WebSocket
): Promise<void> {
  try {
    // Guard: Check if we can still speak
    if (!canSpeak(callContext, ws)) {
      console.log("⚠️ Call ended or WebSocket closed, skipping TTS response");
      return;
    }

    const userText = callContext.lastUserTranscript?.trim() || "";
    if (!userText) {
      console.log("⚠️ No transcript to process");
      return;
    }

    console.log("🎯 Processing accumulated transcript:", userText);

    // Append user turn to call context
    if (callContext.callId) {
      contextMgr.appendTurn(callContext.callId, {
        speaker: "caller",
        text: userText,
        timestamp: new Date().toISOString(),
      });
    }

    // Send to LLM
    let aiText: string;
    try {
      aiText = await generateAssistantReply(userText, callContext);
    } catch (groqError) {
      console.error(
        "❌ Groq API error:",
        groqError instanceof Error ? groqError.message : groqError
      );
      if (canSpeak(callContext, ws)) {
        ws.send(
          JSON.stringify({
            event: "error",
            payload: { message: "Failed to process request with AI model" },
          })
        );
      }
      return;
    }

    if (!aiText) {
      console.warn("⚠️ Groq returned empty response");
      if (canSpeak(callContext, ws)) {
        ws.send(
          JSON.stringify({
            event: "error",
            payload: { message: "AI model returned empty response" },
          })
        );
      }
      return;
    }

    console.log("🤖 AI:", aiText);

    // Append assistant turn to call context
    if (callContext.callId) {
      contextMgr.appendTurn(callContext.callId, {
        speaker: "assistant",
        text: aiText,
        timestamp: new Date().toISOString(),
      });

      // Try to update rolling summary
      try {
        await maybeUpdateSummaryForCall(callContext.callId);
      } catch (summaryError) {
        console.warn(
          "⚠️ Failed to update rolling summary:",
          summaryError instanceof Error ? summaryError.message : summaryError
        );
        // Continue even if summary fails
      }
    }

    // Guard again before TTS (race condition prevention)
    if (!canSpeak(callContext, ws)) {
      console.log("⚠️ Call ended before TTS, discarding response");
      return;
    }

    // Send to TTS
    await sendTtsResponse(callContext, ws, aiText);

    // Clear transcript after processing
    callContext.lastUserTranscript = "";
  } catch (error) {
    console.error(
      "❌ Unexpected error in TTS response handler:",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Send the AI response as speech via Telnyx TTS.
 * Tracks actual playback state via webhooks, not API response timing.
 */
async function sendTtsResponse(
  callContext: CallContext,
  ws: WebSocket,
  aiText: string
): Promise<void> {
  const pipelineStartTime = Date.now();
  console.log("");
  console.log("🎵 ========================================");
  console.log("🎵 STARTING TTS SPEAK ACTION");
  console.log("🎵 ========================================");

  // Final safety check
  if (!canSpeak(callContext, ws)) {
    console.log("⚠️ Call ended or WebSocket closed, skipping TTS API call");
    return;
  }

  if (!callContext.callControlId) {
    console.error("❌ Cannot synthesize speech: callControlId is not set");
    if (canSpeak(callContext, ws)) {
      ws.send(
        JSON.stringify({
          event: "error",
          payload: { message: "Call control ID not initialized" },
        })
      );
    }
    return;
  }

  // Check if this response contains "Chow" (end of call signal)
  const shouldHangup = /\bchow\b/i.test(aiText);
  if (shouldHangup) {
    console.log("👋 Detected 'Chow' in AI response - will hangup after TTS");
  }

  const callControlId = callContext.callControlId;

  try {
    // Set optimistic state (will be confirmed by webhook)
    // This allows interrupt detection to work even if webhook is delayed
    const optimisticState: TtsPlaybackState = {
      startedAt: Date.now(),
      callControlId,
      commandId: undefined, // Will be updated by webhook
    };

    // Add timeout fallback in case webhook never arrives
    optimisticState.timeoutId = setTimeout(() => {
      const current = activeTtsPlayback.get(callControlId);
      if (current === optimisticState) {
        console.warn(
          `⚠️ TTS webhook (call.speak.started) never received for ${callControlId}, clearing optimistic state`
        );
        activeTtsPlayback.delete(callControlId);
      }
    }, TTS_WEBHOOK_TIMEOUT_MS);

    activeTtsPlayback.set(callControlId, optimisticState);

    // Call Telnyx Speak API
    await synthesizeSpeech(aiText, callControlId);

    console.log("📤 TTS API call sent, waiting for call.speak.started webhook...");

    // If "Chow" was detected, hang up after TTS completes
    if (shouldHangup) {
      console.log("⏳ Waiting 2 seconds for TTS to complete before hangup...");
      await new Promise(resolve => setTimeout(resolve, 2000));

      try {
        await hangupCall(callControlId);
        console.log("📞 Call ended after 'Chow'");
      } catch (hangupError) {
        console.error("❌ Hangup failed:", hangupError);
      }
    }
  } catch (ttsError) {
    console.error(
      "❌ Telnyx TTS error:",
      ttsError instanceof Error ? ttsError.message : ttsError
    );

    // Clear optimistic state on error
    activeTtsPlayback.delete(callControlId);

    if (canSpeak(callContext, ws)) {
      ws.send(
        JSON.stringify({
          event: "error",
          payload: { message: "TTS synthesis failed" },
        })
      );
    }
    return;
  }

  console.log("⏱️ Total TTS response time:", Date.now() - pipelineStartTime, "ms");
  console.log("==========================================");
  console.log("");
}

/**
 * Cleanup call state (timers, connections, context).
 */
function cleanupCallState(callContext: CallContext): void {
  console.log("🧹 Cleaning up call state");
  callContext.isCallActive = false;

  // Clear all timers
  if (callContext.ttsDebounceTimer) {
    clearTimeout(callContext.ttsDebounceTimer);
    callContext.ttsDebounceTimer = undefined;
  }
  if (callContext.interruptDebounceTimer) {
    clearTimeout(callContext.interruptDebounceTimer);
    callContext.interruptDebounceTimer = undefined;
  }

  // Clear TTS playback tracking and cancel timeout
  if (callContext.callControlId) {
    const ttsState = activeTtsPlayback.get(callContext.callControlId);
    if (ttsState?.timeoutId) {
      clearTimeout(ttsState.timeoutId);
    }
    activeTtsPlayback.delete(callContext.callControlId);
  }

  callContext.lastUserTranscript = "";

  // Close Deepgram WebSocket
  if (callContext.deepgramSocket) {
    try {
      if (typeof callContext.deepgramSocket.finish === "function") {
        callContext.deepgramSocket.finish();
      }
      if (typeof callContext.deepgramSocket.close === "function") {
        callContext.deepgramSocket.close(1000, "Call ended");
      }
      console.log("✅ Deepgram connection closed");
    } catch (error) {
      console.warn(
        "⚠️ Error closing Deepgram connection:",
        error instanceof Error ? error.message : error
      );
    }
    callContext.deepgramSocket = undefined;
  }

  // Clear call context from manager
  if (callContext.callId) {
    console.log(`📋 Clearing CallContext for call ${callContext.callId}`);
    contextMgr.clearContext(callContext.callId);
  }
}

// ============================================================================
// APP + SERVER SETUP
// ============================================================================

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

// Helper: Generate WAV file header for 8kHz mono 16-bit PCM
function generateWavHeader(pcmDataLength: number, sampleRate: number = 8000): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  const fileSize = 36 + pcmDataLength;
  const header = Buffer.alloc(44);
  let offset = 0;

  // RIFF header
  header.write("RIFF", offset);
  offset += 4;
  header.writeUInt32LE(fileSize, offset);
  offset += 4;
  header.write("WAVE", offset);
  offset += 4;

  // fmt subchunk
  header.write("fmt ", offset);
  offset += 4;
  header.writeUInt32LE(16, offset);
  offset += 4;
  header.writeUInt16LE(1, offset);
  offset += 2;
  header.writeUInt16LE(channels, offset);
  offset += 2;
  header.writeUInt32LE(sampleRate, offset);
  offset += 4;
  header.writeUInt32LE(byteRate, offset);
  offset += 4;
  header.writeUInt16LE(blockAlign, offset);
  offset += 2;
  header.writeUInt16LE(bitsPerSample, offset);
  offset += 2;

  // data subchunk
  header.write("data", offset);
  offset += 4;
  header.writeUInt32LE(pcmDataLength, offset);

  return header;
}

/**
 * ITU-T G.711 μ-law decoder (8-bit → 16-bit PCM).
 */
function decodeMulawG711(mulaw: number): number {
  mulaw = ~mulaw & 0xFF;
  const sign = (mulaw & 0x80) ? -1 : 1;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0F;

  let sample: number;
  if (exponent === 0) {
    sample = (mantissa << 3) + 132;
  } else {
    sample = ((mantissa << 3) + 132) << exponent;
  }

  sample -= 132;
  return sign * sample;
}

// ============================================================================
// OUTBOUND CALL ENDPOINT
// ============================================================================

app.use("/api/outbound-call", outboundCallRouter);

// ============================================================================
// TELNYX WEBHOOK HANDLER
// ============================================================================

app.post("/webhooks/telnyx", async (req, res) => {
  const eventType = req.body?.data?.event_type;
  const webhookId = req.body?.meta?.webhook_id;

  console.log("📞 Telnyx webhook event:", eventType);

  // Deduplicate webhooks
  if (isWebhookDuplicate(webhookId)) {
    return res.send("ok");
  }

  const callControlId = extractCallControlId(req);

  if (eventType === "call.answered") {
    console.log(
      "📦 Telnyx call.answered payload:",
      JSON.stringify(req.body, null, 2)
    );

    if (!callControlId) {
      console.warn("⚠️ call.answered webhook missing call_control_id");
    } else {
      try {
        await axios.post(
          `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`,
          {
            stream_url: config.telnyx.streamUrl,
            stream_track: "both_tracks",
            stream_bidirectional_mode: "rtp",
          },
          {
            headers: {
              "Authorization": `Bearer ${config.telnyx.apiKey}`,
              "Content-Type": "application/json",
            },
          }
        );
        console.log("✅ Streaming started for call:", callControlId);
      } catch (error) {
        console.error(
          "❌ Failed to start streaming:",
          error instanceof Error ? error.message : error
        );
        if (error instanceof Error && "response" in error) {
          const err = error as any;
          console.error("📋 Telnyx API Error Details:", {
            status: err.response?.status,
            statusText: err.response?.statusText,
            data: err.response?.data,
          });
        }
      }
    }
  }
  // TTS PLAYBACK STARTED: Audio actually playing on the call
  else if (eventType === "call.speak.started") {
    if (callControlId) {
      const existingState = activeTtsPlayback.get(callControlId);

      // Update or create state
      if (existingState) {
        // Clear the timeout since we got confirmation
        if (existingState.timeoutId) {
          clearTimeout(existingState.timeoutId);
          existingState.timeoutId = undefined;
        }
        // Update command_id if provided
        if (req.body?.data?.payload?.command_id) {
          existingState.commandId = req.body.data.payload.command_id;
        }
        console.log("🔊 TTS playback CONFIRMED (webhook received)");
      } else {
        // Create new state from webhook
        activeTtsPlayback.set(callControlId, {
          startedAt: Date.now(),
          callControlId,
          commandId: req.body?.data?.payload?.command_id,
        });
        console.log("🔊 TTS playback STARTED on call, interrupt detection ENABLED");
      }
    }
  }
  // TTS PLAYBACK ENDED: Audio finished playing
  else if (eventType === "call.speak.ended") {
    if (callControlId) {
      activeTtsPlayback.delete(callControlId);
      console.log("🔇 TTS playback ENDED on call, interrupt detection DISABLED");
    }
  }
  // CALL ENDED: Cleanup TTS tracking
  else if (eventType === "call.hangup" || eventType === "streaming.stopped") {
    console.log("📞 Call ended:", eventType);
    if (callControlId) {
      activeTtsPlayback.delete(callControlId);
    }
  }
  // Handle Deepgram errors for visibility
  else if (eventType === "call.streaming.error") {
    console.error("❌ Telnyx streaming error:", req.body?.data?.payload);
    if (callControlId) {
      activeTtsPlayback.delete(callControlId);
    }
  }

  res.send("ok");
});

// ============================================================================
// WEBSOCKET HANDLER (Core Audio Processing)
// ============================================================================

wss.on("connection", async (ws) => {
  console.log("🔌 Telnyx WebSocket Connected");

  // Call state
  let callContext: CallContext | undefined;

  // Create Deepgram live stream
  const dgLive = await deepgram.listen.live({
    model: config.deepgram.model,
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    endpointing: 100,
  });

  console.log("🎧 Deepgram stream started");

  // Monitor Deepgram connection health
  dgLive.on(LiveTranscriptionEvents.Transcript, () => {
    deepgramLastActivity = Date.now();
  });

  dgLive.on(LiveTranscriptionEvents.Error, (error: any) => {
    console.error("❌ Deepgram error:", error);
  });

  dgLive.on(LiveTranscriptionEvents.Close, () => {
    console.log("🔌 Deepgram connection closed");
  });

  // ========================================================================
  // TRANSCRIPT HANDLER
  // ========================================================================

  dgLive.on(LiveTranscriptionEvents.Transcript, async (dgEvent: any) => {
    try {
      const results = dgEvent.channel?.alternatives?.[0];
      const isFinal = dgEvent.is_final ?? false;

      // Guard: Call must be active
      if (!callContext || !callContext.isCallActive) {
        if (results?.transcript && process.env.LOG_INACTIVE_TRANSCRIPTS === "true") {
          console.debug("📝 Deepgram transcript (call inactive):", results.transcript);
        }
        return;
      }

      if (!results?.transcript) return;

      const userText = results.transcript.trim();
      if (!userText) return;

      // Log transcript type for debugging
      const transcriptType = isFinal ? "final" : "interim";
      console.log(`🗣️ Caller transcript (${transcriptType}):`, userText);

      // =====================================================================
      // INTERRUPT DETECTION (works on both interim and final)
      // =====================================================================

      const ttsState = getTtsPlaybackState(callContext.callControlId);

      if (ttsState && callContext.callControlId) {
        // Caller spoke during active TTS playback → INTERRUPT
        const latencyMs = Date.now() - ttsState.startedAt;

        console.log(
          `🛑 Caller interrupted TTS playback (${latencyMs}ms into playback), stopping speech`
        );

        await handleInterrupt(callContext, latencyMs);

        // Queue with shortened debounce for faster response
        queueUserTranscript(
          callContext,
          userText,
          ws,
          DEBOUNCE_CONFIG.POST_INTERRUPT
        );
        return;
      }

      // =====================================================================
      // NORMAL RESPONSE QUEUEING (only process final transcripts)
      // =====================================================================

      // Skip interim transcripts in normal flow (already used for interrupts above)
      if (!isFinal) {
        if (process.env.LOG_INTERIM_TRANSCRIPTS === "true") {
          console.log(`📝 Interim (not queued): ${userText}`);
        }
        return;
      }

      // Final transcript received → queue with normal debounce
      queueUserTranscript(callContext, userText, ws, DEBOUNCE_CONFIG.NORMAL);

    } catch (error) {
      console.error(
        "❌ Unexpected error in transcript handler:",
        error instanceof Error ? error.message : error
      );
      if (ws.readyState === WebSocket.OPEN && callContext) {
        ws.send(
          JSON.stringify({
            event: "error",
            payload: { message: "Unexpected error processing transcript" },
          })
        );
      }
    }
  });

  // ========================================================================
  // WEBSOCKET MESSAGE HANDLER
  // ========================================================================

  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch (parseError) {
      console.warn(
        "⚠️ Failed to parse WebSocket message:",
        parseError instanceof Error ? parseError.message : parseError
      );
      return;
    }

    try {
      // CALL START: Initialize call context
      if (msg.event === "start") {
        console.log("🎬 Call started");

        try {
          const start = msg.start || {};
          const clientStateBase64 = start.client_state;
          const callControlId = start.call_control_id;
          const streamId = msg.stream_id;

          let decoded: any = {};
          if (typeof clientStateBase64 === "string" && clientStateBase64.length > 0) {
            const json = Buffer.from(clientStateBase64, "base64").toString("utf8");
            decoded = JSON.parse(json);
          }

          // Get or create context
          const managedContext = contextMgr.getOrCreateContext(callControlId);

          // Initialize context
          managedContext.callControlId = callControlId;
          managedContext.streamId = streamId;
          managedContext.goal = decoded.goal;
          managedContext.userId = decoded.userId;
          managedContext.initiatedAt = decoded.initiatedAt;
          managedContext.isCallActive = true;
          managedContext.lastUserTranscript = "";
          managedContext.lastTranscriptAt = 0;
          managedContext.deepgramSocket = dgLive;

          callContext = managedContext;

          console.log("📋 Call context initialized:", {
            callId: callContext.callId,
            callControlId: callContext.callControlId,
            goal: callContext.goal,
            userId: callContext.userId,
          });
        } catch (err) {
          console.error(
            "❌ Failed to decode Telnyx client_state:",
            err instanceof Error ? err.message : err
          );
        }
      }
      // MEDIA: Process audio from Telnyx
      else if (msg.event === "media" && msg.media?.payload) {
        const track = msg.media?.track;

        // Skip outbound (AI's own speech)
        if (track === "outbound") {
          if (process.env.LOG_AUDIO_PACKETS === "true") {
            console.log("🔄 Skipping outbound (AI) audio packet");
          }
          return;
        }

        // Process inbound (caller's voice)
        const audio = Buffer.from(msg.media.payload, "base64");
        if (process.env.LOG_AUDIO_PACKETS === "true") {
          console.log("🎙️ Received Telnyx media packet, track:", track, "bytes:", audio.length);
        }
        dgLive.send(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength));
      }
      // STOP: Call ended
      else if (msg.event === "stop") {
        console.log("🛑 Telnyx media stream stopped");
        if (callContext) {
          cleanupCallState(callContext);
        }
      }
    } catch (error) {
      console.error(
        "❌ Error processing WebSocket message:",
        error instanceof Error ? error.message : error
      );
    }
  });

  // ========================================================================
  // WEBSOCKET CLOSE HANDLER
  // ========================================================================

  ws.on("close", () => {
    console.log("🔌 Client disconnected");
    if (callContext) {
      // Cleanup TTS tracking
      if (callContext.callControlId) {
        const ttsState = activeTtsPlayback.get(callContext.callControlId);
        if (ttsState?.timeoutId) {
          clearTimeout(ttsState.timeoutId);
        }
        activeTtsPlayback.delete(callContext.callControlId);
      }
      cleanupCallState(callContext);
    }
    dgLive.finish();
  });
});

// ============================================================================
// HEALTH CHECK ENDPOINT
// ============================================================================

app.get("/health", (req, res) => {
  const now = Date.now();
  const deepgramInactivity = now - deepgramLastActivity;
  const activeCalls = contextMgr.getActiveCallIds().length;
  const activeTts = activeTtsPlayback.size;

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    deepgramInactivityMs: deepgramInactivity,
    deepgramHealthy: deepgramInactivity < DEEPGRAM_INACTIVITY_THRESHOLD_MS,
    activeCalls,
    activeTtsPlayback: activeTts,
  });
});

// ============================================================================
// START SERVER
// ============================================================================

server.listen(config.port, () => {
  console.log(`🚀 AI Server running on port ${config.port}`);
  console.log(`📊 Health check available at http://localhost:${config.port}/health`);
});
