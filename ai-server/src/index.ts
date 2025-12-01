import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import OpenAI from "openai";
import axios from "axios";
import outboundCallRouter from "./routes/outbound-call";

// Audio utility: downsample 24kHz PCM to 8kHz for Telnyx compatibility
function downsample24kHzTo8kHz(pcmBuffer: Buffer): Buffer {
  // OpenAI TTS returns 24kHz PCM (16-bit signed)
  // Telnyx expects 8kHz, so we downsample by taking every 3rd sample
  const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength / 2);
  const downsampledSamples = new Int16Array(Math.floor(samples.length / 3));

  for (let i = 0; i < downsampledSamples.length; i++) {
    downsampledSamples[i] = samples[i * 3];
  }

  return Buffer.from(downsampledSamples.buffer);
}

dotenv.config();

// -----------------------------------------------------------------------------
// ENV
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;

const DG_API_KEY = process.env.DEEPGRAM_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

if (!DG_API_KEY) throw new Error("Missing DEEPGRAM_API_KEY");
if (!GROQ_KEY) throw new Error("Missing GROQ_API_KEY");
if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!TELNYX_API_KEY) throw new Error("Missing TELNYX_API_KEY");

// -----------------------------------------------------------------------------
// CLIENTS
// -----------------------------------------------------------------------------
const deepgram = createClient(DG_API_KEY);

const groq = new OpenAI({
  apiKey: GROQ_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const openai = new OpenAI({
  apiKey: OPENAI_KEY,
});

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
    const callControlId = req.body?.data?.call_control_id;
    if (callControlId) {
      try {
        await axios.post(
          `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`,
          {
            stream_url: "wss://version-2-cr4fsa.fly.dev",
            stream_track: "inbound_track",
          },
          {
            headers: {
              Authorization: `Bearer ${TELNYX_API_KEY}`,
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

  // Create a Deepgram live stream
  const dgLive = await deepgram.listen.live({
    model: "nova-2",
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
      let groqResp;
      try {
        groqResp = await groq.chat.completions.create({
          model: "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: "You are a helpful voice assistant." },
            { role: "user", content: userText },
          ],
        });
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

      const aiText = groqResp.choices[0]?.message?.content;
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

      console.log("🤖 Groq:", aiText);

      // -------------------------
      // Convert text to speech using OpenAI TTS
      // -------------------------
      console.log("🔊 Converting to speech with OpenAI TTS...");
      let audioResponse;
      try {
        audioResponse = await openai.audio.speech.create({
          model: "tts-1",
          voice: "alloy",
          input: aiText,
          response_format: "pcm",
        });
      } catch (ttsError) {
        console.error("❌ OpenAI TTS error:", ttsError instanceof Error ? ttsError.message : ttsError);
        ws.send(
          JSON.stringify({
            event: "error",
            payload: { message: "Failed to generate speech audio" },
          })
        );
        return;
      }

      // Convert the response stream to a buffer
      const audioBuffer24k = Buffer.from(await audioResponse.arrayBuffer());
      console.log("✅ TTS complete, 24kHz audio buffer size:", audioBuffer24k.length, "bytes");

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
      // Telnyx media packets → Deepgram
      if (msg.event === "media" && msg.media?.payload) {
        const audio = Buffer.from(msg.media.payload, "base64");
        dgLive.send(audio.buffer);
      } else if (msg.event === "start") {
        console.log("🎙️ Telnyx media stream started");
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
server.listen(PORT, () => {
  console.log(`🚀 AI Server running on port ${PORT}`);
});
