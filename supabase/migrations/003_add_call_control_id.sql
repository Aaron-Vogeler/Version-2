-- Migration: Add call_control_id to calls table
-- This stores the Telnyx call_control_id needed for active call operations (hangup, transfer, etc.)

ALTER TABLE public.calls
ADD COLUMN IF NOT EXISTS call_control_id TEXT;

COMMENT ON COLUMN public.calls.call_control_id IS 'Telnyx call control ID used for active call operations like hangup';

-- Create an index for faster lookups by call_control_id
CREATE INDEX IF NOT EXISTS idx_calls_call_control_id ON public.calls(call_control_id);
