-- Migration: Add LLM Exchanges Table
-- Purpose: Store Groq LLM input/output for real-time debugging in dashboard

-- Create the llm_exchanges table
CREATE TABLE IF NOT EXISTS public.call_llm_exchanges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id TEXT NOT NULL REFERENCES public.calls(id) ON DELETE CASCADE,

  -- Request parameters
  model TEXT NOT NULL,
  temperature NUMERIC(3,2),
  max_tokens INTEGER,
  top_p NUMERIC(3,2),
  frequency_penalty NUMERIC(3,2),
  presence_penalty NUMERIC(3,2),
  stop_sequences TEXT[],

  -- Messages (stored as JSONB for flexibility)
  messages JSONB NOT NULL,

  -- Response data
  response_text TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  finish_reason TEXT,
  duration_ms INTEGER,

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for efficient querying by call_id
CREATE INDEX IF NOT EXISTS idx_call_llm_exchanges_call_id ON public.call_llm_exchanges(call_id);
CREATE INDEX IF NOT EXISTS idx_call_llm_exchanges_created_at ON public.call_llm_exchanges(created_at DESC);

-- Enable Row Level Security
ALTER TABLE public.call_llm_exchanges ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only see exchanges for their own calls
CREATE POLICY "Users can view their own call LLM exchanges"
  ON public.call_llm_exchanges
  FOR SELECT
  USING (
    call_id IN (
      SELECT id FROM public.calls WHERE user_id = auth.uid()::text
    )
  );

-- Enable Realtime for this table
ALTER PUBLICATION supabase_realtime ADD TABLE public.call_llm_exchanges;

-- Add comment for documentation
COMMENT ON TABLE public.call_llm_exchanges IS 'Stores LLM request/response exchanges for real-time debugging';
