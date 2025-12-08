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

  telnyx: {
    apiKey: requireEnv("TELNYX_API_KEY"),
    sipConnectionId: requireEnv("TELNYX_SIP_CONNECTION_ID"),
    fromNumber: getEnv("TELNYX_FROM_NUMBER") || process.env.NEXT_PUBLIC_MONITOR_NUMBER || requireEnv("TELNYX_FROM_NUMBER"),
    streamUrl: getEnv("TELNYX_STREAM_URL", "wss://version-2-cr4fsa.fly.dev"),
    ttsVoiceId: getEnv("TELNYX_TTS_VOICE_ID", "Telnyx.KokoroTTS.bm_george"),
  },

  // Supabase config for call logging
  supabase: {
    url: getEnv("NEXT_PUBLIC_SUPABASE_URL"),
    serviceRoleKey: getEnv("SUPABASE_SERVICE_ROLE_KEY"),
  },

  // LLM config
  llm: {
    // System prompt is now REQUIRED - must be passed per call
    // This removes the default prompt to force explicit configuration
    systemPrompt: getEnv("LLM_SYSTEM_PROMPT", ""),

    // Rolling summary prompt template
    // Use placeholders: {existingSummary}, {turnsText}, {maxTokens}
    summaryPrompt: getEnv(
      "LLM_SUMMARY_PROMPT",
      `You are updating a rolling summary of a phone call between an AI assistant and a caller, and possibly multiple human agents.

EXISTING SUMMARY (may be empty or partial):
{existingSummary}

NEW TRANSCRIPT TURNS (since that summary was created):
{turnsText}

Please return an UPDATED, CONCISE summary (max ~{maxTokens} tokens) that preserves:
- The caller's main goal(s)
- Key facts (names, dates, constraints, identifiers)
- Important decisions / outcomes so far
- Current status (who we're talking to, which department, on hold or not, etc.)
- Any critical context for continuing the conversation

Be concise and focus on what's most important to continue this call effectively.`
    ),

    // Summary system message
    summarySystemMessage: getEnv(
      "LLM_SUMMARY_SYSTEM_MESSAGE",
      "You are a concise call summary generator. Create summaries that preserve the most important context for continuing phone conversations."
    ),

    // Variable keys for template replacement
    assistantVariableKey: getEnv("ASSISTANT_VARIABLE_KEY", "{{ASSISTANT_NAME}}"),
    userVariableKey: getEnv("USER_VARIABLE_KEY", "{{USER_NAME}}"),
  },

  // Call control settings
  callControl: {
    // How long the AI should wait after user stops speaking before responding (milliseconds)
    ttsDebounceMs: parseInt(process.env.TTS_DEBOUNCE_MS || "500", 10),

    // Words per second for speaking rate estimation (for barge-in)
    wordsPerSecond: parseFloat(process.env.WORDS_PER_SECOND || "2.5"),
  },

  // Call rate limiting
  callRatePerMinute: parseFloat(process.env.CALL_RATE_PER_MINUTE || "0.01"),
} as const;

// Export the config as a frozen object for type safety
export default Object.freeze(config);

// Export individual type for easier importing
export type Config = typeof config;
