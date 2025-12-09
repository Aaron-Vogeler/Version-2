/**
 * API route to play audio into an active call via Telnyx
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/../pages/api/auth/[...nextauth]';

export async function POST(request: NextRequest) {
  console.log('[Play Audio API] Request received');

  try {
    // 1. Check Authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      console.log('[Play Audio API] Unauthorized - no session');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Validate Request
    const body = await request.json();
    const { call_control_id, audio_url } = body;

    console.log('[Play Audio API] Request body:', { call_control_id, audio_url });

    if (!call_control_id) {
      return NextResponse.json({ error: 'Missing call_control_id' }, { status: 400 });
    }

    if (!audio_url) {
      return NextResponse.json({ error: 'Missing audio_url' }, { status: 400 });
    }

    if (!process.env.TELNYX_API_KEY) {
      console.error('[Play Audio API] TELNYX_API_KEY is not set');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    // 3. Call Telnyx API to play audio using playback_start
    const telnyxUrl = `https://api.telnyx.com/v2/calls/${call_control_id}/actions/playback_start`;
    console.log('[Play Audio API] Calling Telnyx:', telnyxUrl);

    const response = await fetch(telnyxUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: audio_url,
      }),
    });

    const responseText = await response.text();
    console.log('[Play Audio API] Telnyx response status:', response.status);
    console.log('[Play Audio API] Telnyx response body:', responseText);

    if (!response.ok) {
      let errorData = {};
      try {
        errorData = JSON.parse(responseText);
      } catch {
        errorData = { raw: responseText };
      }

      // 404 or 422 usually means call is already gone
      if (response.status === 404 || response.status === 422) {
        return NextResponse.json({ error: 'Call not found or already ended' }, { status: 404 });
      }

      console.error('[Play Audio API] Telnyx error:', errorData);
      return NextResponse.json(
        { error: 'Failed to play audio', details: errorData },
        { status: response.status }
      );
    }

    console.log('[Play Audio API] Audio playback started successfully');
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[Play Audio API] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error.message },
      { status: 500 }
    );
  }
}
