/**
 * API route to update user's delegate call settings
 * Saves goal, context, and phone number for quick call delegation
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Define the shape of delegate call settings
interface DelegateCallSettings {
  goal?: string;
  context?: string;
  numberToCall?: string;
}

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
    const delegateCallSettings: DelegateCallSettings = req.body;

    // Validate input is an object
    if (!delegateCallSettings || typeof delegateCallSettings !== 'object') {
      return res.status(400).json({ error: 'Invalid settings format' });
    }

    // Sanitize and validate settings
    const sanitizedSettings: DelegateCallSettings = {};

    // Goal (string, max 250 chars)
    if (delegateCallSettings.goal !== undefined) {
      if (typeof delegateCallSettings.goal !== 'string') {
        return res.status(400).json({ error: 'Invalid goal format' });
      }
      sanitizedSettings.goal = delegateCallSettings.goal.substring(0, 250);
    }

    // Context (string, max 500 chars)
    if (delegateCallSettings.context !== undefined) {
      if (typeof delegateCallSettings.context !== 'string') {
        return res.status(400).json({ error: 'Invalid context format' });
      }
      sanitizedSettings.context = delegateCallSettings.context.substring(0, 500);
    }

    // Number to call (string, E.164 format validation)
    if (delegateCallSettings.numberToCall !== undefined) {
      if (typeof delegateCallSettings.numberToCall !== 'string') {
        return res.status(400).json({ error: 'Invalid phone number format' });
      }
      // Basic E.164 validation: optional +, then 1-15 digits
      const phoneNumber = delegateCallSettings.numberToCall.trim();
      if (phoneNumber && !/^\+?[1-9]\d{1,14}$/.test(phoneNumber)) {
        return res.status(400).json({ error: 'Phone number must be in E.164 format (e.g., +14155551234)' });
      }
      sanitizedSettings.numberToCall = phoneNumber;
    }

    // Get user ID from session
    const userId = (session.user as any).id;
    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in session' });
    }

    // Initialize Supabase client
    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(500).json({ error: 'Supabase configuration missing' });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Update delegate_call_settings in profiles table
    const { error } = await supabase
      .from('profiles')
      .update({
        delegate_call_settings: sanitizedSettings,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);

    if (error) {
      console.error('Error updating delegate call settings:', error);
      return res.status(500).json({ error: 'Failed to save settings' });
    }

    return res.status(200).json({
      success: true,
      settings: sanitizedSettings,
    });
  } catch (error: any) {
    console.error('Delegate call settings API error:', error);
    return res.status(500).json({
      error: 'Failed to update settings',
      message: error.message,
    });
  }
}
