/**
 * API route for managing individual call templates
 * PUT - Update a template
 * DELETE - Delete a template
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
  // Check authentication
  const session = await getServerSession(req, res, authOptions);

  if (!session || !session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const userId = (session.user as any).id;
  if (!userId) {
    return res.status(401).json({ error: 'User ID not found in session' });
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Template ID is required' });
  }

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({ error: 'Supabase configuration missing' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // PUT - Update a template
  if (req.method === 'PUT') {
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

      // Update template (only if owned by user)
      const { data, error } = await supabase
        .from('call_templates')
        .update({
          name: sanitizedName,
          goal: sanitizedGoal,
          context: sanitizedContext,
          phone_number: sanitizedPhoneNumber,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) {
        console.error('Error updating call template:', error);
        return res.status(500).json({ error: 'Failed to update template' });
      }

      if (!data) {
        return res.status(404).json({ error: 'Template not found' });
      }

      return res.status(200).json({ template: data });
    } catch (error: any) {
      console.error('Call templates API error:', error);
      return res.status(500).json({ error: 'Failed to update template' });
    }
  }

  // DELETE - Delete a template
  if (req.method === 'DELETE') {
    try {
      const { error } = await supabase
        .from('call_templates')
        .delete()
        .eq('id', id)
        .eq('user_id', userId);

      if (error) {
        console.error('Error deleting call template:', error);
        return res.status(500).json({ error: 'Failed to delete template' });
      }

      return res.status(200).json({ success: true });
    } catch (error: any) {
      console.error('Call templates API error:', error);
      return res.status(500).json({ error: 'Failed to delete template' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
