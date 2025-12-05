/**
 * API route for delegating calls to the AI server
 * Authenticates user and forwards to ai-server
 */

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/../pages/api/auth/[...nextauth]';

interface DelegateRequest {
  goal: string;
  to_number: string;
  assistant_name?: string;
}

export async function POST(request: NextRequest) {
  try {
    // 1) Get logged-in user from NextAuth
    const session = await getServerSession(authOptions);

    if (!session?.user || !(session.user as any).id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = (session.user as any).id as string;

    // 2) Parse request body
    const body = (await request.json()) as DelegateRequest;
    const { goal, to_number, assistant_name } = body;

    // Validate required fields
    if (!goal || !to_number) {
      return NextResponse.json(
        { error: 'Missing required fields: goal, to_number' },
        { status: 400 }
      );
    }

    // Validate E.164 format for phone number
    if (!/^\+?[1-9]\d{1,14}$/.test(to_number)) {
      return NextResponse.json(
        { error: 'Invalid phone number format. Use E.164 format (e.g., +14155551234)' },
        { status: 400 }
      );
    }

    // Get AI server URL from environment
    const aiServerUrl = process.env.AI_SERVER_URL;
    if (!aiServerUrl) {
      console.error('AI_SERVER_URL not configured');
      return NextResponse.json(
        { error: 'AI server not configured' },
        { status: 500 }
      );
    }

    // 3) Call the ai-server outbound-call endpoint
    const aiServerResponse = await fetch(`${aiServerUrl}/api/outbound-call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        goal,
        toNumber: to_number,
        userId,
        assistantName: assistant_name || 'Ferguson',
      }),
    });

    const aiServerData = await aiServerResponse.json();

    if (!aiServerResponse.ok) {
      return NextResponse.json(aiServerData, { status: aiServerResponse.status });
    }

    return NextResponse.json(aiServerData);
  } catch (error) {
    console.error('API /delegate error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
