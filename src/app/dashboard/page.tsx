'use client';

/**
 * Main dashboard page with KPIs, charts, and call table
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { StatCard } from '@/components/dashboard/stat-card';
import { CallsChart } from '@/components/dashboard/calls-chart';
import { CallsTable } from '@/components/dashboard/calls-table';
import { Button } from '@/components/ui/button';
import { Phone, TrendingUp, Clock, DollarSign, Target, LogOut } from 'lucide-react';
import { formatDuration, formatCurrency } from '@/lib/utils';
import { Call } from '@/lib/types/database';

interface DashboardStats {
  totalCalls: number;
  answerRate: number;
  avgTalkTime: number;
  totalCost: number;
  goalSuccessRate: number;
  callsByDay: Record<string, number>;
}

export default function DashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    checkAuth();
    loadDashboardData();
    setupRealtimeSubscription();
  }, []);

  const checkAuth = async () => {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
      router.push('/login');
      return;
    }

    // Fetch user profile
    const response = await fetch('/api/me');
    if (response.ok) {
      const data = await response.json();
      setUser(data.user);
    }
  };

  const loadDashboardData = async () => {
    try {
      setLoading(true);

      // Fetch stats
      const statsRes = await fetch('/api/stats?days=30');
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setStats(statsData);
      }

      // Fetch recent calls
      const callsRes = await fetch('/api/calls?limit=20');
      if (callsRes.ok) {
        const callsData = await callsRes.json();
        setCalls(callsData.calls || []);
      }
    } catch (error) {
      console.error('Error loading dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  const setupRealtimeSubscription = () => {
    const supabase = createClient();

    // Subscribe to calls table changes
    const channel = supabase
      .channel('dashboard-calls')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'calls',
        },
        (payload) => {
          console.log('Call update:', payload);
          // Reload data on changes
          loadDashboardData();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  };

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-lg">Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="border-b bg-white dark:bg-gray-800">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-2xl font-bold">Telnyx Call CRM</h1>
            {user && (
              <p className="text-sm text-muted-foreground">
                Welcome back, {user.full_name || user.email}
              </p>
            )}
          </div>
          <Button variant="outline" onClick={handleLogout}>
            <LogOut className="mr-2 h-4 w-4" />
            Logout
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {/* KPI Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5 mb-8">
          <StatCard
            title="Total Calls"
            value={stats?.totalCalls || 0}
            icon={Phone}
            description="Last 30 days"
          />
          <StatCard
            title="Answer Rate"
            value={`${(stats?.answerRate || 0).toFixed(1)}%`}
            icon={TrendingUp}
            description="Calls answered"
          />
          <StatCard
            title="Avg Talk Time"
            value={formatDuration(Math.round(stats?.avgTalkTime || 0))}
            icon={Clock}
            description="Per answered call"
          />
          <StatCard
            title="Total Cost"
            value={formatCurrency(stats?.totalCost || 0)}
            icon={DollarSign}
            description="Last 30 days"
          />
          <StatCard
            title="Goal Success"
            value={`${(stats?.goalSuccessRate || 0).toFixed(1)}%`}
            icon={Target}
            description="Goals achieved"
          />
        </div>

        {/* Chart */}
        <div className="mb-8">
          <CallsChart callsByDay={stats?.callsByDay || {}} days={7} />
        </div>

        {/* Calls Table */}
        <CallsTable calls={calls} />
      </main>
    </div>
  );
}
