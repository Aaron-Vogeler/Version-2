/**
 * API proxy for fetching Groq LLM logs from the AI server
 * Requires authentication via NextAuth
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from './auth/[...nextauth]';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check authentication
  const session = await getServerSession(req, res, authOptions);

  if (!session || !session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Forward request to Fly.io AI server
    const flyUrl = 'https://version-2-cr4fsa.fly.dev/api/groq-logs';

    const flyResponse = await fetch(flyUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Get response body
    const responseData = await flyResponse.json().catch(() => ({}));

    // If Fly.io returns an error, forward that status + message
    if (!flyResponse.ok) {
      return res.status(flyResponse.status).json(responseData);
    }

    // If successful, return the data
    return res.status(200).json(responseData);
  } catch (error: any) {
    console.error('Groq logs API error:', error);
    return res.status(500).json({
      error: 'Failed to fetch Groq logs',
      message: error.message
    });
  }
}
