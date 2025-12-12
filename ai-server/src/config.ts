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
  // PARTY DETECTION SETTINGS (Human vs IVR/Robotic)
  // =============================================================================
  partyDetection: {
    // Enable automatic party detection at call start
    enabled: getEnv("PARTY_DETECTION_ENABLED", "true") === "true",
    // Temperature for party detection LLM call (low for consistency)
    temperature: parseFloat(getEnv("PARTY_DETECTION_TEMPERATURE", "0.1")),
    // Max tokens for party detection (only needs True/False)
    maxTokens: getEnvInt("PARTY_DETECTION_MAX_TOKENS", 10),
    // System prompt for party detection (can be customized)
    systemPrompt: getEnv("PARTY_DETECTION_SYSTEM_PROMPT", ""),
    // Minimum transcript length before attempting detection
    minTranscriptLength: getEnvInt("PARTY_DETECTION_MIN_TRANSCRIPT_LENGTH", 20),
  },

  // =============================================================================
  // AUDIO PROCESSING SETTINGS
  // =============================================================================
  audio: {
    // PCM amplitude threshold for silence detection (0-32768)
    silenceThreshold: getEnvInt("AUDIO_SILENCE_THRESHOLD", 3000),
    // Consecutive packets required to confirm state change (at 50 packets/sec)
    hysteresisPackets: getEnvInt("AUDIO_HYSTERESIS_PACKETS", 8),
    // Sample jump threshold to trigger smoothing (~40% of full scale)
    discontinuityThreshold: getEnvInt("AUDIO_DISCONTINUITY_THRESHOLD", 25000),
    // Fade length for discontinuities in samples (at 8kHz, 16 = 2ms)
    fadeSamples: getEnvInt("AUDIO_FADE_SAMPLES", 16),
    // Fade length for silence transitions in samples (at 8kHz, 32 = 4ms)
    silenceFadeSamples: getEnvInt("AUDIO_SILENCE_FADE_SAMPLES", 32),
    // Enable audio smoother debug logging
    debugSmoother: getEnv("DEBUG_AUDIO_SMOOTHER", "false") === "true",
  },

  // =============================================================================
  // SPEECH ESTIMATION SETTINGS
  // =============================================================================
  speech: {
    // Average speaking rate in words per second (for barge-in estimation)
    wordsPerSecond: parseFloat(getEnv("SPEECH_WORDS_PER_SECOND", "2.5")),
    // Minimum duration in seconds to consider speech meaningful
    minMeaningfulDuration: parseFloat(getEnv("SPEECH_MIN_MEANINGFUL_DURATION", "0.5")),
  },

  // =============================================================================
  // TRANSCRIPT SETTINGS
  // =============================================================================
  transcript: {
    // Deepgram endpointing - milliseconds before end-of-speech detection
    deepgramEndpointing: getEnvInt("DEEPGRAM_ENDPOINTING", 100),
    // Whether to append/accumulate transcript segments vs replace
    appendSegments: getEnv("TRANSCRIPT_APPEND_SEGMENTS", "true") === "true",
    // Enable VAD (Voice Activity Detection) events from Deepgram
    // Triggers SpeechStarted events for detecting when caller begins speaking
    vadEvents: getEnv("DEEPGRAM_VAD_EVENTS", "true") === "true",
    // Enable interim results from Deepgram
    // Provides partial transcriptions before speech is final (useful for faster barge-in)
    interimResults: getEnv("DEEPGRAM_INTERIM_RESULTS", "true") === "true",
  },

  // =============================================================================
  // AUDIO NORMALIZATION SETTINGS
  // =============================================================================
  audioNormalization: {
    // Target peak as percentage of full scale (0.0-1.0) for normalization
    // Higher values make audio louder but may cause clipping. Default: 0.85 (85%)
    targetPeakPercent: parseFloat(getEnv("AUDIO_NORM_TARGET_PEAK", "0.85")),
    // Minimum peak threshold before normalization kicks in (as % of target)
    // Audio below this level will be boosted. Default: 0.82 (82% of target = ~70% overall)
    minPeakThreshold: parseFloat(getEnv("AUDIO_NORM_MIN_THRESHOLD", "0.82")),
    // Maximum gain multiplier to prevent over-amplification of quiet audio
    maxGain: parseFloat(getEnv("AUDIO_NORM_MAX_GAIN", "3.0")),
    // Soft clipping threshold (absolute PCM value) - values above this get compressed
    softClipThreshold: getEnvInt("AUDIO_SOFT_CLIP_THRESHOLD", 28000),
    // Soft clipping compression factor - how much to compress excess above threshold
    softClipFactor: parseFloat(getEnv("AUDIO_SOFT_CLIP_FACTOR", "0.3")),
    // Minimum acceptable peak for pre-mulaw boost (below this, audio gets boosted)
    preMulawMinPeak: getEnvInt("AUDIO_PREMULAW_MIN_PEAK", 6500),
    // Target peak for pre-mulaw boost (what to boost quiet audio to)
    preMulawTargetPeak: getEnvInt("AUDIO_PREMULAW_TARGET_PEAK", 16000),
  },

  // =============================================================================
  // DOWNSAMPLING FILTER SETTINGS
  // =============================================================================
  downsampleFilter: {
    // FIR low-pass filter cutoff frequency in Hz (standard telephony: 3400 Hz)
    // Must be below Nyquist frequency (4000 Hz for 8kHz output) to prevent aliasing
    cutoffHz: getEnvInt("DOWNSAMPLE_CUTOFF_HZ", 3400),
    // Number of FIR filter taps (must be odd, higher = better quality but slower)
    numTaps: getEnvInt("DOWNSAMPLE_NUM_TAPS", 63),
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
    // Temperature for rolling summary generation (lower = more consistent)
    rollingSummaryTemperature: parseFloat(getEnv("ROLLING_SUMMARY_TEMPERATURE", "0.2")),
  },

  // Call rate limiting
  callRatePerMinute: parseFloat(process.env.CALL_RATE_PER_MINUTE || "0.01"),
} as const;

// Export the config as a frozen object for type safety
export default Object.freeze(config);

// Export individual type for easier importing
export type Config = typeof config;
