-- Add first_name column to profiles table
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS first_name TEXT;

-- Create an index on first_name for faster queries
CREATE INDEX IF NOT EXISTS idx_profiles_first_name ON public.profiles(first_name);
