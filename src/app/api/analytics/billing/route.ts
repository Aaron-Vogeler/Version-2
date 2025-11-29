/**
 * API route for billing and usage analytics
 * Uses NextAuth for auth + Supabase service-role on the server
 */

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/../pages/api/auth/[...nextauth]';
import { createClient } from '@supabase/supabase-js';
import type { Call } from '@/lib/types/database';

// --- Supabase admin client (service role, server-only) ---
// NOTE: Lazy initialization to avoid build-time dependency on runtime secrets
let supabaseAdmin: ReturnType<typeof createClient> | null = null;

function getSupabaseAdmin() {
  if (supabaseAdmin) {
    return supabaseAdmin;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars at runtime'
    );
  }

  supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return supabaseAdmin;
}

export async function GET(request: NextRequest) {
  try {
    // 1) Get current user from NextAuth (NOT Supabase cookies)
    const session = await getServerSession(authOptions);

    if (!session?.user || !(session.user as any).id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = (session.user as any).id as string;

    // 2) Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const days = parseInt(searchParams.get('days') || '30', 10);

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    // 3) Fetch all calls for this user in date range
    const { data, error } = await getSupabaseAdmin()
      .from('calls')
      .select('*')
      .eq('user_id', userId)
      .gte('started_at', fromDate.toISOString());

    if (error || !data) {
      console.error('Billing analytics query error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch billing data' },
        { status: 500 }
      );
    }

    const calls = data as Call[];

    // 4) Calculate current period totals
    const totalCalls = calls.length;
    const totalMinutes = calls.reduce(
      (sum, c) => sum + (c.billable_sec || 0) / 60,
      0
    );
    const totalCost = calls.reduce(
      (sum, c) => sum + (Number(c.cost_usd) || 0),
      0
    );

    // Breakdown by goal & direction
    const breakdownByGoal: Record<string, number> = {};
    const breakdownByDirection: Record<string, number> = {};

    calls.forEach((call) => {
      if (call.goal) {
        breakdownByGoal[call.goal] =
          (breakdownByGoal[call.goal] || 0) + (Number(call.cost_usd) || 0);
      }
      breakdownByDirection[call.direction] =
        (breakdownByDirection[call.direction] || 0) +
        (Number(call.cost_usd) || 0);
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
          costsByDate[date].calls += 1;
        }
      }
    });

    const historicalCosts = Object.entries(costsByDate)
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Cost by assistant
    const costByAssistantMap: Record<
      string,
      { calls: number; minutes: number; cost: number }
    > = {};

    calls.forEach((call) => {
      if (call.assistant_id) {
        const name = call.assistant_name || call.assistant_id;
        if (!costByAssistantMap[name]) {
          costByAssistantMap[name] = { calls: 0, minutes: 0, cost: 0 };
        }
        costByAssistantMap[name].calls += 1;
        costByAssistantMap[name].minutes += (call.billable_sec || 0) / 60;
        costByAssistantMap[name].cost += Number(call.cost_usd) || 0;
      }
    });

    const costByAssistant = Object.entries(costByAssistantMap).map(
      ([assistantName, data]) => ({
        assistantName,
        ...data,
      })
    );

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
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
