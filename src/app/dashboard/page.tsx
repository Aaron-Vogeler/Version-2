'use client';

/**
 * Dashboard Page with Call Delegation and Analytics
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FilterBar, CallFilters } from '@/components/dashboard/filter-bar';
import { CallDetailModal } from '@/components/dashboard/call-detail-modal';
import { BillingUsage } from '@/components/dashboard/billing-usage';
import { DelegateCall } from '@/components/dashboard/delegate-call';
import { CallsTable } from '@/components/dashboard/calls-table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Phone, DollarSign, LogOut, BarChart3, Send } from 'lucide-react';
import { Call, Assistant } from '@/lib/types/database';

export default function DashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [calls, setCalls] = useState<Call[]>([]);
  const [filteredCalls, setFilteredCalls] = useState<Call[]>([]);
  const [user, setUser] = useState<any>(null);
  const [selectedCall, setSelectedCall] = useState<Call | null>(null);
  const [showCallDetail, setShowCallDetail] = useState(false);
  const [assistants, setAssistants] = useState<Assistant[]>([]);
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
            <h1 className="text-2xl font-bold">AI Call Dashboard</h1>
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
        <Tabs defaultValue="delegate" className="space-y-6">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="delegate">
              <Send className="mr-2 h-4 w-4" />
              Delegate A Call
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

          {/* Delegate A Call Tab */}
          <TabsContent value="delegate">
            <DelegateCall />
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
