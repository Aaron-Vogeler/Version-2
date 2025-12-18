-- Migration: Create gemini_prompt_cache table for explicit cache metadata
-- This table stores Gemini cache pointers shared across Fly.io instances

CREATE TABLE IF NOT EXISTS public.gemini_prompt_cache (
    prompt_version TEXT PRIMARY KEY,
    cache_name TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_error TEXT
);

-- Add comment for documentation
COMMENT ON TABLE public.gemini_prompt_cache IS 'Stores Gemini context caching metadata for shared cache pointers across instances';
COMMENT ON COLUMN public.gemini_prompt_cache.prompt_version IS 'Unique identifier for the system prompt version (e.g., ferguson-system-v1)';
COMMENT ON COLUMN public.gemini_prompt_cache.cache_name IS 'Gemini cache resource name returned by the API';
COMMENT ON COLUMN public.gemini_prompt_cache.expires_at IS 'Cache expiration timestamp from Gemini API';
COMMENT ON COLUMN public.gemini_prompt_cache.updated_at IS 'Last time this cache record was updated';
COMMENT ON COLUMN public.gemini_prompt_cache.last_error IS 'Last error message if cache creation failed';

-- Enable RLS but allow service role full access
ALTER TABLE public.gemini_prompt_cache ENABLE ROW LEVEL SECURITY;

-- Policy: Service role can do everything (no user-facing access needed)
CREATE POLICY "Service role full access" ON public.gemini_prompt_cache
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Index for faster lookups by prompt_version (already PK, but explicit for clarity)
-- Primary key already creates an index, so this is optional
-- CREATE INDEX IF NOT EXISTS idx_gemini_prompt_cache_version ON public.gemini_prompt_cache(prompt_version);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_gemini_prompt_cache_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_gemini_prompt_cache_updated_at
    BEFORE UPDATE ON public.gemini_prompt_cache
    FOR EACH ROW
    EXECUTE FUNCTION update_gemini_prompt_cache_updated_at();
