-- Migration: Add columns to existing call_llm_exchanges table for enhanced LLM logging
-- This enables real-time visibility into what the AI is "thinking" during phone calls
-- Uses the existing call_llm_exchanges table that already has realtime enabled

-- Add new columns to existing call_llm_exchanges table for richer logging
ALTER TABLE public.call_llm_exchanges ADD COLUMN IF NOT EXISTS request_type TEXT DEFAULT 'chat';
ALTER TABLE public.call_llm_exchanges ADD COLUMN IF NOT EXISTS system_prompt TEXT;
ALTER TABLE public.call_llm_exchanges ADD COLUMN IF NOT EXISTS user_input TEXT;
ALTER TABLE public.call_llm_exchanges ADD COLUMN IF NOT EXISTS rolling_summary TEXT;
ALTER TABLE public.call_llm_exchanges ADD COLUMN IF NOT EXISTS recent_turns_count INTEGER DEFAULT 0;

-- Add comment for documentation
COMMENT ON COLUMN public.call_llm_exchanges.request_type IS 'Type of LLM request: chat or summary';
COMMENT ON COLUMN public.call_llm_exchanges.system_prompt IS 'The full system prompt sent to the LLM';
COMMENT ON COLUMN public.call_llm_exchanges.user_input IS 'The specific user input that triggered this LLM call';
COMMENT ON COLUMN public.call_llm_exchanges.rolling_summary IS 'The call summary at the time of this request';
COMMENT ON COLUMN public.call_llm_exchanges.recent_turns_count IS 'Number of recent conversation turns included in context';

-- Create indexes for better query performance if they don't exist
CREATE INDEX IF NOT EXISTS idx_call_llm_exchanges_call_id ON public.call_llm_exchanges(call_id);
CREATE INDEX IF NOT EXISTS idx_call_llm_exchanges_created_at ON public.call_llm_exchanges(created_at DESC);
