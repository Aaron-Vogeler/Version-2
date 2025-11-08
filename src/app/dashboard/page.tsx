'use client';

/**
 * Enhanced Dashboard Page with AI Assistant Analytics
 * Features: Filtering, Call Details, Goal Analytics, Assistant Performance, Billing
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatCard } from '@/components/dashboard/stat-card';
import { CallsChart } from '@/components/dashboard/calls-chart';
import { CallsTable } from '@/components/dashboard/calls-table';
import { FilterBar, CallFilters } from '@/components/dashboard/filter-bar';
import { CallDetailModal } from '@/components/dashboard/call-detail-modal';
import { GoalAnalytics } from '@/components/dashboard/goal-analytics';
import { AssistantPerformance } from '@/components/dashboard/assistant-performance';
import { BillingUsage } from '@/components/dashboard/billing-usage';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Phone, TrendingUp, Clock, DollarSign, Target, LogOut, Bot, BarChart3 } from 'lucide-react';
import { formatDuration, formatCurrency } from '@/lib/utils';
import { Call, Assistant } from '@/lib/types/database';

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
  const [filteredCalls, setFilteredCalls] = useState<Call[]>([]);
  const [user, setUser] = useState<any>(null);
  const [selectedCall, setSelectedCall] = useState<Call | null>(null);
  const [showCallDetail, setShowCallDetail] = useState(false);
  const [assistants, setAssistants] = useState<Assistant[]>([]);

  // Analytics data
  const [goalAnalytics, setGoalAnalytics] = useState<any>(null);
  const [assistantMetrics, setAssistantMetrics] = useState<any[]>([]);
  const [billingData, setBillingData] = useState<any>(null);

  // Live status tracking
  const [liveCallStatuses, setLiveCallStatuses] = useState<Record<string, string>>({});

  useEffect(() => {
    checkAuth();
    loadDashboardData();
    loadAnalytics();
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
      const callsRes = await fetch('/api/calls?limit=100');
      if (callsRes.ok) {
        const callsData = await callsRes.json();
        setCalls(callsData.calls || []);
        setFilteredCalls(callsData.calls || []);
      }

      // Fetch assistants
      const assistantsRes = await fetch('/api/assistants');
      if (assistantsRes.ok) {
        const assistantsData = await assistantsRes.json();
        setAssistants(assistantsData.assistants || []);
      }
    } catch (error) {
      console.error('Error loading dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadAnalytics = async () => {
    try {
      // Load goal analytics
      const goalsRes = await fetch('/api/analytics/goals?days=30');
      if (goalsRes.ok) {
        const goalsData = await goalsRes.json();
        setGoalAnalytics(goalsData);
      }

      // Load assistant metrics
      const assistantsRes = await fetch('/api/analytics/assistants?days=30');
      if (assistantsRes.ok) {
        const assistantsData = await assistantsRes.json();
        setAssistantMetrics(assistantsData.metrics || []);
      }

      // Load billing data
      const billingRes = await fetch('/api/analytics/billing?days=30');
      if (billingRes.ok) {
        const billingData = await billingRes.json();
        setBillingData(billingData);
      }
    } catch (error) {
      console.error('Error loading analytics:', error);
    }
  };

  const setupRealtimeSubscription = () => {
    const supabase = createClient();

    // Subscribe to calls table changes for live updates
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
          console.log('Call update received:', payload);

          // Update live status
          if (payload.new && typeof payload.new === 'object' && 'id' in payload.new && 'status' in payload.new) {
            const call = payload.new as Call;
            setLiveCallStatuses(prev => ({
              ...prev,
              [call.id]: call.status,
            }));
          }

          // Reload data on changes
          loadDashboardData();
          loadAnalytics();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  };

  const handleFiltersChange = useCallback((filters: CallFilters) => {
    let filtered = [...calls];

    // Apply search filter
    if (filters.search) {
      filtered = filtered.filter(
        (call) =>
          call.from_e164.includes(filters.search) ||
          call.to_e164.includes(filters.search)
      );
    }

    // Apply status filter
    if (filters.status && filters.status !== 'all') {
      filtered = filtered.filter((call) => call.status === filters.status);
    }

    // Apply goal filter
    if (filters.goal && filters.goal !== 'all') {
      filtered = filtered.filter((call) => call.goal === filters.goal);
    }

    // Apply assistant filter
    if (filters.assistantId && filters.assistantId !== 'all') {
      filtered = filtered.filter((call) => call.assistant_id === filters.assistantId);
    }

    // Apply date range filters
    if (filters.dateFrom) {
      filtered = filtered.filter(
        (call) => call.started_at && new Date(call.started_at) >= new Date(filters.dateFrom)
      );
    }

    if (filters.dateTo) {
      const toDate = new Date(filters.dateTo);
      toDate.setHours(23, 59, 59, 999);
      filtered = filtered.filter(
        (call) => call.started_at && new Date(call.started_at) <= toDate
      );
    }

    setFilteredCalls(filtered);
  }, [calls]);

  const handleViewCallDetails = (call: Call) => {
    setSelectedCall(call);
    setShowCallDetail(true);
  };

  const handleFeedbackSubmit = (callId: string, feedback: boolean, comment: string) => {
    // Refresh calls to show updated feedback
    loadDashboardData();
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
            <h1 className="text-2xl font-bold">AI Call Analytics Dashboard</h1>
            {user && (
              <p className="text-sm text-muted-foreground">
                Welcome back, {user.full_name || user.email}
              </p>
            )}
          </div>
          <div className="flex items-center gap-4">
            {/* Live Call Indicator */}
            {Object.keys(liveCallStatuses).length > 0 && (
              <Badge variant="success" className="animate-pulse">
                <span className="h-2 w-2 rounded-full bg-green-500 mr-2" />
                {Object.keys(liveCallStatuses).length} Active
              </Badge>
            )}
            <Button variant="outline" onClick={handleLogout}>
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="overview">
              <Phone className="mr-2 h-4 w-4" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="goals">
              <Target className="mr-2 h-4 w-4" />
              Goal Analytics
            </TabsTrigger>
            <TabsTrigger value="assistants">
              <Bot className="mr-2 h-4 w-4" />
              Assistants
            </TabsTrigger>
            <TabsTrigger value="billing">
              <DollarSign className="mr-2 h-4 w-4" />
              Billing
            </TabsTrigger>
            <TabsTrigger value="calls">
              <BarChart3 className="mr-2 h-4 w-4" />
              All Calls
            </TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-6">
            {/* KPI Cards */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
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
            <CallsChart callsByDay={stats?.callsByDay || {}} days={7} />

            {/* Recent Calls */}
            <div>
              <h3 className="text-lg font-semibold mb-4">Recent Calls</h3>
              <CallsTable calls={calls.slice(0, 10)} onViewDetails={handleViewCallDetails} />
            </div>
          </TabsContent>

          {/* Goal Analytics Tab */}
          <TabsContent value="goals">
            {goalAnalytics && <GoalAnalytics data={goalAnalytics} />}
          </TabsContent>

          {/* Assistant Performance Tab */}
          <TabsContent value="assistants">
            {assistantMetrics.length > 0 && <AssistantPerformance metrics={assistantMetrics} />}
          </TabsContent>

          {/* Billing & Usage Tab */}
          <TabsContent value="billing">
            {billingData && <BillingUsage data={billingData} />}
          </TabsContent>

          {/* All Calls Tab with Filtering */}
          <TabsContent value="calls" className="space-y-6">
            <FilterBar onFiltersChange={handleFiltersChange} assistants={assistants} />
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">
                {filteredCalls.length} Call{filteredCalls.length !== 1 ? 's' : ''}
              </h3>
            </div>
            <CallsTable calls={filteredCalls} onViewDetails={handleViewCallDetails} />
          </TabsContent>
        </Tabs>
      </main>

      {/* Call Detail Modal */}
      <CallDetailModal
        call={selectedCall}
        open={showCallDetail}
        onOpenChange={setShowCallDetail}
        onFeedbackSubmit={handleFeedbackSubmit}
      />
    </div>
  );
}
