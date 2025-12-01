import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import OpenAI from "openai";

dotenv.config();

// -----------------------------------------------------------------------------
// ENV
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;

const DG_API_KEY = process.env.DEEPGRAM_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

if (!DG_API_KEY) throw new Error("Missing DEEPGRAM_API_KEY");
if (!GROQ_KEY) throw new Error("Missing GROQ_API_KEY");
if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");

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

// TELNYX WEBHOOKS (Call start/stop)
app.post("/webhooks/telnyx", (req, res) => {
  const eventType = req.body?.data?.event_type;
  console.log("📞 Telnyx webhook event:", eventType);
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
    const results = dgEvent.channel?.alternatives?.[0];

    if (!results || !results.transcript) return;

    const userText = results.transcript.trim();
    if (!userText) return;

    console.log("🗣️ User:", userText);

    // -------------------------
    // Ask Groq LLM
    // -------------------------
    const groqResp = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: "You are a helpful voice assistant." },
        { role: "user", content: userText },
      ],
    });

    const aiText = groqResp.choices[0].message.content;
    if (!aiText) {
      console.warn("⚠️ Groq returned empty response");
      return;
    }

    console.log("🤖 Groq:", aiText);

    // -------------------------
    // Convert text to speech using OpenAI TTS
    // -------------------------
    console.log("🔊 Converting to speech with OpenAI TTS...");
    const audioResponse = await openai.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: aiText,
      response_format: "pcm",
    });

    // Convert the response stream to a buffer
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
    console.log("✅ TTS complete, audio buffer size:", audioBuffer.length, "bytes");

    // -------------------------
    // Send synthesized speech → Telnyx
    // -------------------------
    ws.send(
      JSON.stringify({
        event: "playback",
        payload: {
          type: "media",
          payload: audioBuffer.toString("base64"),
          encoding: "pcm",
          sample_rate: 24000, // OpenAI TTS returns 24000 Hz PCM
        },
      })
    );
  });

  //-----------------------------
  // WebSocket MESSAGE HANDLER
  //-----------------------------
  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Telnyx media packets → Deepgram
    if (msg.event === "media" && msg.media?.payload) {
      const audio = Buffer.from(msg.media.payload, "base64");
      dgLive.send(new Uint8Array(audio).buffer);
    }

    if (msg.event === "start") {
      console.log("🎙️ Telnyx media stream started");
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
