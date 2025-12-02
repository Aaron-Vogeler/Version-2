import express from "express";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import axios from "axios";
import config from "./config";
import outboundCallRouter from "./routes/outbound-call";
import { downsample24kHzTo8kHz, pcmToMulaw, chunkAudio } from "./pipeline/audio";
import { createDeepgramClient } from "./pipeline/stt";
import { generateAssistantReply, type CallContext } from "./pipeline/llm";
import { synthesizeSpeech } from "./pipeline/tts";

// Constants
const TTS_DEBOUNCE_MS = 2000; // 2 seconds of silence before responding

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
 */
function queueUserTranscript(
  callContext: CallContext,
  transcript: string,
  ws: WebSocket
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
    scheduleTtsResponse(callContext, ws);
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

    // Send to TTS only if we can still speak
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
 * Send the AI response as speech via OpenAI TTS.
 */
async function sendTtsResponse(
  callContext: CallContext,
  ws: WebSocket,
  aiText: string
): Promise<void> {
  // Double-check we can still speak before calling TTS API
  if (!canSpeak(callContext, ws)) {
    console.log("⚠️ Call ended or WebSocket closed, skipping TTS API call");
    return;
  }

  console.log("🔊 Converting to speech with OpenAI TTS...");
  let audioBuffer24k: Buffer;
  try {
    audioBuffer24k = await synthesizeSpeech(aiText);
    console.log("🔊 Synthesized audio");
  } catch (ttsError) {
    console.error(
      "❌ OpenAI error:",
      ttsError instanceof Error ? ttsError.message : ttsError
    );
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

  // Downsample from 24kHz to 8kHz to match Telnyx native format
  const audioBuffer8k = downsample24kHzTo8kHz(audioBuffer24k);
  console.log("📉 Downsampled to 8kHz, size:", audioBuffer8k.length, "bytes");

  // Convert from 16-bit linear PCM to 8-bit mulaw (PCMU) for Telnyx
  const mulawBuffer = pcmToMulaw(audioBuffer8k);
  console.log("🔄 Converted to mulaw, size:", mulawBuffer.length, "bytes");

  // Chunk audio into 20ms packets for proper Telnyx streaming
  const audioChunks = chunkAudio(mulawBuffer);

  // Send audio chunks to Telnyx with proper timing (20ms per chunk)
  if (canSpeak(callContext, ws)) {
    for (let i = 0; i < audioChunks.length; i++) {
      const chunk = audioChunks[i];

      // Delay each chunk by 20ms to match audio playback timing
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // Check if call is still active before sending
      if (!canSpeak(callContext, ws)) {
        console.log("⚠️ Call ended while sending audio, stopped at chunk", i + 1);
        break;
      }

      ws.send(
        JSON.stringify({
          event: "media",
          media: {
            payload: chunk.toString("base64"),
          },
        })
      );
    }
    console.log("✅ All audio chunks sent to Telnyx");
  } else {
    console.log("⚠️ WebSocket not open, cannot send audio");
  }
}

/**
 * Cleanup call state (clear timers, mark as inactive, close Deepgram connection).
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
}

// -----------------------------------------------------------------------------
// APP + SERVER
// -----------------------------------------------------------------------------
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

// HELPER: Generate a WAV file header for 8kHz mono 16-bit PCM
function generateWavHeader(pcmDataLength: number): Buffer {
  const sampleRate = 8000;
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

// DEBUG ENDPOINT: Listen to downsampled 8kHz PCM as WAV
app.get("/debug/tts-8k-wav", async (req, res) => {
  try {
    const text = (req.query.text as string) || "Hello, this is a test of the AI phone agent.";
    console.log("🎵 Debug TTS endpoint called with text:", text);

    // Get 24kHz PCM from OpenAI TTS
    const pcm24k = await synthesizeSpeech(text);
    console.log("✓ OpenAI TTS returned:", pcm24k.length, "bytes at 24kHz");

    // Downsample to 8kHz
    const pcm8k = downsample24kHzTo8kHz(pcm24k);
    console.log("✓ Downsampled to 8kHz:", pcm8k.length, "bytes");

    // Generate WAV header
    const wavHeader = generateWavHeader(pcm8k.length);

    // Combine header + PCM data
    const wavFile = Buffer.concat([wavHeader, pcm8k]);
    console.log("✓ WAV file generated:", wavFile.length, "bytes total");

    // Send as audio/wav
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", wavFile.length);
    res.send(wavFile);
  } catch (error) {
    console.error("❌ Debug TTS endpoint error:", error instanceof Error ? error.message : error);
    res.status(500).json({
      error: "Failed to generate TTS audio",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});


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

  // Create a Deepgram live stream
  const dgLive = await deepgram.listen.live({
    model: config.deepgram.model,
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    endpointing: 100,
  });

  console.log("🎧 Deepgram stream started");

  // Relay Deepgram transcript → Groq → Telnyx (with 2-second silence debounce)
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

      // Log raw transcript only if call is active
      console.log("📝 Deepgram raw transcript:", results?.transcript);

      if (!results || !results.transcript) return;

      const userText = results.transcript.trim();
      if (!userText) return;

      console.log("🗣️ User:", userText);

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

          callContext = {
            callControlId,
            streamId,
            goal: decoded.goal,
            userId: decoded.userId,
            initiatedAt: decoded.initiatedAt,
            isCallActive: true, // Mark call as active
            lastUserTranscript: "",
            lastTranscriptAt: 0,
            deepgramSocket: dgLive, // Store Deepgram connection for cleanup
          };

          console.log("📋 Call context initialized:", callContext);
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
