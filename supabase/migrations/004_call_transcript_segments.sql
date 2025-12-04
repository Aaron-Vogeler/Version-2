-- Migration 004: Add call_transcript_segments table
-- Insert-only table for robust transcript logging
-- Each segment represents a final spoken utterance from either caller or assistant

-- ============================================================================
-- CALL_TRANSCRIPT_SEGMENTS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.call_transcript_segments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id TEXT NOT NULL REFERENCES public.calls(id) ON DELETE CASCADE,
  -- Speaker: 'caller' for human, 'assistant' for AI
  speaker TEXT NOT NULL CHECK (speaker IN ('caller', 'assistant')),
  -- Track: 'inbound' for caller audio, 'outbound' for AI/TTS audio
  track TEXT NOT NULL CHECK (track IN ('inbound', 'outbound')),
  -- The actual spoken text (max 2000 chars enforced by application)
  text TEXT NOT NULL,
  -- Deepgram confidence score (0.0 to 1.0)
  confidence NUMERIC(4, 3) CHECK (confidence >= 0 AND confidence <= 1),
  -- Timestamp when the segment was created (for ordering)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient queries
-- Primary access pattern: fetch all segments for a call in order
CREATE INDEX idx_transcript_segments_call_id
  ON public.call_transcript_segments(call_id, created_at ASC);

-- Secondary: filter by speaker type
CREATE INDEX idx_transcript_segments_speaker
  ON public.call_transcript_segments(call_id, speaker);

-- Enable RLS
ALTER TABLE public.call_transcript_segments ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Service role can manage all segments (insert from AI server)
CREATE POLICY "Service role can manage transcript segments"
  ON public.call_transcript_segments
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- RLS Policy: Users can view segments for calls they can access
-- This relies on the call being visible to the user
CREATE POLICY "Users can view segments for accessible calls"
  ON public.call_transcript_segments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.calls c
      WHERE c.id = call_transcript_segments.call_id
      AND c.tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::UUID
    )
  );

-- Grant permissions
GRANT ALL ON public.call_transcript_segments TO anon, authenticated, service_role;

-- Add to realtime publication (for potential real-time transcript updates)
ALTER PUBLICATION supabase_realtime ADD TABLE public.call_transcript_segments;

-- ============================================================================
-- ADD live_transcript COLUMN TO CALLS TABLE (if not exists)
-- ============================================================================
-- This column stores the real-time human-only transcript for browser display
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'calls'
    AND column_name = 'live_transcript'
  ) THEN
    ALTER TABLE public.calls ADD COLUMN live_transcript TEXT;
  END IF;
END
$$;

-- ============================================================================
-- FUNCTION: Aggregate transcript segments into readable text
-- ============================================================================
-- Helper function to generate a full transcript from segments
CREATE OR REPLACE FUNCTION public.get_call_transcript(p_call_id TEXT, p_speaker_filter TEXT DEFAULT NULL)
RETURNS TEXT AS $$
DECLARE
  v_transcript TEXT := '';
BEGIN
  SELECT string_agg(text, ' ' ORDER BY created_at ASC)
  INTO v_transcript
  FROM public.call_transcript_segments
  WHERE call_id = p_call_id
  AND (p_speaker_filter IS NULL OR speaker = p_speaker_filter);

  RETURN COALESCE(v_transcript, '');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get human-only transcript (caller segments only)
CREATE OR REPLACE FUNCTION public.get_human_transcript(p_call_id TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN public.get_call_transcript(p_call_id, 'caller');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions on functions
GRANT EXECUTE ON FUNCTION public.get_call_transcript(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_human_transcript(TEXT) TO anon, authenticated, service_role;
