/**
 * API route for submitting call feedback (user-scoped)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createClient();

    // Get current user
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const callId = params.id;
    const body = await request.json();
    const { feedback, comment } = body;

    // Verify call belongs to user
    const { data: call } = await supabase
      .from('calls')
      .select('id')
      .eq('id', callId)
      .eq('user_id', user.id)
      .single();

    if (!call) {
      return NextResponse.json({ error: 'Call not found' }, { status: 404 });
    }

    // Update call with feedback
    const { error: updateError } = await supabase
      .from('calls')
      .update({
        user_feedback: feedback,
        feedback_comment: comment,
        feedback_at: new Date().toISOString(),
      })
      .eq('id', callId);

    if (updateError) {
      console.error('Feedback update error:', updateError);
      return NextResponse.json({ error: 'Failed to save feedback' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('API /calls/[id]/feedback error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
