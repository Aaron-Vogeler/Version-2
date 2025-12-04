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

// Constants
const TTS_DEBOUNCE_MS = 500; // 500 milliseconds of silence before responding (reduced from 800ms for faster response)

// -----------------------------------------------------------------------------
// CLIENTS
// -----------------------------------------------------------------------------
const deepgram = createDeepgramClient();

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

/**
 * Queue a user transcript fragment for potential LLM + TTS processing.
 * Resets the debounce timer on each transcript update.
 * Increments turnSeq to invalidate any in-flight responses from previous turns.
 * @param callContext - The call context
 * @param transcript - The user transcript
 * @param ws - The WebSocket connection
 */
function queueUserTranscript(
  callContext: CallContext,
  transcript: string,
  ws: WebSocket
): void {
  // Update the transcript and timestamp
  callContext.lastUserTranscript = transcript;
  callContext.lastTranscriptAt = Date.now();

  // Increment turn sequence (invalidates in-flight work from previous turns)
  callContext.turnSeq = (callContext.turnSeq || 0) + 1;
  const currentSeq = callContext.turnSeq;

  // Clear any existing debounce timer
  if (callContext.ttsDebounceTimer) {
    clearTimeout(callContext.ttsDebounceTimer);
  }

  // Schedule a new TTS response timer
  callContext.ttsDebounceTimer = setTimeout(() => {
    scheduleTtsResponse(callContext, ws, currentSeq);
  }, TTS_DEBOUNCE_MS);
}

/**
 * Check if the call is still active and ready for TTS.
 */
function canSpeak(callContext: CallContext, ws: WebSocket): boolean {
  return callContext.isCallActive === true && ws.readyState === WebSocket.OPEN;
}

/**
 * When the debounce timer fires, process the accumulated transcript.
 * Checks turnSeq to ensure this response is still valid (not stale from barge-in).
 * @param callContext - The call context
 * @param ws - The WebSocket connection
 * @param expectedSeq - The turn sequence number when this response was scheduled
 */
async function scheduleTtsResponse(
  callContext: CallContext,
  ws: WebSocket,
  expectedSeq: number
): Promise<void> {
  try {
    // GUARD: Check if this response is stale (turnSeq changed due to barge-in or new speech)
    if (callContext.turnSeq !== expectedSeq) {
      console.log(
        `[TURN] ⏭️ Dropping stale response (expected seq ${expectedSeq}, current ${callContext.turnSeq})`
      );
      return;
    }

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

    // Append user turn to the call context if callId is available
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

    // GUARD: Check again after LLM call (which may take time)
    if (callContext.turnSeq !== expectedSeq) {
      console.log(
        `[TURN] ⏭️ Dropping stale LLM response (expected seq ${expectedSeq}, current ${callContext.turnSeq})`
      );
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

    // Append assistant turn to the call context if callId is available
    if (callContext.callId) {
      contextMgr.appendTurn(callContext.callId, {
        speaker: "assistant",
        text: aiText,
        timestamp: new Date().toISOString(),
      });

      // Check if we should update the rolling summary
      try {
        await maybeUpdateSummaryForCall(callContext.callId);
      } catch (summaryError) {
        console.warn(
          "⚠️ Failed to update rolling summary:",
          summaryError instanceof Error ? summaryError.message : summaryError
        );
        // Continue even if summary update fails
      }
    }

    // Send to TTS only if we can still speak and seq is still valid
    await sendTtsResponse(callContext, ws, aiText, expectedSeq);

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
 * Sets ttsState to 'speaking' before TTS call.
 * Actual playback end is tracked via Telnyx webhooks (call.speak.ended).
 * @param callContext - The call context
 * @param ws - The WebSocket connection
 * @param aiText - The text to speak
 * @param expectedSeq - The turn sequence number to validate
 */
async function sendTtsResponse(
  callContext: CallContext,
  ws: WebSocket,
  aiText: string,
  expectedSeq: number
): Promise<void> {
  const pipelineStartTime = Date.now();
  console.log("");
  console.log("🎵 ========================================");
  console.log("🎵 STARTING TTS SPEAK ACTION");
  console.log("🎵 ========================================");

  // GUARD: Final check - is this response still valid?
  if (callContext.turnSeq !== expectedSeq) {
    console.log(
      `[TURN] ⏭️ Dropping stale TTS request (expected seq ${expectedSeq}, current ${callContext.turnSeq})`
    );
    return;
  }

  // Double-check we can still speak before calling TTS API
  if (!canSpeak(callContext, ws)) {
    console.log("⚠️ Call ended or WebSocket closed, skipping TTS API call");
    return;
  }

  // Call Telnyx Speak API to synthesize and play audio
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

  try {
    // IMPORTANT: Set ttsState to 'speaking' BEFORE calling synthesizeSpeech
    // This enables barge-in detection while audio is being queued/played
    callContext.ttsState = "speaking";
    console.log(`[TTS] Setting ttsState='speaking' (callControlId: ${callContext.callControlId})`);

    await synthesizeSpeech(aiText, callContext.callControlId);

    // NOTE: Do NOT set ttsState='idle' here!
    // The HTTP response returns BEFORE audio finishes playing.
    // Telnyx webhooks (call.speak.ended) will set ttsState='idle' when playback truly ends.

    // If AI said "Chow", wait a moment then hangup
    if (shouldHangup && callContext.callControlId) {
      console.log("⏳ Waiting 2 seconds for TTS to complete before hangup...");
      await new Promise(resolve => setTimeout(resolve, 2000));

      try {
        await hangupCall(callContext.callControlId);
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
    // On error, reset ttsState to idle
    callContext.ttsState = "idle";
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
 * Cleanup call state (clear timers, mark as inactive, close Deepgram connection).
 * Also clears the CallContext from the context manager.
 */
function cleanupCallState(callContext: CallContext): void {
  console.log("🧹 Cleaning up call state");
  callContext.isCallActive = false;
  callContext.ttsState = "idle";
  if (callContext.ttsDebounceTimer) {
    clearTimeout(callContext.ttsDebounceTimer);
    callContext.ttsDebounceTimer = undefined;
  }
  callContext.lastUserTranscript = "";

  // Close the Deepgram WebSocket if it exists and is open
  if (callContext.deepgramSocket) {
    try {
      // Try to send CloseStream if the SDK requires it
      if (typeof callContext.deepgramSocket.finish === "function") {
        callContext.deepgramSocket.finish();
      }
      // Close the underlying WebSocket
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

  // Clean up the CallContext from the context manager
  if (callContext.callId) {
    console.log(`📋 Clearing CallContext for call ${callContext.callId}`);
    contextMgr.clearContext(callContext.callId);
  }
}

// -----------------------------------------------------------------------------
// APP + SERVER
// -----------------------------------------------------------------------------
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

// HELPER: Generate a WAV file header for 8kHz mono 16-bit PCM
function generateWavHeader(pcmDataLength: number, sampleRate: number = 8000): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  // Total file size: 36 + pcm data length
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
  header.writeUInt32LE(16, offset); // Subchunk1Size (16 for PCM)
  offset += 4;
  header.writeUInt16LE(1, offset); // AudioFormat (1 = PCM)
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

// DEBUG ENDPOINTS REMOVED: These were specific to OpenAI TTS pipeline with manual audio processing.
// With Telnyx TTS, audio synthesis and playback are handled directly by Telnyx on the call.

/**
 * ITU-T G.711 μ-law decoder.
 * Converts 8-bit μ-law to 16-bit linear PCM.
 */
function decodeMulawG711(mulaw: number): number {
  // Invert the bits (μ-law uses inverted encoding)
  mulaw = ~mulaw & 0xFF;
  
  // Extract sign, exponent, and mantissa
  const sign = (mulaw & 0x80) ? -1 : 1;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0F;
  
  // Reconstruct the sample
  // The formula: sample = (mantissa << (exponent + 3)) + (1 << (exponent + 3)) - 132
  let sample: number;
  if (exponent === 0) {
    sample = (mantissa << 3) + 132;
  } else {
    sample = ((mantissa << 3) + 132) << exponent;
  }
  
  // Remove the bias
  sample -= 132;
  
  return sign * sample;
}


// OUTBOUND CALL ENDPOINT
app.use("/api/outbound-call", outboundCallRouter);

// TELNYX WEBHOOKS (Call start/stop and TTS playback lifecycle)
app.post("/webhooks/telnyx", async (req, res) => {
  const eventType = req.body?.data?.event_type;
  const callControlId = req.body?.data?.payload?.call_control_id;

  console.log(`📞 Telnyx webhook event: ${eventType} (callControlId: ${callControlId || 'N/A'})`);

  if (eventType === "call.answered") {
    console.log(
      "📦 Telnyx call.answered payload:",
      JSON.stringify(req.body, null, 2)
    );
    if (!callControlId) {
      console.warn("⚠️ call.answered webhook missing payload.call_control_id");
    }
    if (callControlId) {
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
        console.error("❌ Failed to start streaming:", error instanceof Error ? error.message : error);
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
  } else if (eventType === "call.speak.started") {
    // TTS playback has started
    if (callControlId) {
      const ctx = contextMgr.getContext(callControlId);
      if (ctx) {
        ctx.ttsState = "speaking";
        console.log(`[TTS] 🔊 call.speak.started - ttsState='speaking' (callControlId: ${callControlId})`);
      } else {
        console.warn(`[TTS] ⚠️ call.speak.started for unknown callControlId: ${callControlId}`);
      }
    }
  } else if (eventType === "call.speak.ended") {
    // TTS playback has ended
    if (callControlId) {
      const ctx = contextMgr.getContext(callControlId);
      if (ctx) {
        ctx.ttsState = "idle";
        console.log(`[TTS] ✅ call.speak.ended - ttsState='idle' (callControlId: ${callControlId})`);
      } else {
        console.warn(`[TTS] ⚠️ call.speak.ended for unknown callControlId: ${callControlId}`);
      }
    }
  } else if (eventType === "call.playback.ended") {
    // Belt-and-suspenders: Also handle generic playback.ended
    if (callControlId) {
      const ctx = contextMgr.getContext(callControlId);
      if (ctx) {
        ctx.ttsState = "idle";
        console.log(`[TTS] ✅ call.playback.ended - ttsState='idle' (callControlId: ${callControlId})`);
      } else {
        console.warn(`[TTS] ⚠️ call.playback.ended for unknown callControlId: ${callControlId}`);
      }
    }
  } else if (eventType === "call.hangup" || eventType === "streaming.stopped") {
    console.log("📞 Call ended:", eventType);
    // Note: We don't have access to callContext here, but we mark the call
    // as inactive via the WebSocket close event. Cleanup happens there.
  }

  res.send("ok");
});

// -----------------------------------------------------------------------------
// WS AUDIO SESSION HANDLER (core of the whole system)
// -----------------------------------------------------------------------------
wss.on("connection", async (ws) => {
  console.log("🔌 Telnyx WebSocket Connected");

  // Initialize call context (populated when "start" message arrives)
  let callContext: CallContext | undefined;

  // Create a Deepgram live stream with VAD events enabled for instant barge-in
  const dgLive = await deepgram.listen.live({
    model: config.deepgram.model,
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    endpointing: 100,
    vad_events: true,
    interim_results: true,
  });

  console.log("🎧 Deepgram stream started");

  // NOTE: We no longer use SpeechStarted for barge-in because it's too sensitive
  // (triggers on any sound, not just actual words). Instead, barge-in is now
  // handled in the Transcript event handler, which only fires when actual words
  // are detected by Deepgram's speech recognition.
  dgLive.on(LiveTranscriptionEvents.SpeechStarted, () => {
    // Log for debugging, but don't trigger barge-in on VAD alone
    if (callContext?.ttsState === "speaking") {
      console.log("[VAD] SpeechStarted detected while AI speaking (waiting for actual words before barge-in)");
    }
  });

  // Relay Deepgram transcript → Groq → Telnyx (with debounce)
  // BARGE-IN: Now handled here instead of SpeechStarted, so we only interrupt
  // when actual words are detected (not just sounds/noise)
  dgLive.on(LiveTranscriptionEvents.Transcript, async (dgEvent: any) => {
    try {
      const results = dgEvent.channel?.alternatives?.[0];

      // Guard: Check if call is still active BEFORE logging raw transcript
      if (!callContext || !callContext.isCallActive) {
        // Only log at debug level if call is not active to avoid flooding logs
        if (results?.transcript) {
          console.debug("📝 Deepgram raw transcript (call inactive):", results.transcript);
        }
        return;
      }

      if (!results || !results.transcript) return;

      const userText = results.transcript.trim();
      if (!userText) return;

      console.log("🗣️ Caller transcript:", userText);

      // BARGE-IN: If AI is speaking and we got actual words, interrupt it
      // This is more reliable than VAD because it only triggers on recognized speech
      if (callContext.ttsState === "speaking" && callContext.callControlId) {
        // Apply cooldown to prevent spamming the stop endpoint
        const now = Date.now();
        if (!callContext.bargeInCooldownUntil || now >= callContext.bargeInCooldownUntil) {
          console.log(`[BARGE-IN] 🛑 Words detected while AI speaking: "${userText}" (callControlId: ${callContext.callControlId})`);

          // Set cooldown (300ms) to prevent multiple rapid stops
          callContext.bargeInCooldownUntil = now + 300;

          // Mark as stopping
          callContext.ttsState = "stopping";

          // Issue playback stop
          try {
            await stopSpeaking(callContext.callControlId);
          } catch (stopError) {
            console.error("[BARGE-IN] ❌ Error stopping playback:", stopError);
          }

          // Clear any pending TTS debounce timer (we'll queue new response below)
          if (callContext.ttsDebounceTimer) {
            clearTimeout(callContext.ttsDebounceTimer);
            callContext.ttsDebounceTimer = undefined;
          }

          // Increment turn sequence to invalidate any in-flight LLM/TTS work
          callContext.turnSeq = (callContext.turnSeq || 0) + 1;
          console.log(`[TURN] Turn sequence incremented to ${callContext.turnSeq} (stale responses will be dropped)`);

          // Mark as idle after stop
          callContext.ttsState = "idle";
        } else {
          console.log(`[BARGE-IN] Cooldown active, skipping (${callContext.bargeInCooldownUntil - now}ms remaining)`);
        }
      }

      // Queue the transcript with debounce
      queueUserTranscript(callContext, userText, ws);
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

  //-----------------------------
  // WebSocket MESSAGE HANDLER
  //-----------------------------
  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch (parseError) {
      console.warn("⚠️ Failed to parse WebSocket message:", parseError instanceof Error ? parseError.message : parseError);
      return;
    }

    try {
      // Capture Telnyx client_state when call starts
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

          // Initialize or retrieve the CallContext from the context manager
          const managedContext = contextMgr.getOrCreateContext(callControlId);

          // Update with current call information
          managedContext.callControlId = callControlId;
          managedContext.streamId = streamId;
          managedContext.goal = decoded.goal;
          managedContext.userId = decoded.userId;
          managedContext.initiatedAt = decoded.initiatedAt;
          managedContext.isCallActive = true;
          managedContext.lastUserTranscript = "";
          managedContext.lastTranscriptAt = 0;
          managedContext.deepgramSocket = dgLive;

          // Create the local callContext reference for backward compatibility
          callContext = managedContext;

          console.log("📋 Call context initialized:", {
            callId: callContext.callId,
            callControlId: callContext.callControlId,
            goal: callContext.goal,
            userId: callContext.userId,
          });
        } catch (err) {
          console.error("❌ Failed to decode Telnyx client_state:", err instanceof Error ? err.message : err);
          // Do NOT throw; just continue without context
        }
      }
      // Telnyx media packets → Deepgram
      else if (msg.event === "media" && msg.media?.payload) {
        // CRITICAL: Only process inbound audio (caller's voice), ignore outbound (AI's voice)
        // Telnyx sends track information: "inbound" = caller, "outbound" = AI
        const track = msg.media?.track;

        // ONLY send inbound audio to Deepgram (caller's voice)
        // Skip outbound (AI's voice) and any undefined/unknown tracks
        if (track !== "inbound") {
          if (process.env.LOG_AUDIO_PACKETS === "true") {
            console.log(`🔄 Skipping non-inbound audio packet (track: ${track || "undefined"})`);
          }
          return;
        }

        // Process inbound audio (caller's voice only)
        const audio = Buffer.from(msg.media.payload, "base64");
        // Only log packet details if LOG_AUDIO_PACKETS is enabled (reduces noise in logs)
        if (process.env.LOG_AUDIO_PACKETS === "true") {
          console.log("🎙️ Received inbound audio packet, bytes:", audio.length);
        }
        dgLive.send(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength));
      } else if (msg.event === "stop") {
        console.log("🛑 Telnyx media stream stopped");
        if (callContext) {
          cleanupCallState(callContext);
        }
      }
    } catch (error) {
      console.error("❌ Error processing WebSocket message:", error instanceof Error ? error.message : error);
    }
  });

  ws.on("close", () => {
    console.log("🔌 Client disconnected");
    if (callContext) {
      cleanupCallState(callContext);
    }
    dgLive.finish();
  });
});

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------
server.listen(config.port, () => {
  console.log(`🚀 AI Server running on port ${config.port}`);
});
