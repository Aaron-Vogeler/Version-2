import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import axios from "axios";
import config from "./config";
import outboundCallRouter from "./routes/outbound-call";
import { downsample24kHzTo8kHz } from "./pipeline/audio";
import { createDeepgramClient } from "./pipeline/stt";
import { generateAssistantReply, type CallContext } from "./pipeline/llm";
import { synthesizeSpeech } from "./pipeline/tts";

// -----------------------------------------------------------------------------
// CLIENTS
// -----------------------------------------------------------------------------
const deepgram = createDeepgramClient();

// -----------------------------------------------------------------------------
// APP + SERVER
// -----------------------------------------------------------------------------
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

// HEALTH CHECK
app.get("/health", (_, res) => res.status(200).send("Alive"));

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
    const callControlId = req.body?.data?.call_control_id;
    if (callControlId) {
      try {
        await axios.post(
          `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`,
          {
            stream_url: config.telnyx.streamUrl,
            stream_track: "inbound_track",
          },
          {
            headers: {
              Authorization: `Bearer ${config.telnyx.apiKey}`,
            },
          }
        );
        console.log("✅ Streaming started for call:", callControlId);
      } catch (error) {
        console.error("❌ Failed to start streaming:", error instanceof Error ? error.message : error);
      }
    }
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

  // Relay Deepgram transcript → Groq → Telnyx
  dgLive.on(LiveTranscriptionEvents.Transcript, async (dgEvent: any) => {
    try {
      const results = dgEvent.channel?.alternatives?.[0];

      if (!results || !results.transcript) return;

      const userText = results.transcript.trim();
      if (!userText) return;

      console.log("🗣️ User:", userText);

      // -------------------------
      // Ask Groq LLM
      // -------------------------
      let aiText: string;
      try {
        aiText = await generateAssistantReply(userText, callContext);
      } catch (groqError) {
        console.error("❌ Groq API error:", groqError instanceof Error ? groqError.message : groqError);
        ws.send(
          JSON.stringify({
            event: "error",
            payload: { message: "Failed to process request with AI model" },
          })
        );
        return;
      }

      if (!aiText) {
        console.warn("⚠️ Groq returned empty response");
        ws.send(
          JSON.stringify({
            event: "error",
            payload: { message: "AI model returned empty response" },
          })
        );
        return;
      }

      console.log("🤖 AI:", aiText);

      // -------------------------
      // Convert text to speech using OpenAI TTS
      // -------------------------
      console.log("🔊 Converting to speech with OpenAI TTS...");
      let audioBuffer24k: Buffer;
      try {
        audioBuffer24k = await synthesizeSpeech(aiText);
        console.log("🔊 Synthesized audio");
      } catch (ttsError) {
        console.error("❌ OpenAI error:", ttsError instanceof Error ? ttsError.message : ttsError);
        ws.send(
          JSON.stringify({
            event: "error",
            payload: { message: "TTS synthesis failed" },
          })
        );
        return;
      }

      // Downsample from 24kHz to 8kHz to match Telnyx native format
      const audioBuffer8k = downsample24kHzTo8kHz(audioBuffer24k);
      console.log("📉 Downsampled to 8kHz, size:", audioBuffer8k.length, "bytes");

      // -------------------------
      // Send synthesized speech → Telnyx
      // -------------------------
      if (ws.readyState === ws.OPEN) {
        ws.send(
          JSON.stringify({
            event: "playback",
            payload: {
              type: "media",
              payload: audioBuffer8k.toString("base64"),
              encoding: "pcm",
              sample_rate: 8000, // Downsampled to 8kHz to match Telnyx format
            },
          })
        );
        console.log("🔊 Audio sent to Telnyx");
      } else {
        console.warn("⚠️ WebSocket not open, cannot send audio");
      }
    } catch (error) {
      console.error("❌ Unexpected error in transcript handler:", error instanceof Error ? error.message : error);
      if (ws.readyState === ws.OPEN) {
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
        dgLive.send(audio.buffer);
      } else if (msg.event === "stop") {
        console.log("🛑 Telnyx media stream stopped");
      }
    } catch (error) {
      console.error("❌ Error processing WebSocket message:", error instanceof Error ? error.message : error);
    }
  });

  ws.on("close", () => {
    console.log("🔌 Client disconnected");
    dgLive.finish();
  });
});

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------
server.listen(config.port, () => {
  console.log(`🚀 AI Server running on port ${config.port}`);
});
