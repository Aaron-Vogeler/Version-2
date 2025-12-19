/**
 * API route to speak text into an active call via Telnyx TTS
 * Used for Manual Mode to let the user type what the AI should say
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/../pages/api/auth/[...nextauth]';

export async function POST(request: NextRequest) {
  console.log('[Manual TTS API] Request received');

  try {
    // 1. Check Authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      console.log('[Manual TTS API] Unauthorized - no session');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Validate Request
    const body = await request.json();
    const { call_control_id, text, voice_id } = body;

    console.log('[Manual TTS API] Request body:', { call_control_id, text: text?.substring(0, 50) + '...', voice_id });

    if (!call_control_id) {
      return NextResponse.json({ error: 'Missing call_control_id' }, { status: 400 });
    }

    if (!text || text.trim().length === 0) {
      return NextResponse.json({ error: 'Missing or empty text' }, { status: 400 });
    }

    if (!process.env.TELNYX_API_KEY) {
      console.error('[Manual TTS API] TELNYX_API_KEY is not set');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    // 3. Call Telnyx API to speak text using TTS
    // Use the same format as the backend (ai-server/src/pipeline/tts.ts)
    const telnyxUrl = `https://api.telnyx.com/v2/calls/${call_control_id}/actions/speak`;
    console.log('[Manual TTS API] Calling Telnyx:', telnyxUrl);

    // Default voice matches the backend config default
    const effectiveVoice = voice_id || 'Telnyx.KokoroTTS.af_nicole';

    const speakPayload = {
      payload: text.trim(),
      voice: effectiveVoice,
    };

    console.log('[Manual TTS API] Speak payload:', { ...speakPayload, payload: speakPayload.payload.substring(0, 50) + '...' });

    const response = await fetch(telnyxUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(speakPayload),
    });

    const responseText = await response.text();
    console.log('[Manual TTS API] Telnyx response status:', response.status);
    console.log('[Manual TTS API] Telnyx response body:', responseText);

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

      console.error('[Manual TTS API] Telnyx error:', errorData);
      return NextResponse.json(
        { error: 'Failed to speak text', details: errorData },
        { status: response.status }
      );
    }

    console.log('[Manual TTS API] TTS started successfully');
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[Manual TTS API] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error.message },
      { status: 500 }
    );
  }
}
