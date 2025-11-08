/**
 * API route for billing and usage analytics
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
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

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const days = parseInt(searchParams.get('days') || '30');
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    // Fetch all calls in date range
    const { data: calls, error } = await supabase
      .from('calls')
      .select('*')
      .eq('tenant_id', tenantId)
      .gte('started_at', fromDate.toISOString());

    if (error) {
      console.error('Billing analytics query error:', error);
      return NextResponse.json({ error: 'Failed to fetch billing data' }, { status: 500 });
    }

    // Calculate current period totals
    const totalCalls = calls.length;
    const totalMinutes = calls.reduce((sum, c) => sum + ((c.billable_sec || 0) / 60), 0);
    const totalCost = calls.reduce((sum, c) => sum + (Number(c.cost_usd) || 0), 0);

    // Breakdown by goal
    const breakdownByGoal: Record<string, number> = {};
    const breakdownByDirection: Record<string, number> = {};

    calls.forEach((call) => {
      if (call.goal) {
        breakdownByGoal[call.goal] = (breakdownByGoal[call.goal] || 0) + (Number(call.cost_usd) || 0);
      }
      breakdownByDirection[call.direction] = (breakdownByDirection[call.direction] || 0) + (Number(call.cost_usd) || 0);
    });

    // Historical costs by day
    const costsByDate: Record<string, { cost: number; calls: number }> = {};

    for (let i = 0; i < days; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      costsByDate[dateStr] = { cost: 0, calls: 0 };
    }

    calls.forEach((call) => {
      if (call.started_at) {
        const date = new Date(call.started_at).toISOString().split('T')[0];
        if (costsByDate[date]) {
          costsByDate[date].cost += Number(call.cost_usd) || 0;
          costsByDate[date].calls++;
        }
      }
    });

    const historicalCosts = Object.entries(costsByDate)
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Cost by assistant
    const costByAssistantMap: Record<string, { calls: number; minutes: number; cost: number }> = {};

    calls.forEach((call) => {
      if (call.assistant_id) {
        const name = call.assistant_name || call.assistant_id;
        if (!costByAssistantMap[name]) {
          costByAssistantMap[name] = { calls: 0, minutes: 0, cost: 0 };
        }
        costByAssistantMap[name].calls++;
        costByAssistantMap[name].minutes += (call.billable_sec || 0) / 60;
        costByAssistantMap[name].cost += Number(call.cost_usd) || 0;
      }
    });

    const costByAssistant = Object.entries(costByAssistantMap).map(([assistantName, data]) => ({
      assistantName,
      ...data,
    }));

    return NextResponse.json({
      currentPeriod: {
        totalCalls,
        totalMinutes,
        totalCost,
        breakdown: {
          goal: breakdownByGoal,
          direction: breakdownByDirection,
        },
      },
      historicalCosts,
      costByAssistant,
    });
  } catch (error) {
    console.error('API /analytics/billing error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
