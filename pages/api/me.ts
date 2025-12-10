/**
 * Test endpoint to check authentication session
 * Returns current user info if authenticated
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from './auth/[...nextauth]';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Get session
  const session = await getServerSession(req, res, authOptions);

  if (!session || !session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Fetch custom_assistant_name, first_name, and groq_settings from profile
  const userId = (session.user as any).id;
  let customAssistantName = null;
  let firstName = null;
  let groqSettings = null;

  if (userId && supabaseUrl && supabaseServiceKey) {
    try {
      const supabase = createClient(supabaseUrl, supabaseServiceKey);
      const { data, error } = await supabase
        .from('profiles')
        .select('custom_assistant_name, first_name, groq_settings')
        .eq('user_id', userId)
        .single();

      if (!error && data) {
        customAssistantName = data.custom_assistant_name;
        firstName = data.first_name;
        groqSettings = data.groq_settings;
      }
    } catch (error) {
      console.error('Error fetching profile data:', error);
    }
  }

  // Return session info with custom_assistant_name, first_name, and groq_settings
  return res.status(200).json({
    ok: true,
    user: {
      ...session.user,
      custom_assistant_name: customAssistantName,
      first_name: firstName,
      groq_settings: groqSettings,
    },
  });
}
