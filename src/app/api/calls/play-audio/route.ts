/**
 * API route to play audio into an active call via Telnyx
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
    const { call_control_id, audio_url } = body;

    if (!call_control_id) {
      return NextResponse.json({ error: 'Missing call_control_id' }, { status: 400 });
    }

    if (!audio_url) {
      return NextResponse.json({ error: 'Missing audio_url' }, { status: 400 });
    }

    if (!process.env.TELNYX_API_KEY) {
      console.error('TELNYX_API_KEY is not set');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    // 3. Call Telnyx API to play audio
    const response = await fetch(
      `https://api.telnyx.com/v2/calls/${call_control_id}/actions/play_audio_url`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audio_url: audio_url,
          // Play to both legs of the call so both parties hear it
          target_legs: 'both',
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      // 404 or 422 usually means call is already gone
      if (response.status === 404 || response.status === 422) {
        return NextResponse.json({ error: 'Call not found or already ended' }, { status: 404 });
      }

      console.error('Telnyx play_audio_url error:', errorData);
      return NextResponse.json(
        { error: 'Failed to play audio', details: errorData },
        { status: response.status }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Play audio API error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error.message },
      { status: 500 }
    );
  }
}
