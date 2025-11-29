import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8080;

app.get("/", (_, res) => res.send("AI Brain is Online 🧠"));

// Handle incoming Telnyx calls
wss.on("connection", (ws) => {
  console.log("📞 Telnyx Call Connected");

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    
    if (msg.event === "start") {
      console.log(`Call Started: ${msg.start.call_control_id}`);
    }
    
    if (msg.event === "media") {
      // Audio comes in here. We will send this to Deepgram later.
    }
  });

  ws.on("close", () => console.log("Call Disconnected"));
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
