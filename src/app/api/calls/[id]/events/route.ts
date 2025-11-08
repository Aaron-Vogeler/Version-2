/**
 * API route for fetching call events (tenant-scoped)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createClient();

    // Get current user and tenant
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get user's tenant_id
    const { data: profile } = await supabase
      .from('profiles')
      .select('tenant_id')
      .eq('user_id', user.id)
      .single();

    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    const tenantId = profile.tenant_id;
    const callId = params.id;

    // Verify call belongs to tenant
    const { data: call } = await supabase
      .from('calls')
      .select('id')
      .eq('id', callId)
      .eq('tenant_id', tenantId)
      .single();

    if (!call) {
      return NextResponse.json({ error: 'Call not found' }, { status: 404 });
    }

    // Fetch events for this call
    const { data: events, error } = await supabase
      .from('call_events')
      .select('*')
      .eq('call_id', callId)
      .eq('tenant_id', tenantId)
      .order('occurred_at', { ascending: true });

    if (error) {
      console.error('Events query error:', error);
      return NextResponse.json({ error: 'Failed to fetch events' }, { status: 500 });
    }

    return NextResponse.json({ events });
  } catch (error) {
    console.error('API /calls/[id]/events error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
