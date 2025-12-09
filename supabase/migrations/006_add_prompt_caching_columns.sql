-- Migration: Add prompt caching columns to call_llm_exchanges table
-- Groq API returns prompt caching data in the usage object:
-- - prompt_cache_hit_tokens: Number of tokens served from cache
-- - prompt_cache_miss_tokens: Number of tokens not served from cache

-- Add prompt caching columns
ALTER TABLE public.call_llm_exchanges ADD COLUMN IF NOT EXISTS cache_hit_tokens INTEGER DEFAULT 0;
ALTER TABLE public.call_llm_exchanges ADD COLUMN IF NOT EXISTS cache_miss_tokens INTEGER DEFAULT 0;

-- Add comments for documentation
COMMENT ON COLUMN public.call_llm_exchanges.cache_hit_tokens IS 'Number of prompt tokens served from Groq cache';
COMMENT ON COLUMN public.call_llm_exchanges.cache_miss_tokens IS 'Number of prompt tokens not in cache (had to be processed)';
