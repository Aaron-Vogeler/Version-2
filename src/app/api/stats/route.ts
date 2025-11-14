/**
 * API route for dashboard statistics (user-scoped)
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  try {
    const supabase = createClient();

    // Get current user
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse date range (default to last 30 days)
    const searchParams = request.nextUrl.searchParams;
    const days = parseInt(searchParams.get('days') || '30');
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    // Fetch all calls in date range for user
    const { data: calls, error } = await supabase
      .from('calls')
      .select('*')
      .eq('user_id', user.id)
      .gte('started_at', fromDate.toISOString());

    if (error) {
      console.error('Stats query error:', error);
      return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 });
    }

    // Calculate statistics
    const totalCalls = calls.length;
    const answeredCalls = calls.filter(c => c.status === 'completed' && c.answered_at).length;
    const answerRate = totalCalls > 0 ? (answeredCalls / totalCalls) * 100 : 0;

    const totalTalkTime = calls.reduce((sum, c) => sum + (c.billable_sec || 0), 0);
    const avgTalkTime = answeredCalls > 0 ? totalTalkTime / answeredCalls : 0;

    const totalCost = calls.reduce((sum, c) => sum + (Number(c.cost_usd) || 0), 0);

    const callsWithGoal = calls.filter(c => c.goal);
    const achievedGoals = callsWithGoal.filter(c => c.goal_status === 'achieved').length;
    const goalSuccessRate = callsWithGoal.length > 0
      ? (achievedGoals / callsWithGoal.length) * 100
      : 0;

    // Calls by day for chart
    const callsByDay: Record<string, number> = {};
    calls.forEach(call => {
      if (call.started_at) {
        const date = new Date(call.started_at).toISOString().split('T')[0];
        callsByDay[date] = (callsByDay[date] || 0) + 1;
      }
    });

    // Status breakdown
    const statusBreakdown = calls.reduce((acc, call) => {
      acc[call.status] = (acc[call.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return NextResponse.json({
      totalCalls,
      answeredCalls,
      answerRate,
      avgTalkTime,
      totalCost,
      goalSuccessRate,
      callsByDay,
      statusBreakdown,
    });
  } catch (error) {
    console.error('API /stats error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
