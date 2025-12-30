/**
 * API route for managing call templates
 * GET - List all templates for the user
 * POST - Create a new template
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../auth/[...nextauth]';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export interface CallTemplate {
  id: string;
  user_id: string;
  name: string;
  goal: string | null;
  context: string | null;
  phone_number: string | null;
  created_at: string;
  updated_at: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Check authentication
  const session = await getServerSession(req, res, authOptions);

  if (!session || !session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const userId = (session.user as any).id;
  if (!userId) {
    return res.status(401).json({ error: 'User ID not found in session' });
  }

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({ error: 'Supabase configuration missing' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // GET - List all templates
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('call_templates')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching call templates:', error);
        return res.status(500).json({ error: 'Failed to fetch templates' });
      }

      return res.status(200).json({ templates: data || [] });
    } catch (error: any) {
      console.error('Call templates API error:', error);
      return res.status(500).json({ error: 'Failed to fetch templates' });
    }
  }

  // POST - Create a new template
  if (req.method === 'POST') {
    try {
      const { name, goal, context, phone_number } = req.body;

      // Validate required fields
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Template name is required' });
      }

      // Sanitize inputs
      const sanitizedName = name.trim().substring(0, 100);
      const sanitizedGoal = goal ? String(goal).substring(0, 250) : null;
      const sanitizedContext = context ? String(context).substring(0, 500) : null;
      const sanitizedPhoneNumber = phone_number ? String(phone_number).trim().substring(0, 20) : null;

      // Validate phone number format if provided
      if (sanitizedPhoneNumber && !/^\+?[1-9]\d{1,14}$/.test(sanitizedPhoneNumber)) {
        return res.status(400).json({ error: 'Phone number must be in E.164 format' });
      }

      const { data, error } = await supabase
        .from('call_templates')
        .insert({
          user_id: userId,
          name: sanitizedName,
          goal: sanitizedGoal,
          context: sanitizedContext,
          phone_number: sanitizedPhoneNumber,
        })
        .select()
        .single();

      if (error) {
        console.error('Error creating call template:', error);
        return res.status(500).json({ error: 'Failed to create template' });
      }

      return res.status(201).json({ template: data });
    } catch (error: any) {
      console.error('Call templates API error:', error);
      return res.status(500).json({ error: 'Failed to create template' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
