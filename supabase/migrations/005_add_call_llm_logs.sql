-- Migration: Add call_llm_logs table for live LLM input/output logging during calls
-- This enables real-time visibility into what the AI is "thinking" during phone calls

-- Create the call_llm_logs table (insert-only pattern for performance)
CREATE TABLE IF NOT EXISTS public.call_llm_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    call_id TEXT NOT NULL REFERENCES public.calls(id) ON DELETE CASCADE,

    -- Request info
    request_type TEXT NOT NULL DEFAULT 'chat', -- 'chat' or 'summary'
    model TEXT NOT NULL,
    temperature NUMERIC(3,2),
    max_tokens INTEGER,

    -- The actual LLM input/output
    system_prompt TEXT,
    messages JSONB NOT NULL, -- Array of {role, content} messages sent to LLM
    user_input TEXT, -- The specific user input that triggered this call

    -- Response
    assistant_response TEXT,

    -- Context info (for visibility)
    rolling_summary TEXT,
    recent_turns_count INTEGER DEFAULT 0,

    -- Usage metrics
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    latency_ms INTEGER,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Create index for fast lookup by call_id (most common query)
CREATE INDEX IF NOT EXISTS idx_call_llm_logs_call_id ON public.call_llm_logs(call_id);

-- Create index for time-based queries
CREATE INDEX IF NOT EXISTS idx_call_llm_logs_created_at ON public.call_llm_logs(created_at DESC);

-- Enable Row Level Security
ALTER TABLE public.call_llm_logs ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only view LLM logs for their own calls
CREATE POLICY "Users can view their own call LLM logs" ON public.call_llm_logs
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.calls
            WHERE calls.id = call_llm_logs.call_id
            AND calls.user_id = auth.uid()::text
        )
    );

-- Policy: Service role can insert (AI server uses service role key)
CREATE POLICY "Service role can insert LLM logs" ON public.call_llm_logs
    FOR INSERT
    WITH CHECK (true);

-- Enable realtime for this table so frontend can subscribe
ALTER PUBLICATION supabase_realtime ADD TABLE public.call_llm_logs;

-- Add comment for documentation
COMMENT ON TABLE public.call_llm_logs IS 'Stores LLM request/response logs for each call, enabling live visibility into AI behavior during phone calls';
