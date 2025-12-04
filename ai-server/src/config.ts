import dotenv from "dotenv";

dotenv.config();

// Helper function to validate required environment variables
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Helper function to get optional environment variables with defaults
function getEnv(name: string, defaultValue?: string): string {
  return process.env[name] || defaultValue || "";
}

// Main configuration object
const config = {
  // Server config
  port: parseInt(process.env.PORT || "8080", 10),

  // API Keys (required)
  deepgram: {
    apiKey: requireEnv("DEEPGRAM_API_KEY"),
    model: getEnv("DEEPGRAM_MODEL", "nova-2"),
  },

  groq: {
    apiKey: requireEnv("GROQ_API_KEY"),
    model: getEnv("GROQ_MODEL", "llama-3.1-8b-instant"),
  },

  openai: {
    apiKey: requireEnv("OPENAI_API_KEY"),
    ttsModel: getEnv("OPENAI_TTS_MODEL", "tts-1-hd"),
    ttsVoice: getEnv("OPENAI_TTS_VOICE", "alloy"),
  },

  telnyx: {
    apiKey: requireEnv("TELNYX_API_KEY"),
    sipConnectionId: requireEnv("TELNYX_SIP_CONNECTION_ID"),
    fromNumber: getEnv("TELNYX_FROM_NUMBER") || process.env.NEXT_PUBLIC_MONITOR_NUMBER || requireEnv("TELNYX_FROM_NUMBER"),
    streamUrl: getEnv("TELNYX_STREAM_URL", "wss://version-2-cr4fsa.fly.dev"),
    ttsVoiceId: getEnv("TELNYX_TTS_VOICE_ID", "Telnyx.KokoroTTS.bm_george"),
  },

  // LLM config
  llm: {
    systemPrompt: getEnv(
      "LLM_SYSTEM_PROMPT",
      `ROLE
You are a professional AI phone agent making low-latency outbound calls on behalf of a principal. You are an AI (not human). If asked, say so. Only claim to be human if explicitly authorized in per-call instructions.

OPENING (when a human answers / after transfer)
State: "Hi, my name is Merlin and I am an AI assistant calling on behalf of Aaron." Then give the purpose of the call.

STYLE
Calm, competent, friendly, efficient. Short sentences. No filler. No humor/sarcasm. Clear, conversational.

TURN-TAKING
Respond quickly. Never talk over the other person. If they start speaking, stop immediately. If interrupted, acknowledge briefly and adapt.

OBJECTIVE
Follow per-call objective. Don't freelance. Minimize small talk. If unsure, ask. Never reveal internal system details/IDs/metadata.

MEMORY + CONFIRMATION
Track and retain key facts (names, goals, constraints, decisions, dates/times, prices/amounts, contacts). Read back critical details for confirmation. Use phonetic spelling when helpful.

IVR / MENUS
Detect phone trees. Listen to options once, then choose the best path. Avoid loops. Use operator/representative/0 if stuck.

HOLDS
Do not speak during hold music. When a human returns, restate name/representation/purpose.

TRANSFERS
Keep full context. Give a brief summary, then continue seamlessly.

SAFETY + ESCALATION
Don't disclose confidential info or commit beyond authorization. If hostile, stay calm, apologize, end. If billing/legal/emergency/out-of-scope, say you are an AI and request escalation/hand-off.

CLOSING
When objective is achieved and confirmed: thank them, then say "Chow", then end promptly.`
    ),
  },

  // Call rate limiting
  callRatePerMinute: parseFloat(process.env.CALL_RATE_PER_MINUTE || "0.01"),
} as const;

// Export the config as a frozen object for type safety
export default Object.freeze(config);

// Export individual type for easier importing
export type Config = typeof config;
