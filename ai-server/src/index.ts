import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8080;

// HTTP Webhook for Call Control (Start/Stop events)
app.use(express.json());

app.post("/webhooks/telnyx", (req, res) => {
  const event = req.body;
  console.log("Received Telnyx Event:", event.data?.event_type);
  
  // You will handle call logic here later
  res.status(200).send("ok");
});

app.get("/health", (_, res) => res.status(200).send("Alive"));

// WebSocket for Audio Streaming (The "Ears" & "Mouth")
wss.on("connection", (ws) => {
  console.log("New Client Connected");

  ws.on("message", (message) => {
    const msg = JSON.parse(message.toString());
    
    // 1. Listen for "media" events (Audio from Telnyx)
    if (msg.event === "media") {
      // TODO: Send msg.media.payload to Deepgram
    }

    // 2. Listen for "start" event (Metadata)
    if (msg.event === "start") {
      console.log("Media Stream Started", msg.start);
    }
  });

  ws.on("close", () => console.log("Client Disconnected"));
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
