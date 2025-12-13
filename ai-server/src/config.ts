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

// Helper function to get optional integer environment variables
function getEnvInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

// =============================================================================
// VARIABLE KEYS (use these placeholders in prompts)
// =============================================================================
// {ASSISTANT_NAME} or ASSISTANT_NAME - Replaced with the assistant's name (default: "Ferguson")
// {USER_NAME} or USER_NAME - Replaced with the user's name (default: "Aaron")
// {GOAL} - Replaced with the call goal (in rolling summary prompt)
// {EXISTING_SUMMARY} - Replaced with existing summary (in rolling summary prompt)
// {TURNS_TEXT} - Replaced with new turns text (in rolling summary prompt)
// {MAX_TOKENS} - Replaced with max summary tokens hint (in rolling summary prompt)
// =============================================================================

// =============================================================================
// MULTI-INSTANCE SUPPORT (Upstash Redis)
// =============================================================================
// When running on multiple Fly.io instances, TTS state can become inconsistent
// because Telnyx webhooks (call.speak.started, call.speak.ended) can hit any instance.
//
// To enable multi-instance support, configure Upstash Redis:
// - UPSTASH_REDIS_REST_URL: Your Upstash Redis REST URL
// - UPSTASH_REDIS_REST_TOKEN: Your Upstash Redis REST token
//
// Without Redis, the app runs in single-instance mode. You may see warnings like:
// "[TTS] ⚠️ call.speak.ended for unknown callControlId" in multi-instance deployments.
// =============================================================================

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

  // =============================================================================
  // CALL CONTROL SETTINGS
  // =============================================================================
  callControl: {
    // TTS debounce - milliseconds of silence before AI responds (lower = faster response)
    ttsDebounceMs: getEnvInt("TTS_DEBOUNCE_MS", 500),
    // Barge-in cooldown - milliseconds between stop commands to prevent spam
    bargeInCooldownMs: getEnvInt("BARGE_IN_COOLDOWN_MS", 300),
    // Barge-in grace period - milliseconds after TTS starts before barge-in is enabled
    // This prevents echo from immediately cutting off the AI
    bargeInGracePeriodMs: getEnvInt("BARGE_IN_GRACE_PERIOD_MS", 800),
    // Caller utterance flush timeout - milliseconds to wait before flushing utterance
    callerUtteranceFlushMs: getEnvInt("CALLER_UTTERANCE_FLUSH_MS", 300),
    // Hangup delay after "Chow" - milliseconds to wait for TTS before hangup
    hangupDelayMs: getEnvInt("HANGUP_DELAY_MS", 2000),
    // Hold check-in interval - milliseconds to wait before AI checks in while on hold
    // Default: 30 seconds (30000ms). The AI will periodically say something like "Still here..." while waiting.
    holdCheckInIntervalMs: getEnvInt("HOLD_CHECK_IN_INTERVAL_MS", 30000),
    // Hold max check-ins - maximum number of times AI will check in before ending the call
    // Default: 5 check-ins (2.5 minutes of hold time at 30s intervals). After this, AI ends call.
    holdMaxCheckIns: getEnvInt("HOLD_MAX_CHECK_INS", 5),
  },

  // =============================================================================
  // IVR/PHONE TREE SETTINGS
  // =============================================================================
  ivr: {
    // IVR debounce - milliseconds of silence before responding to IVR (faster than human conversation)
    // IVR menus typically have short pauses between options, so respond quickly
    debounceMs: getEnvInt("IVR_DEBOUNCE_MS", 150),
    // IVR utterance flush - how quickly to finalize what the IVR said
    utteranceFlushMs: getEnvInt("IVR_UTTERANCE_FLUSH_MS", 200),
    // Minimum pause after sending DTMF before sending another (prevents double-presses)
    dtmfMinPauseMs: getEnvInt("IVR_DTMF_MIN_PAUSE_MS", 500),
    // DTMF tone duration in milliseconds
    dtmfDurationMs: getEnvInt("IVR_DTMF_DURATION_MS", 250),
    // Confidence threshold (0-1) for entering IVR mode automatically
    autoDetectThreshold: parseFloat(getEnv("IVR_AUTO_DETECT_THRESHOLD", "0.7")),
    // How long to wait for IVR response before re-sending DTMF (retry timeout)
    responseTimeoutMs: getEnvInt("IVR_RESPONSE_TIMEOUT_MS", 8000),
    // Maximum DTMF retries for same menu option
    maxDtmfRetries: getEnvInt("IVR_MAX_DTMF_RETRIES", 2),
    // Disable barge-in grace period in IVR mode (IVRs don't have echo issues)
    disableBargeInGracePeriod: getEnv("IVR_DISABLE_BARGE_IN_GRACE", "true") === "true",
  },

  // =============================================================================
  // CONTEXT MANAGEMENT SETTINGS
  // =============================================================================
  context: {
    // Maximum recent turns to keep in sliding window
    maxTurnsInWindow: getEnvInt("MAX_TURNS_IN_WINDOW", 12),
    // Update rolling summary after this many new turns
    summaryUpdateIntervalTurns: getEnvInt("SUMMARY_UPDATE_INTERVAL_TURNS", 6),
    // Approximate max tokens for rolling summary
    maxSummaryTokensHint: getEnvInt("MAX_SUMMARY_TOKENS_HINT", 300),
  },

  // =============================================================================
  // HUMAN DETECTION SETTINGS (IVR vs Human State Machine)
  // =============================================================================
  humanDetection: {
    // Non-speech duration to trigger utterance flush (ms) - from VAD
    utteranceFlushMs: getEnvInt("HUMAN_DETECTION_UTTERANCE_FLUSH_MS", 500),
    // Wait time for human receiver before AI responds (ms) - shorter for natural conversation
    humanWaitMs: getEnvInt("HUMAN_DETECTION_HUMAN_WAIT_MS", 1500),
    // Wait time for IVR/unsure receiver before AI responds (ms) - longer to avoid interrupting
    ivrWaitMs: getEnvInt("HUMAN_DETECTION_IVR_WAIT_MS", 3000),
    // Minimum utterances needed before first classification attempt
    minUtterancesForCheck: getEnvInt("HUMAN_DETECTION_MIN_UTTERANCES", 1),
    // Extended silence threshold for hold detection (ms)
    holdSilenceThresholdMs: getEnvInt("HUMAN_DETECTION_HOLD_SILENCE_MS", 5000),
    // Number of human turns required after hold to confirm human
    humanTurnsRequiredAfterHold: getEnvInt("HUMAN_DETECTION_HUMAN_TURNS_AFTER_HOLD", 1),
    // Maximum consecutive "unsure" classifications before defaulting to IVR behavior
    maxUnsureBeforeIvr: getEnvInt("HUMAN_DETECTION_MAX_UNSURE", 3),
    // Enable human detection state machine (set to false to use legacy detection)
    enabled: getEnv("HUMAN_DETECTION_ENABLED", "true") === "true",
  },

  // =============================================================================
  // LLM CONFIG
  // =============================================================================
  llm: {
    // SYSTEM PROMPT - No default! Must be provided via environment variable or call parameters.
    // Use {ASSISTANT_NAME} and {USER_NAME} as placeholders that will be replaced.
    systemPrompt: getEnv("LLM_SYSTEM_PROMPT", ""),

    // ROLLING SUMMARY PROMPT - Template for generating rolling summaries
    // Available placeholders: {EXISTING_SUMMARY}, {TURNS_TEXT}, {MAX_TOKENS}
    rollingSummaryPrompt: getEnv(
      "ROLLING_SUMMARY_PROMPT",
      `You are updating a rolling summary of a phone call between an AI assistant and a caller.

EXISTING SUMMARY (may be empty or partial):
{EXISTING_SUMMARY}

NEW TRANSCRIPT TURNS (since that summary was created):
{TURNS_TEXT}

Please return an UPDATED, CONCISE summary (max ~{MAX_TOKENS} tokens) that preserves:
- The caller's main goal(s)
- Key facts (names, dates, constraints, identifiers)
- Important decisions / outcomes so far
- Current status (who we're talking to, which department, on hold or not, etc.)
- Any critical context for continuing the conversation

Be concise and focus on what's most important to continue this call effectively.`
    ),

    // ROLLING SUMMARY SYSTEM MESSAGE
    rollingSummarySystemMessage: getEnv(
      "ROLLING_SUMMARY_SYSTEM_MESSAGE",
      "You are a concise call summary generator. Create summaries that preserve the most important context for continuing phone conversations."
    ),
  },

  // Call rate limiting
  callRatePerMinute: parseFloat(process.env.CALL_RATE_PER_MINUTE || "0.01"),
} as const;

// Export the config as a frozen object for type safety
export default Object.freeze(config);

// Export individual type for easier importing
export type Config = typeof config;
