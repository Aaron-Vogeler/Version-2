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
import { synthesizeSpeech, stopSpeaking } from "./pipeline/tts";
import * as contextMgr from "./callContextManager";

// Constants
const TTS_DEBOUNCE_MS = 800; // 800 milliseconds of silence before responding

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
 * @param callContext - The call context
 * @param transcript - The user transcript
 * @param ws - The WebSocket connection
 * @param onTtsStateChange - Callback to update TTS playing state
 */
function queueUserTranscript(
  callContext: CallContext,
  transcript: string,
  ws: WebSocket,
  onTtsStateChange?: (isPlaying: boolean) => void
): void {
  // Update the transcript and timestamp
  callContext.lastUserTranscript = transcript;
  callContext.lastTranscriptAt = Date.now();

  // Clear any existing debounce timer
  if (callContext.ttsDebounceTimer) {
    clearTimeout(callContext.ttsDebounceTimer);
  }

  // Schedule a new TTS response timer
  callContext.ttsDebounceTimer = setTimeout(() => {
    scheduleTtsResponse(callContext, ws, onTtsStateChange);
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
 * @param callContext - The call context
 * @param ws - The WebSocket connection
 * @param onTtsStateChange - Callback to update TTS playing state
 */
async function scheduleTtsResponse(
  callContext: CallContext,
  ws: WebSocket,
  onTtsStateChange?: (isPlaying: boolean) => void
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

    // Send to TTS only if we can still speak
    await sendTtsResponse(callContext, ws, aiText, onTtsStateChange);

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
 * @param callContext - The call context
 * @param ws - The WebSocket connection
 * @param aiText - The text to speak
 * @param onTtsStateChange - Callback to update TTS playing state
 */
async function sendTtsResponse(
  callContext: CallContext,
  ws: WebSocket,
  aiText: string,
  onTtsStateChange?: (isPlaying: boolean) => void
): Promise<void> {
  const pipelineStartTime = Date.now();
  console.log("");
  console.log("🎵 ========================================");
  console.log("🎵 STARTING TTS SPEAK ACTION");
  console.log("🎵 ========================================");

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

  try {
    // Mark TTS as playing
    if (onTtsStateChange) {
      onTtsStateChange(true);
    }

    await synthesizeSpeech(aiText, callContext.callControlId);

    // Mark TTS as no longer playing when synthesis completes
    if (onTtsStateChange) {
      onTtsStateChange(false);
    }
  } catch (ttsError) {
    console.error(
      "❌ Telnyx TTS error:",
      ttsError instanceof Error ? ttsError.message : ttsError
    );
    if (onTtsStateChange) {
      onTtsStateChange(false);
    }
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

// TELNYX WEBHOOKS (Call start/stop)
app.post("/webhooks/telnyx", async (req, res) => {
  const eventType = req.body?.data?.event_type;
  console.log("📞 Telnyx webhook event:", eventType);

  if (eventType === "call.answered") {
    console.log(
      "📦 Telnyx call.answered payload:",
      JSON.stringify(req.body, null, 2)
    );
    const callControlId = req.body?.data?.payload?.call_control_id;
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

  // Track if TTS is currently playing (for interrupt detection)
  let isTtsPlaying = false;

  // Create a Deepgram live stream
  const dgLive = await deepgram.listen.live({
    model: config.deepgram.model,
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    endpointing: 100,
  });

  console.log("🎧 Deepgram stream started");

  // Relay Deepgram transcript → Groq → Telnyx (with 800ms silence debounce)
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

      // Debug: Log the full event structure to understand track information
      console.log("📊 Deepgram event structure:", {
        channel: dgEvent.channel,
        metadata: dgEvent.metadata,
        type: dgEvent.type,
      });

      if (!results || !results.transcript) return;

      const userText = results.transcript.trim();
      if (!userText) return;

      console.log("🗣️ Raw transcript:", userText);

      // AUDIO SOURCE DETECTION:
      // Deepgram should provide track information to distinguish inbound (caller) vs outbound (AI)
      // In bidirectional RTP mode, even channel = inbound, odd channel = outbound
      // Or check the dgEvent structure for explicit track/source information
      const channelIndex = dgEvent.channel?.channel || 0;
      const isOutboundTrack = channelIndex % 2 === 1; // Odd channels are typically outbound

      console.log(`🔊 Track detection - Channel: ${channelIndex}, Is Outbound: ${isOutboundTrack}`);

      // If this is from the outbound track (AI's own voice), ignore it
      if (isOutboundTrack) {
        console.log("🔄 This is AI's own TTS output, ignoring");
        return;
      }

      // This is from the inbound track (caller's voice)
      console.log("✅ This is from caller, processing");

      // If TTS is currently playing and caller speaks, stop it
      if (isTtsPlaying && callContext.callControlId) {
        console.log("🛑 Caller interrupted TTS playback, stopping speech");
        isTtsPlaying = false;
        try {
          await stopSpeaking(callContext.callControlId);
        } catch (stopError) {
          console.warn("⚠️ Error stopping TTS on interrupt:", stopError);
        }

        // Clear the debounce timer to restart with new transcript
        if (callContext.ttsDebounceTimer) {
          clearTimeout(callContext.ttsDebounceTimer);
          callContext.ttsDebounceTimer = undefined;
        }
      }

      // Queue the transcript with debounce
      queueUserTranscript(callContext, userText, ws, (isPlaying) => {
        isTtsPlaying = isPlaying;
      });
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
        const audio = Buffer.from(msg.media.payload, "base64");
        // Only log packet details if LOG_AUDIO_PACKETS is enabled (reduces noise in logs)
        if (process.env.LOG_AUDIO_PACKETS === "true") {
          console.log("🎙️ Received Telnyx media packet, bytes:", audio.length);
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
