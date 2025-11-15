/**
 * Secure API proxy for delegating calls to Cloudflare Worker
 * Requires authentication via NextAuth
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from './auth/[...nextauth]';

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
    // Validate request body
    const { goal, to_number } = req.body;

    if (!goal || !to_number) {
      return res.status(400).json({ error: 'Missing required fields: goal and to_number' });
    }

    // Extract user ID from NextAuth session
    // session.user.id is set in the jwt callback of [...nextauth].ts
    const userId = (session.user as any).id;
    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in session' });
    }

    // Forward request to Cloudflare Worker
    const workerUrl = 'https://telnyx-webhook.aaronmvogeler.workers.dev/start-call';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Optional: Add worker authentication token if configured
    if (process.env.WORKER_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.WORKER_TOKEN}`;
    }

    const workerResponse = await fetch(workerUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        goal,
        to_number,
        // IMPORTANT: Send the authenticated user's ID to the Worker
        user_id: userId,
      }),
    });

    // Get response body
    const responseData = await workerResponse.json().catch(() => ({}));

    // Return worker response with same status code
    return res.status(workerResponse.status).json(responseData);
  } catch (error: any) {
    console.error('Delegate API error:', error);
    return res.status(500).json({
      error: 'Failed to delegate call',
      message: error.message
    });
  }
}
