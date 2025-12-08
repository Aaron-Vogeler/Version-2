/**
 * API route for fetching LLM logs for a specific call
 * Used by the Groq Call component to display live LLM input/output
 * Queries the existing call_llm_exchanges table with realtime enabled
 */

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/../pages/api/auth/[...nextauth]';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    console.log('[LLM-Logs API] Session check:', session ? 'found' : 'null', session?.user ? 'has user' : 'no user');
    if (!session?.user) {
      console.log('[LLM-Logs API] Returning 401 - no session or user');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: callId } = await params;

    if (!callId) {
      return NextResponse.json(
        { error: 'Call ID is required' },
        { status: 400 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // First verify the user owns this call
    const userId = (session.user as any).id;
    const { data: call, error: callError } = await supabase
      .from('calls')
      .select('id, user_id')
      .eq('id', callId)
      .single();

    if (callError || !call) {
      return NextResponse.json(
        { error: 'Call not found' },
        { status: 404 }
      );
    }

    if (call.user_id !== userId) {
      return NextResponse.json(
        { error: 'Unauthorized to view this call' },
        { status: 403 }
      );
    }

    // Fetch LLM exchanges for this call, ordered by creation time
    // Uses the existing call_llm_exchanges table with realtime enabled
    const { data: logs, error: logsError } = await supabase
      .from('call_llm_exchanges')
      .select('*')
      .eq('call_id', callId)
      .order('created_at', { ascending: true });

    if (logsError) {
      console.error('Error fetching LLM exchanges:', logsError);
      return NextResponse.json(
        { error: 'Failed to fetch LLM logs' },
        { status: 500 }
      );
    }

    // Map call_llm_exchanges columns to expected frontend format
    // response_text -> assistant_response, duration_ms -> latency_ms
    const mappedLogs = (logs || []).map((log: any) => ({
      ...log,
      assistant_response: log.response_text,
      latency_ms: log.duration_ms,
    }));

    return NextResponse.json({
      logs: mappedLogs,
      call_id: callId,
    });
  } catch (error: any) {
    console.error('LLM logs API error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch LLM logs' },
      { status: 500 }
    );
  }
}
