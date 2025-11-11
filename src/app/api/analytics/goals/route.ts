/**
 * API route for goal analytics
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

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const days = parseInt(searchParams.get('days') || '30');
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    // Fetch all calls with goals in date range
    const { data, error } = await supabase
      .from('calls')
      .select('*')
      .eq('user_id', user.id)
      .not('goal', 'is', null)
      .gte('started_at', fromDate.toISOString());

    if (error || !data) {
      console.error('Goals query error:', error);
      return NextResponse.json({ error: 'Failed to fetch goals' }, { status: 500 });
    }

    const calls = data;

    // Calculate goal trends by date
    const goalTrendsByDate: Record<string, { achieved: number; failed: number; pending: number }> = {};

    for (let i = 0; i < days; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      goalTrendsByDate[dateStr] = { achieved: 0, failed: 0, pending: 0 };
    }

    calls.forEach((call) => {
      if (call.started_at) {
        const date = new Date(call.started_at).toISOString().split('T')[0];
        if (goalTrendsByDate[date]) {
          if (call.goal_status === 'achieved') {
            goalTrendsByDate[date].achieved++;
          } else if (call.goal_status === 'failed') {
            goalTrendsByDate[date].failed++;
          } else {
            goalTrendsByDate[date].pending++;
          }
        }
      }
    });

    const goalTrends = Object.entries(goalTrendsByDate)
      .map(([date, counts]) => ({ date, ...counts }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Calculate goals by type
    const goalsByTypeMap: Record<string, { total: number; achieved: number; durations: number[] }> = {};

    calls.forEach((call) => {
      const goal = call.goal;
      if (!goalsByTypeMap[goal]) {
        goalsByTypeMap[goal] = { total: 0, achieved: 0, durations: [] };
      }
      goalsByTypeMap[goal].total++;
      if (call.goal_status === 'achieved') {
        goalsByTypeMap[goal].achieved++;
        if (call.duration_sec) {
          goalsByTypeMap[goal].durations.push(call.duration_sec);
        }
      }
    });

    const goalsByType = Object.entries(goalsByTypeMap).map(([goal, data]) => ({
      goal,
      total: data.total,
      achieved: data.achieved,
      successRate: data.total > 0 ? (data.achieved / data.total) * 100 : 0,
      avgTimeToGoal: data.durations.length > 0
        ? data.durations.reduce((a, b) => a + b, 0) / data.durations.length
        : 0,
    }));

    // Top performing goals
    const topPerformingGoals = [...goalsByType]
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, 5)
      .map((g) => ({
        goal: g.goal,
        successRate: g.successRate,
        avgDuration: g.avgTimeToGoal,
      }));

    return NextResponse.json({
      goalTrends,
      goalsByType,
      topPerformingGoals,
    });
  } catch (error) {
    console.error('API /analytics/goals error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
