-- Migration to add call_templates table
-- Stores reusable call templates (goal, context, phone number) for quick call delegation

-- Create call_templates table
CREATE TABLE IF NOT EXISTS public.call_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  goal VARCHAR(250),
  context VARCHAR(500),
  phone_number VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add index for user_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_call_templates_user_id ON public.call_templates(user_id);

-- Add RLS policies
ALTER TABLE public.call_templates ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (for idempotent migration)
DROP POLICY IF EXISTS "Users can view own templates" ON public.call_templates;
DROP POLICY IF EXISTS "Users can insert own templates" ON public.call_templates;
DROP POLICY IF EXISTS "Users can update own templates" ON public.call_templates;
DROP POLICY IF EXISTS "Users can delete own templates" ON public.call_templates;

-- Users can only see their own templates
CREATE POLICY "Users can view own templates" ON public.call_templates
  FOR SELECT USING (auth.uid() = user_id);

-- Users can insert their own templates
CREATE POLICY "Users can insert own templates" ON public.call_templates
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update their own templates
CREATE POLICY "Users can update own templates" ON public.call_templates
  FOR UPDATE USING (auth.uid() = user_id);

-- Users can delete their own templates
CREATE POLICY "Users can delete own templates" ON public.call_templates
  FOR DELETE USING (auth.uid() = user_id);

-- Add comment
COMMENT ON TABLE public.call_templates IS 'Stores reusable call templates for quick call delegation';
