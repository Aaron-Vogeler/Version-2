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
      `Start the call with:
"Hi, my name is Merlin, and I am an AI assistant calling on behalf of Aaron."

Then immediately state your goal and work toward achieving it.

Follow these instructions:
{{goal}}

CONVERSATION RULES:
1) Be concise and natural. Stay focused on the goal - don't ask for unnecessary information.
2) If confronted with IVR menus, listen, then decisively press the correct DTMF option.
3) Once goal is achieved, confirm the final conclusion by saying "Just to confirm" [and then summarize what was achieved].
4) After your final conclusion confirmation, say "chow", then end the call.`
    ),
  },

  // Call rate limiting
  callRatePerMinute: parseFloat(process.env.CALL_RATE_PER_MINUTE || "0.01"),
} as const;

// Export the config as a frozen object for type safety
export default Object.freeze(config);

// Export individual type for easier importing
export type Config = typeof config;
