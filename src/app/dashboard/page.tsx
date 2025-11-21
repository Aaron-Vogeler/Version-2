'use client';

/**
 * Dashboard Page with Call Delegation and Analytics
 * * Updates:
 * - Added "End Call" button functionality for active calls
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
import { RealTimeCallsTable } from '@/components/dashboard/real-time-calls-table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Phone, DollarSign, LogOut, BarChart3, Send, PhoneOff } from 'lucide-react';
import { Call, Assistant } from '@/lib/types/database';

export default function DashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [calls, setCalls] = useState<Call[]>([]);
  const [filteredCalls, setFilteredCalls] = useState<Call[]>([]);
  const [currentFilters, setCurrentFilters] = useState<CallFilters>({
    search: '',
    status: 'all',
    goal: 'all',
    assistantId: 'all',
    dateFrom: '',
    dateTo: '',
  });
  const [user, setUser] = useState<any>(null);
  const [selectedCall, setSelectedCall] = useState<Call | null>(null);
  const [showCallDetail, setShowCallDetail] = useState(false);
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [billingData, setBillingData] = useState<any>(null);
  const [endingCalls, setEndingCalls] = useState(false);

  // Initial load on mount
  useEffect(() => {
    checkAuth();
    loadDashboardData();
    loadAnalytics(true); // Force initial load
  }, []);

  // Analytics polling - fetch every 5 minutes instead of on every event
  useEffect(() => {
    // Set up polling interval
    const analyticsInterval = setInterval(() => {
      console.log('Polling analytics (5 minute interval)...');
      loadAnalytics(false);
    }, 5 * 60 * 1000); // 5 minutes

    // Cleanup interval on unmount
    return () => clearInterval(analyticsInterval);
  }, []);

  const checkAuth = async () => {
    // Check NextAuth session
    const response = await fetch('/api/me');
    if (response.ok) {
      const data = await response.json();
      setUser(data.user);
    } else {
      // Not authenticated, redirect to login page
      window.location.href = '/login';
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

  const loadAnalytics = async (force = false) => {
    try {
      console.log('Fetching analytics data...');

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

  // Handle calls update from RealTimeCallsTable
  const handleCallsUpdate = useCallback((updatedCalls: Call[]) => {
    setCalls(updatedCalls);
  }, []);

  const handleFiltersChange = useCallback((filters: CallFilters) => {
    // Save current filters
    setCurrentFilters(filters);

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

  // Re-apply filters when calls change (from real-time updates)
  useEffect(() => {
    handleFiltersChange(currentFilters);
  }, [calls, handleFiltersChange, currentFilters]);

  const handleViewCallDetails = (call: Call) => {
    setSelectedCall(call);
    setShowCallDetail(true);
  };

  const handleLogout = async () => {
    // Sign out and redirect to login
    await fetch('/api/auth/signout', { method: 'POST' });
    window.location.href = '/login';
  };

  const handleEndActiveCalls = async () => {
    // Identify active calls
    const activeCalls = calls.filter(call =>
      ['initiated', 'ringing', 'answered'].includes(call.status)
    );

    if (activeCalls.length === 0) return;

    // Confirm if there are multiple
    if (activeCalls.length > 1) {
      const confirmed = window.confirm(`Are you sure you want to end ${activeCalls.length} active calls?`);
      if (!confirmed) return;
    }

    setEndingCalls(true);

    try {
      // End all active calls in parallel
      // Use call_control_id if available, fallback to id for backwards compatibility
      const results = await Promise.all(activeCalls.map(async (call) => {
        const controlId = call.call_control_id || call.id;

        const response = await fetch('/api/calls/hangup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ call_control_id: controlId }),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Unknown error' }));
          console.error(`Failed to end call ${call.id}:`, error);
          return { success: false, call_id: call.id, error };
        }

        return { success: true, call_id: call.id };
      }));

      // Check for any failures
      const failures = results.filter(r => !r.success);
      if (failures.length > 0) {
        console.warn(`${failures.length} call(s) failed to end:`, failures);
      }
    } catch (error) {
      console.error('Error ending calls:', error);
    } finally {
      setEndingCalls(false);
    }
  };

  // Calculate active call count directly from calls array
  const activeCallCount = calls.filter(call =>
    call.status === 'initiated' ||
    call.status === 'ringing' ||
    call.status === 'answered'
  ).length;

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
            {/* Live Call Indicator & End Button */}
            {activeCallCount > 0 && (
              <>
                <Badge variant="success" className="animate-pulse">
                  <span className="h-2 w-2 rounded-full bg-green-500 mr-2" />
                  {activeCallCount} Active
                </Badge>
                <Button 
                  variant="destructive" 
                  size="sm" 
                  onClick={handleEndActiveCalls}
                  disabled={endingCalls}
                >
                  <PhoneOff className="mr-2 h-4 w-4" />
                  {endingCalls ? 'Ending...' : activeCallCount > 1 ? 'End All Calls' : 'End Call'}
                </Button>
              </>
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
            <RealTimeCallsTable
              displayCalls={filteredCalls}
              onViewDetails={handleViewCallDetails}
              onCallsUpdate={handleCallsUpdate}
            />
          </TabsContent>
        </Tabs>
      </main>

      {/* Call Detail Modal */}
      <CallDetailModal
        call={selectedCall}
        open={showCallDetail}
        onOpenChange={setShowCallDetail}
      />
    </div>
  );
}
