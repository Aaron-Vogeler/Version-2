/**
 * API route to update user's custom assistant name
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check authentication
  const session = await getServerSession(req, res, authOptions);

  if (!session || !session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { custom_assistant_name } = req.body;

    // Validate input
    if (custom_assistant_name && typeof custom_assistant_name !== 'string') {
      return res.status(400).json({ error: 'Invalid assistant name' });
    }

    // Truncate to reasonable length
    const truncatedName = custom_assistant_name
      ? custom_assistant_name.substring(0, 100)
      : null;

    const userId = (session.user as any).id;

    // Create Supabase client with service role key for admin access
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Update the profile
    const { error } = await supabase
      .from('profiles')
      .update({
        custom_assistant_name: truncatedName,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    if (error) {
      console.error('Error updating custom assistant name:', error);
      return res.status(500).json({ error: 'Failed to update assistant name' });
    }

    return res.status(200).json({
      success: true,
      custom_assistant_name: truncatedName
    });
  } catch (error: any) {
    console.error('Update assistant name error:', error);
    return res.status(500).json({
      error: 'Failed to update assistant name',
      message: error.message
    });
  }
}
