import express from "express";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import axios from "axios";
import config from "./config";
import outboundCallRouter from "./routes/outbound-call";
import { downsample24kHzTo8kHz, pcmToMulaw, chunkAudio, normalizePcm, boostBeforeMulaw } from "./pipeline/audio";
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
  const pipelineStartTime = Date.now();
  console.log("");
  console.log("🎵 ========================================");
  console.log("🎵 STARTING FULL TTS AUDIO PIPELINE");
  console.log("🎵 ========================================");

  // Double-check we can still speak before calling TTS API
  if (!canSpeak(callContext, ws)) {
    console.log("⚠️ Call ended or WebSocket closed, skipping TTS API call");
    return;
  }

  // Step 1: TTS Synthesis
  let audioBuffer24k: Buffer;
  try {
    audioBuffer24k = await synthesizeSpeech(aiText);
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

  // Print debug links for audio quality testing
  const textForUrl = encodeURIComponent(aiText);
  const baseUrl = config.telnyx.streamUrl.replace('wss://', 'https://');
  console.log("");
  console.log("🎧 ========== DEBUG AUDIO FILES ==========");
  console.log("📥 Download these files to test audio quality:");
  console.log(`   1️⃣  Raw 24kHz: ${baseUrl}/debug/tts-raw-24k?text=${textForUrl}`);
  console.log(`   2️⃣  Normalized 24kHz: ${baseUrl}/debug/tts-normalized-24k?text=${textForUrl}`);
  console.log(`   3️⃣  Downsampled 8kHz: ${baseUrl}/debug/tts-8k-wav?text=${textForUrl}`);
  console.log(`   4️⃣  μ-law Encoded: ${baseUrl}/debug/tts-mulaw-raw?text=${textForUrl}`);
  console.log("==========================================");
  console.log("");

  // Step 2: Normalize audio (moderate, not aggressive)
  const normalizeStartTime = Date.now();
  const audioBuffer24kNormalized = normalizePcm(audioBuffer24k);

  // Step 3: Downsample from 24kHz to 8kHz (with correct 3400Hz cutoff)
  const downsampleStartTime = Date.now();
  const audioBuffer8k = downsample24kHzTo8kHz(audioBuffer24kNormalized);

  // Step 4: Gentle boost only if needed (not aggressive)
  const boostStartTime = Date.now();
  const audioBuffer8kBoosted = boostBeforeMulaw(audioBuffer8k);

  // Step 5: μ-law encoding (using corrected G.711 algorithm)
  const mulawStartTime = Date.now();
  const audioBuffer = pcmToMulaw(audioBuffer8kBoosted);

  // Step 6: Chunk audio into 20ms packets
  const chunkStartTime = Date.now();
  const audioChunks = chunkAudio(audioBuffer);

  // Step 7: Stream to Telnyx with precise timing
  const streamStartTime = Date.now();
  console.log("");
  console.log("📡 ========== STREAMING TO TELNYX ==========");
  console.log("📊 Streaming Info:");
  console.log("   • Total chunks to send:", audioChunks.length);
  console.log("   • Packet interval:", "20 ms");
  console.log("   • Expected streaming duration:", (audioChunks.length * 20), "ms");
  console.log("   • WebSocket state:", ws.readyState === WebSocket.OPEN ? "OPEN" : "CLOSED");

  // Send audio chunks to Telnyx with precise timing (20ms per chunk)
  // Using high-resolution timing to avoid jitter from setTimeout variance
  if (canSpeak(callContext, ws)) {
    let sentChunks = 0;
    const CHUNK_INTERVAL_MS = 20;
    const startTime = process.hrtime.bigint();
    
    for (let i = 0; i < audioChunks.length; i++) {
      const chunk = audioChunks[i];

      // Calculate when this chunk SHOULD be sent (based on start time)
      const targetTimeNs = BigInt(i * CHUNK_INTERVAL_MS) * BigInt(1_000_000);
      const elapsedNs = process.hrtime.bigint() - startTime;
      const waitNs = targetTimeNs - elapsedNs;
      
      // If we're behind schedule, send immediately; otherwise wait
      if (waitNs > BigInt(1_000_000)) { // More than 1ms to wait
        const waitMs = Number(waitNs / BigInt(1_000_000));
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      // Check if call is still active before sending
      if (!canSpeak(callContext, ws)) {
        console.log("⚠️ Call ended while sending audio, stopped at chunk", i + 1, "of", audioChunks.length);
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
      sentChunks++;

      // Log progress every 50 chunks (every 1 second)
      if (sentChunks % 50 === 0) {
        const actualElapsedMs = Number((process.hrtime.bigint() - startTime) / BigInt(1_000_000));
        const expectedMs = sentChunks * CHUNK_INTERVAL_MS;
        const drift = actualElapsedMs - expectedMs;
        console.log(`📤 Sent ${sentChunks}/${audioChunks.length} chunks | Drift: ${drift > 0 ? '+' : ''}${drift}ms`);
      }
    }

    const streamEndTime = Date.now();
    const actualStreamDuration = streamEndTime - streamStartTime;

    console.log("");
    console.log("✅ Streaming complete!");
    console.log("   • Chunks sent:", sentChunks, "of", audioChunks.length);
    console.log("   • Actual streaming time:", actualStreamDuration, "ms");
    console.log("   • Expected streaming time:", (audioChunks.length * 20), "ms");
    console.log("   • Timing accuracy:", ((actualStreamDuration / (audioChunks.length * 20)) * 100).toFixed(1) + "%");
    console.log("===========================================");

    // Overall pipeline summary
    console.log("");
    console.log("⏱️  ========== PIPELINE TIMING SUMMARY ==========");
    console.log("   • TTS Synthesis:", (normalizeStartTime - pipelineStartTime), "ms");
    console.log("   • Normalization:", (downsampleStartTime - normalizeStartTime), "ms");
    console.log("   • Downsampling:", (boostStartTime - downsampleStartTime), "ms");
    console.log("   • Pre-μlaw Check:", (mulawStartTime - boostStartTime), "ms");
    console.log("   • μ-law Encoding:", (chunkStartTime - mulawStartTime), "ms");
    console.log("   • Chunking:", (streamStartTime - chunkStartTime), "ms");
    console.log("   • Streaming:", actualStreamDuration, "ms");
    console.log("   • TOTAL PIPELINE:", (Date.now() - pipelineStartTime), "ms");
    console.log("===============================================");
    console.log("");
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

// DEBUG ENDPOINT: Listen to 24kHz RAW PCM (OpenAI TTS output)
app.get("/debug/tts-raw-24k", async (req, res) => {
  try {
    const text = (req.query.text as string) || "Hello, this is a test of the AI phone agent.";
    console.log("🎵 DEBUG ENDPOINT: /debug/tts-raw-24k (RAW OpenAI TTS output)");

    const pcm24k = await synthesizeSpeech(text);
    const wavHeader = generateWavHeader(pcm24k.length, 24000);
    const wavFile = Buffer.concat([wavHeader, pcm24k]);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Disposition", `inline; filename="tts-raw-24k-${Date.now()}.wav"`);
    res.send(wavFile);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// DEBUG ENDPOINT: 24kHz NORMALIZED PCM (before downsampling)
app.get("/debug/tts-normalized-24k", async (req, res) => {
  try {
    const text = (req.query.text as string) || "Hello, this is a test of the AI phone agent.";
    console.log("🎵 DEBUG ENDPOINT: /debug/tts-normalized-24k (normalized at 24kHz)");

    const pcm24k = await synthesizeSpeech(text);
    const pcm24kNormalized = normalizePcm(pcm24k);
    const wavHeader = generateWavHeader(pcm24kNormalized.length, 24000);
    const wavFile = Buffer.concat([wavHeader, pcm24kNormalized]);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Disposition", `inline; filename="tts-normalized-24k-${Date.now()}.wav"`);
    res.send(wavFile);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// DEBUG ENDPOINT: 8kHz PCM (downsampled, normalized, BEFORE μ-law)
app.get("/debug/tts-8k-wav", async (req, res) => {
  try {
    const text = (req.query.text as string) || "Hello, this is a test of the AI phone agent.";
    console.log("🎵 DEBUG ENDPOINT: /debug/tts-8k-wav (8kHz PCM, normalized, BEFORE μ-law)");

    const pcm24k = await synthesizeSpeech(text);
    const pcm24kNormalized = normalizePcm(pcm24k);
    const pcm8k = downsample24kHzTo8kHz(pcm24kNormalized);
    const pcm8kBoosted = boostBeforeMulaw(pcm8k);

    const wavHeader = generateWavHeader(pcm8kBoosted.length, 8000);
    const wavFile = Buffer.concat([wavHeader, pcm8kBoosted]);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Disposition", `inline; filename="tts-8k-${Date.now()}.wav"`);
    res.send(wavFile);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// DEBUG ENDPOINT: Raw μ-law bytes (decoded back to PCM for listening)
app.get("/debug/tts-mulaw-raw", async (req, res) => {
  try {
    const text = (req.query.text as string) || "Hello, this is a test of the AI phone agent.";
    console.log("🎵 DEBUG ENDPOINT: /debug/tts-mulaw-raw (μ-law decoded back to PCM)");

    const pcm24k = await synthesizeSpeech(text);
    const pcm24kNormalized = normalizePcm(pcm24k);
    const pcm8k = downsample24kHzTo8kHz(pcm24kNormalized);
    const pcm8kBoosted = boostBeforeMulaw(pcm8k);
    const mulawBuffer = pcmToMulaw(pcm8kBoosted);

    // Decode μ-law back to PCM using standard G.711 decoding
    const decodedPcm = new Int16Array(mulawBuffer.length);
    for (let i = 0; i < mulawBuffer.length; i++) {
      decodedPcm[i] = decodeMulawG711(mulawBuffer[i]);
    }

    const decodedBuffer = Buffer.from(decodedPcm.buffer, decodedPcm.byteOffset, decodedPcm.byteLength);
    const wavHeader = generateWavHeader(decodedBuffer.length, 8000);
    const wavFile = Buffer.concat([wavHeader, decodedBuffer]);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Disposition", `inline; filename="tts-mulaw-decoded-${Date.now()}.wav"`);
    res.send(wavFile);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

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
