/**
 * Telnyx Token Generation API Route
 * Generates on-demand credentials for WebRTC authentication
 */

import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { TELNYX_API_KEY, TELNYX_SIP_CONNECTION_ID } = process.env;

    // Validate required environment variables
    if (!TELNYX_API_KEY) {
      return NextResponse.json(
        { error: 'TELNYX_API_KEY is not configured' },
        { status: 500 }
      );
    }

    if (!TELNYX_SIP_CONNECTION_ID) {
      return NextResponse.json(
        { error: 'TELNYX_SIP_CONNECTION_ID is not configured' },
        { status: 500 }
      );
    }

    // Make request to Telnyx API to generate token
    const tokenUrl = `https://api.telnyx.com/v2/telephony_credentials/${TELNYX_SIP_CONNECTION_ID}/token`;

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Telnyx token generation error:', {
        status: response.status,
        statusText: response.statusText,
        error: errorData,
        url: tokenUrl,
      });

      // Return more specific error message
      const errorMessage = errorData?.errors?.[0]?.detail
        || errorData?.message
        || `Telnyx API returned ${response.status}: ${response.statusText}`;

      return NextResponse.json(
        {
          error: 'Failed to generate Telnyx token',
          detail: errorMessage,
          status: response.status
        },
        { status: response.status }
      );
    }

    const data = await response.json();
    const token = data.data?.token;

    if (!token) {
      console.error('No token in Telnyx response:', data);
      return NextResponse.json(
        { error: 'No token received from Telnyx' },
        { status: 500 }
      );
    }

    return NextResponse.json({ token });
  } catch (error: any) {
    console.error('Error generating Telnyx token:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to generate token' },
      { status: 500 }
    );
  }
}
