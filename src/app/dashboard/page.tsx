'use client';

/**
 * Dashboard Page with Call Delegation and Analytics
 * * Updates:
 * - Added "End Call" button functionality for active calls
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Phone, DollarSign, LogOut, BarChart3, Send, PhoneOff, Settings } from 'lucide-react';
import { Call, Assistant } from '@/lib/types/database';

export default function DashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [showBirdLoader, setShowBirdLoader] = useState(false);
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
  const [showSettings, setShowSettings] = useState(false);
  const [customAssistantName, setCustomAssistantName] = useState('');
  const [savingAssistantName, setSavingAssistantName] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [savingFirstName, setSavingFirstName] = useState(false);

  // Initial load on mount
  useEffect(() => {
    checkAuth();
    loadDashboardData();
    loadAnalytics(true); // Force initial load

    // Check if bird loader should be shown (once per session)
    const loaderShown = sessionStorage.getItem('dashboardLoaderShown');
    if (!loaderShown) {
      setShowBirdLoader(true);
      sessionStorage.setItem('dashboardLoaderShown', 'true');

      // Auto-hide bird loader after animation completes (5s)
      const loaderTimer = setTimeout(() => {
        setShowBirdLoader(false);
      }, 5000);

      return () => clearTimeout(loaderTimer);
    }
  }, []);

  // Handle loading delay - wait for data to load before showing dashboard
  useEffect(() => {
    if (dataLoaded) {
      // If bird loader is showing, wait for it to complete
      // Otherwise, show dashboard immediately
      if (showBirdLoader) {
        const timer = setTimeout(() => {
          setLoading(false);
        }, 5000);
        return () => clearTimeout(timer);
      } else {
        setLoading(false);
      }
    }
  }, [dataLoaded, showBirdLoader]);

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
      // Set custom assistant name from user profile
      if (data.user.custom_assistant_name) {
        setCustomAssistantName(data.user.custom_assistant_name);
      }
      // Set first name from user profile
      if (data.user.first_name) {
        setFirstName(data.user.first_name);
      }
    } else {
      // Not authenticated, redirect to login page
      window.location.href = '/login';
    }
  };

  const loadDashboardData = async () => {
    try {
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
      setDataLoaded(true);
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

  const handleSaveAssistantName = async () => {
    setSavingAssistantName(true);
    try {
      const response = await fetch('/api/profile/update-assistant-name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ custom_assistant_name: customAssistantName || null }),
      });

      if (!response.ok) {
        throw new Error('Failed to save assistant name');
      }

      // Update user state to reflect the change
      if (user) {
        setUser({
          ...user,
          custom_assistant_name: customAssistantName || null,
        });
      }
    } catch (error) {
      console.error('Error saving assistant name:', error);
      alert('Failed to save assistant name. Please try again.');
    } finally {
      setSavingAssistantName(false);
    }
  };

  const handleSaveFirstName = async () => {
    setSavingFirstName(true);
    try {
      const response = await fetch('/api/profile/update-first-name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ first_name: firstName || null }),
      });

      if (!response.ok) {
        throw new Error('Failed to save first name');
      }

      // Update user state to reflect the change
      if (user) {
        setUser({
          ...user,
          first_name: firstName || null,
        });
      }
    } catch (error) {
      console.error('Error saving first name:', error);
      alert('Failed to save first name. Please try again.');
    } finally {
      setSavingFirstName(false);
    }
  };

  const handleEndActiveCalls = async () => {
    // Identify active calls
    const activeCalls = calls.filter(call =>
      ['initiated', 'ringing', 'answered'].includes(call.status)
    );

    if (activeCalls.length === 0) return;

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
      <div className="min-h-screen bg-background flex items-center justify-center">
        {/* Show bird loader overlay only on first session load */}
        {showBirdLoader && (
          <div className="bird-overlay" aria-hidden="true">
            <div className="bird-flight">
              <div className="bird">
                <div className="bird-wings-up"></div>
                <div className="bird-wings-down"></div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header - Minimalist Beige Futuristic Design */}
      <header className="border-b border-border/40 bg-card/50 backdrop-blur-sm sticky top-0 z-40 shadow-soft">
        <div className="container-custom">
          <div className="flex items-center justify-between py-6 lg:py-8">
            <div className="flex items-center gap-4">
              {user && (
                <>
                  <Image
                    src="/assets/bird/Wings Up.png"
                    alt="Wings Up"
                    width={64}
                    height={64}
                    className="flex-shrink-0"
                  />
                  <h1 className="text-3xl lg:text-4xl font-bold tracking-tight text-foreground">
                    Welcome back, {firstName || user.full_name || user.email?.split('@')[0] || 'there'}
                  </h1>
                </>
              )}
            </div>
            <div className="flex items-center gap-3">
              {/* Live Call Indicator & End Button */}
              {activeCallCount > 0 && (
                <>
                  <Badge variant="success" className="animate-pulse px-4 py-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-success mr-2 animate-pulse" />
                    {activeCallCount} Active
                  </Badge>
                  <Button
                    variant="destructive"
                    onClick={handleEndActiveCalls}
                    disabled={endingCalls}
                  >
                    <PhoneOff className="mr-2 h-5 w-5" />
                    {endingCalls ? 'Ending...' : activeCallCount > 1 ? 'End All Calls' : 'End Call'}
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowSettings(true)}
                title="Settings"
                className="hidden lg:flex"
              >
                <Settings className="h-5 w-5" />
              </Button>
              <Button variant="outline" onClick={handleLogout}>
                <LogOut className="mr-2 h-5 w-5" />
                <span className="hidden sm:inline">Logout</span>
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content - Generous Spacing & Clean Layout */}
      <main className="container-custom py-8 lg:py-12">
        <Tabs defaultValue="delegate" className="space-y-8 lg:space-y-10">
          <TabsList className="w-full max-w-2xl mx-auto grid grid-cols-3">
            <TabsTrigger value="delegate">
              <Send className="h-5 w-5 lg:mr-2" />
              <span className="hidden lg:inline">Delegate A Call</span>
              <span className="lg:hidden">Delegate</span>
            </TabsTrigger>
            <TabsTrigger value="billing">
              <DollarSign className="h-5 w-5 lg:mr-2" />
              <span className="hidden lg:inline">Billing & Usage</span>
              <span className="lg:hidden">Billing</span>
            </TabsTrigger>
            <TabsTrigger value="calls">
              <BarChart3 className="h-5 w-5 lg:mr-2" />
              <span className="hidden lg:inline">All Calls</span>
              <span className="lg:hidden">Calls</span>
            </TabsTrigger>
          </TabsList>

          {/* Delegate A Call Tab */}
          <TabsContent value="delegate" className="animate-fade-in">
            <DelegateCall customAssistantName={customAssistantName || 'your AI assistant'} />
          </TabsContent>

          {/* Billing & Usage Tab */}
          <TabsContent value="billing" className="animate-fade-in">
            {billingData && <BillingUsage data={billingData} />}
          </TabsContent>

          {/* All Calls Tab with Filtering */}
          <TabsContent value="calls" className="space-y-6 animate-fade-in">
            <FilterBar onFiltersChange={handleFiltersChange} assistants={assistants} />
            <div className="flex items-center justify-between px-2">
              <h3 className="text-xl lg:text-2xl font-semibold tracking-tight text-foreground">
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

      {/* Settings Dialog */}
      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          <div className="space-y-6 py-4">
            {/* First Name */}
            <div className="space-y-2">
              <Label htmlFor="first-name">Your First Name</Label>
              <Input
                id="first-name"
                type="text"
                placeholder="e.g., John, Sarah, Alex..."
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                maxLength={50}
              />
              <p className="text-xs text-muted-foreground">
                This will be displayed in your personalized dashboard greeting
              </p>
              <Button
                onClick={handleSaveFirstName}
                disabled={savingFirstName}
                size="sm"
                className="mt-2"
              >
                {savingFirstName ? 'Saving...' : 'Save First Name'}
              </Button>
            </div>

            {/* Custom Assistant Name */}
            <div className="space-y-2">
              <Label htmlFor="assistant-name">AI Assistant Name</Label>
              <Input
                id="assistant-name"
                type="text"
                placeholder="e.g., Ferguson, Alex, Sarah..."
                value={customAssistantName}
                onChange={(e) => setCustomAssistantName(e.target.value)}
                maxLength={100}
              />
              <p className="text-xs text-muted-foreground">
                This name will be used when your AI assistant introduces itself on calls
              </p>
              <Button
                onClick={handleSaveAssistantName}
                disabled={savingAssistantName}
                size="sm"
                className="mt-2"
              >
                {savingAssistantName ? 'Saving...' : 'Save Assistant Name'}
              </Button>
            </div>

          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
