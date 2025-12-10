-- Migration to add groq_settings JSONB column to profiles table
-- Stores all Groq call configuration for the user

-- Add groq_settings column to profiles table
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS groq_settings JSONB DEFAULT '{}'::JSONB;

-- Add comment to describe the column
COMMENT ON COLUMN public.profiles.groq_settings IS 'Stores user Groq call configuration including model, temperature, prompts, call control settings, etc.';

-- Example structure of groq_settings:
-- {
--   "model": "llama-3.1-8b-instant",
--   "temperature": 0.7,
--   "maxTokens": 1024,
--   "topP": 1,
--   "reasoning": "medium",
--   "stream": false,
--   "jsonMode": false,
--   "customSystemPrompt": "...",
--   "rollingSummaryPrompt": "...",
--   "callControlSettings": {
--     "ttsDebounceMs": 500,
--     "bargeInCooldownMs": 300,
--     "callerUtteranceFlushMs": 300,
--     "hangupDelayMs": 2000,
--     "holdCheckInIntervalMs": 30000,
--     "holdMaxCheckIns": 5
--   },
--   "ivrSettings": {
--     "debounceMs": 150,
--     "utteranceFlushMs": 200,
--     "dtmfMinPauseMs": 500,
--     "dtmfDurationMs": 250,
--     "autoDetectThreshold": 0.7,
--     "responseTimeoutMs": 8000,
--     "maxDtmfRetries": 2,
--     "disableBargeInGracePeriod": true
--   }
-- }
