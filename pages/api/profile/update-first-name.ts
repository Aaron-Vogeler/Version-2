/**
 * API route to update user's first name
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
    const { first_name } = req.body;

    // Validate input
    if (first_name && typeof first_name !== 'string') {
      return res.status(400).json({ error: 'Invalid first name' });
    }

    // Truncate to reasonable length
    const truncatedName = first_name
      ? first_name.substring(0, 50)
      : null;

    const userId = (session.user as any).id;

    // Create Supabase client with service role key for admin access
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Update the profile
    const { error } = await supabase
      .from('profiles')
      .update({
        first_name: truncatedName,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId);

    if (error) {
      console.error('Error updating first name:', error);
      return res.status(500).json({ error: 'Failed to update first name' });
    }

    return res.status(200).json({
      success: true,
      first_name: truncatedName
    });
  } catch (error: any) {
    console.error('Update first name error:', error);
    return res.status(500).json({
      error: 'Failed to update first name',
      message: error.message
    });
  }
}
