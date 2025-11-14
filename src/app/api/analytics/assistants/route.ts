/**
 * API route for assistant performance analytics (user-scoped)
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

    // Fetch all calls with assistant_id in date range for user
    const { data: calls, error } = await supabase
      .from('calls')
      .select('*')
      .eq('user_id', user.id)
      .not('assistant_id', 'is', null)
      .gte('started_at', fromDate.toISOString());

    if (error) {
      console.error('Assistant analytics query error:', error);
      return NextResponse.json({ error: 'Failed to fetch assistant analytics' }, { status: 500 });
    }

    // Calculate metrics per assistant
    const assistantMetricsMap: Record<string, {
      assistantName: string;
      totalCalls: number;
      completedCalls: number;
      goalsAchieved: number;
      goalsTotal: number;
      responseTimes: number[];
      durations: number[];
      totalCost: number;
    }> = {};

    calls.forEach((call) => {
      const aid = call.assistant_id;
      if (!assistantMetricsMap[aid]) {
        assistantMetricsMap[aid] = {
          assistantName: call.assistant_name || aid,
          totalCalls: 0,
          completedCalls: 0,
          goalsAchieved: 0,
          goalsTotal: 0,
          responseTimes: [],
          durations: [],
          totalCost: 0,
        };
      }

      const metrics = assistantMetricsMap[aid];
      metrics.totalCalls++;

      if (call.status === 'completed') {
        metrics.completedCalls++;
      }

      if (call.goal) {
        metrics.goalsTotal++;
        if (call.goal_status === 'achieved') {
          metrics.goalsAchieved++;
        }
      }

      if (call.response_time_ms) {
        metrics.responseTimes.push(call.response_time_ms);
      }

      if (call.duration_sec) {
        metrics.durations.push(call.duration_sec);
      }

      if (call.cost_usd) {
        metrics.totalCost += Number(call.cost_usd);
      }
    });

    // Format metrics
    const metrics = Object.entries(assistantMetricsMap).map(([assistantId, data]) => ({
      assistantId,
      assistantName: data.assistantName,
      totalCalls: data.totalCalls,
      completedCalls: data.completedCalls,
      goalSuccessRate: data.goalsTotal > 0
        ? (data.goalsAchieved / data.goalsTotal) * 100
        : 0,
      avgResponseTime: data.responseTimes.length > 0
        ? data.responseTimes.reduce((a, b) => a + b, 0) / data.responseTimes.length
        : 0,
      avgCallDuration: data.durations.length > 0
        ? data.durations.reduce((a, b) => a + b, 0) / data.durations.length
        : 0,
      totalCost: data.totalCost,
    }));

    return NextResponse.json({ metrics });
  } catch (error) {
    console.error('API /analytics/assistants error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
