/**
 * Secure API proxy for delegating calls to Fly.io AI server
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
    const { goal, to_number, assistant_name } = req.body;

    if (!goal || !to_number) {
      return res.status(400).json({ error: 'Missing required fields: goal and to_number' });
    }

    // Extract user ID from NextAuth session
    // session.user.id is set in the jwt callback of [...nextauth].ts
    const userId = (session.user as any).id;
    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in session' });
    }

    // Forward request to Fly.io AI server
    const flyUrl = 'https://version-2-cr4fsa.fly.dev/api/outbound-call';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const flyResponse = await fetch(flyUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        goal,
        toNumber: to_number,
        userId,
        assistantName: assistant_name || 'Ferguson',
      }),
    });

    // Get response body
    const responseData = await flyResponse.json().catch(() => ({}));

    // If Fly.io returns an error, forward that status + message
    if (!flyResponse.ok) {
      return res.status(flyResponse.status).json(responseData);
    }

    // If successful, return status ok with fly response
    return res.status(200).json({
      status: 'ok',
      flyResponse: responseData,
    });
  } catch (error: any) {
    console.error('Delegate API error:', error);
    return res.status(500).json({
      error: 'Failed to delegate call',
      message: error.message
    });
  }
}
