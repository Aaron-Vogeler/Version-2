-- Migration to add delegate_call_settings JSONB column to profiles table
-- Stores delegate call configuration (goal, context, number_to_call) for quick call delegation

-- Add delegate_call_settings column to profiles table
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS delegate_call_settings JSONB DEFAULT '{}'::JSONB;

-- Add comment to describe the column
COMMENT ON COLUMN public.profiles.delegate_call_settings IS 'Stores user delegate call configuration including saved goal, context, and phone number for quick call delegation';

-- Example structure of delegate_call_settings:
-- {
--   "goal": "Schedule a meeting with the client",
--   "context": "Client is available Monday-Wednesday, prefers morning calls",
--   "numberToCall": "+14155551234"
-- }
