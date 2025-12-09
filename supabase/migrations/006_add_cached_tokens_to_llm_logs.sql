-- Migration: Add cached_tokens column to call_llm_exchanges table for Groq prompt caching visibility
-- This enables tracking of prompt cache hits in the Live LLM Logs UI
-- Groq's prompt caching returns cached_tokens in usage.prompt_tokens_details.cached_tokens

-- Add cached_tokens column to existing call_llm_exchanges table
ALTER TABLE public.call_llm_exchanges ADD COLUMN IF NOT EXISTS cached_tokens INTEGER DEFAULT 0;

-- Add comment for documentation
COMMENT ON COLUMN public.call_llm_exchanges.cached_tokens IS 'Number of prompt tokens served from Groq cache (cost savings: 50% discount on cached tokens)';
