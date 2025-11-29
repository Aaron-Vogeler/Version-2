/**
 * API route to hang up an active call
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/../pages/api/auth/[...nextauth]';

export async function POST(request: NextRequest) {
  try {
    // 1. Check Authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Validate Request
    const body = await request.json();
    const { call_control_id } = body;

    if (!call_control_id) {
      return NextResponse.json({ error: 'Missing call_control_id' }, { status: 400 });
    }

    if (!process.env.TELNYX_API_KEY) {
        console.error('TELNYX_API_KEY is not set');
        return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    // 3. Call Telnyx API to Hangup
    const response = await fetch(
      `https://api.telnyx.com/v2/calls/${call_control_id}/actions/hangup`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            // Optional: pass client state to track who ended it
            client_state: Buffer.from(JSON.stringify({
                ended_by_user_id: (session.user as any).id
            })).toString('base64')
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      // 404 or 422 usually means call is already gone, which we can treat as success or ignore
      if (response.status === 404 || response.status === 422) {
         return NextResponse.json({ success: true, message: 'Call already ended' });
      }
      
      console.error('Telnyx hangup error:', errorData);
      return NextResponse.json(
        { error: 'Failed to hangup call', details: errorData },
        { status: response.status }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Hangup API error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error.message },
      { status: 500 }
    );
  }
}
