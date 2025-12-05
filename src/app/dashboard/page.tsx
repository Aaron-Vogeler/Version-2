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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Phone, DollarSign, LogOut, BarChart3, Send, PhoneOff, Settings } from 'lucide-react';
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
  const [showSettings, setShowSettings] = useState(false);
  const [colorTheme, setColorTheme] = useState('blue');
  const [phoneScheme, setPhoneScheme] = useState('modern');
  const [borderRadius, setBorderRadius] = useState('md');
  const [fontSize, setFontSize] = useState('base');
  const [density, setDensity] = useState('comfortable');

  // Initial load on mount
  useEffect(() => {
    checkAuth();
    loadDashboardData();
    loadAnalytics(true); // Force initial load
    loadSettings();
  }, []);

  // Load settings from localStorage
  const loadSettings = () => {
    const savedColorTheme = localStorage.getItem('colorTheme');
    const savedPhoneScheme = localStorage.getItem('phoneScheme');
    const savedBorderRadius = localStorage.getItem('borderRadius');
    const savedFontSize = localStorage.getItem('fontSize');
    const savedDensity = localStorage.getItem('density');

    if (savedColorTheme) setColorTheme(savedColorTheme);
    if (savedPhoneScheme) setPhoneScheme(savedPhoneScheme);
    if (savedBorderRadius) setBorderRadius(savedBorderRadius);
    if (savedFontSize) setFontSize(savedFontSize);
    if (savedDensity) setDensity(savedDensity);
  };

  // Save settings to localStorage when they change
  useEffect(() => {
    localStorage.setItem('colorTheme', colorTheme);
    applyColorTheme(colorTheme);
  }, [colorTheme]);

  useEffect(() => {
    localStorage.setItem('phoneScheme', phoneScheme);
  }, [phoneScheme]);

  useEffect(() => {
    localStorage.setItem('borderRadius', borderRadius);
    applyBorderRadius(borderRadius);
  }, [borderRadius]);

  useEffect(() => {
    localStorage.setItem('fontSize', fontSize);
    applyFontSize(fontSize);
  }, [fontSize]);

  useEffect(() => {
    localStorage.setItem('density', density);
    applyDensity(density);
  }, [density]);

  // Apply color theme to document
  const applyColorTheme = (theme: string) => {
    const root = document.documentElement;

    // Remove existing theme classes
    root.classList.remove('theme-blue', 'theme-green', 'theme-purple', 'theme-beige', 'theme-red', 'theme-orange', 'theme-cyan', 'theme-pink', 'theme-teal', 'theme-indigo');

    // Add new theme class
    root.classList.add(`theme-${theme}`);
  };

  // Apply border radius to document
  const applyBorderRadius = (radius: string) => {
    const root = document.documentElement;
    root.classList.remove('radius-none', 'radius-sm', 'radius-md', 'radius-lg', 'radius-xl', 'radius-full');
    root.classList.add(`radius-${radius}`);
  };

  // Apply font size to document
  const applyFontSize = (size: string) => {
    const root = document.documentElement;
    root.classList.remove('font-size-sm', 'font-size-base', 'font-size-lg');
    root.classList.add(`font-size-${size}`);
  };

  // Apply density to document
  const applyDensity = (densityValue: string) => {
    const root = document.documentElement;
    root.classList.remove('density-compact', 'density-comfortable', 'density-spacious');
    root.classList.add(`density-${densityValue}`);
  };

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
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-white to-gray-50 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 transition-all duration-300">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-white/80 dark:bg-gray-800/80 backdrop-blur-md shadow-sm transition-all duration-300">
        <div className="container mx-auto flex items-center justify-between px-6 py-4">
          <div className="animate-fade-in">
            <h1 className="text-3xl font-bold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
              AI Call Dashboard
            </h1>
            {user && (
              <p className="text-sm text-muted-foreground mt-1">
                Welcome back, {user.full_name || user.email}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {/* Live Call Indicator & End Button */}
            {activeCallCount > 0 && (
              <>
                <Badge variant="success" className="animate-pulse-subtle shadow-lg">
                  <span className="h-2 w-2 rounded-full bg-green-500 mr-2 animate-pulse" />
                  {activeCallCount} Active
                </Badge>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleEndActiveCalls}
                  disabled={endingCalls}
                  className="shadow-md hover:shadow-lg transition-all duration-200"
                >
                  <PhoneOff className="mr-2 h-4 w-4" />
                  {endingCalls ? 'Ending...' : activeCallCount > 1 ? 'End All Calls' : 'End Call'}
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowSettings(true)}
              title="Settings"
              className="hover:bg-primary/10 transition-all duration-200"
            >
              <Settings className="h-5 w-5" />
            </Button>
            <Button
              variant="outline"
              onClick={handleLogout}
              className="shadow-sm hover:shadow-md transition-all duration-200"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-6 py-8 animate-fade-in">
        <Tabs defaultValue="delegate" className="space-y-8">
          <TabsList className="grid w-full grid-cols-3 bg-white/50 dark:bg-gray-800/50 backdrop-blur-sm p-1 shadow-md">
            <TabsTrigger
              value="delegate"
              className="data-[state=active]:bg-white data-[state=active]:shadow-md dark:data-[state=active]:bg-gray-700 transition-all duration-200"
            >
              <Send className="mr-2 h-4 w-4" />
              Delegate A Call
            </TabsTrigger>
            <TabsTrigger
              value="billing"
              className="data-[state=active]:bg-white data-[state=active]:shadow-md dark:data-[state=active]:bg-gray-700 transition-all duration-200"
            >
              <DollarSign className="mr-2 h-4 w-4" />
              Billing
            </TabsTrigger>
            <TabsTrigger
              value="calls"
              className="data-[state=active]:bg-white data-[state=active]:shadow-md dark:data-[state=active]:bg-gray-700 transition-all duration-200"
            >
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

      {/* Settings Dialog */}
      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogContent className="sm:max-w-[550px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Appearance Settings</DialogTitle>
            <DialogDescription>
              Customize your dashboard to match your preferences. Changes are applied instantly and saved automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6 py-4">
            {/* Color Theme Selection */}
            <div className="space-y-3">
              <Label htmlFor="color-theme" className="text-base font-semibold">Color Theme</Label>
              <Select value={colorTheme} onValueChange={setColorTheme}>
                <SelectTrigger id="color-theme">
                  <SelectValue placeholder="Select color theme" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="blue">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-4 rounded-full bg-blue-500" />
                      <span>Blue</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="green">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-4 rounded-full bg-green-500" />
                      <span>Green</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="purple">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-4 rounded-full bg-purple-500" />
                      <span>Purple</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="indigo">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-4 rounded-full bg-indigo-500" />
                      <span>Indigo</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="pink">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-4 rounded-full bg-pink-500" />
                      <span>Pink</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="red">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-4 rounded-full bg-red-500" />
                      <span>Red</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="orange">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-4 rounded-full bg-orange-500" />
                      <span>Orange</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="cyan">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-4 rounded-full bg-cyan-500" />
                      <span>Cyan</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="teal">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-4 rounded-full bg-teal-500" />
                      <span>Teal</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="beige">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-4 rounded-full bg-amber-200" />
                      <span>Beige</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Border Radius Selection */}
            <div className="space-y-3">
              <Label htmlFor="border-radius" className="text-base font-semibold">Border Radius</Label>
              <Select value={borderRadius} onValueChange={setBorderRadius}>
                <SelectTrigger id="border-radius">
                  <SelectValue placeholder="Select border radius" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (Sharp corners)</SelectItem>
                  <SelectItem value="sm">Small</SelectItem>
                  <SelectItem value="md">Medium (Default)</SelectItem>
                  <SelectItem value="lg">Large</SelectItem>
                  <SelectItem value="xl">Extra Large</SelectItem>
                  <SelectItem value="full">Full (Pills)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Font Size Selection */}
            <div className="space-y-3">
              <Label htmlFor="font-size" className="text-base font-semibold">Font Size</Label>
              <Select value={fontSize} onValueChange={setFontSize}>
                <SelectTrigger id="font-size">
                  <SelectValue placeholder="Select font size" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sm">Small</SelectItem>
                  <SelectItem value="base">Medium (Default)</SelectItem>
                  <SelectItem value="lg">Large</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Density Selection */}
            <div className="space-y-3">
              <Label htmlFor="density" className="text-base font-semibold">Layout Density</Label>
              <Select value={density} onValueChange={setDensity}>
                <SelectTrigger id="density">
                  <SelectValue placeholder="Select layout density" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="compact">Compact (More content)</SelectItem>
                  <SelectItem value="comfortable">Comfortable (Default)</SelectItem>
                  <SelectItem value="spacious">Spacious (More breathing room)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Phone Scheme/Template Selection */}
            <div className="space-y-3">
              <Label htmlFor="phone-scheme" className="text-base font-semibold">Phone Template</Label>
              <Select value={phoneScheme} onValueChange={setPhoneScheme}>
                <SelectTrigger id="phone-scheme">
                  <SelectValue placeholder="Select phone template" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="modern">Modern</SelectItem>
                  <SelectItem value="classic">Classic</SelectItem>
                  <SelectItem value="minimal">Minimal</SelectItem>
                  <SelectItem value="professional">Professional</SelectItem>
                  <SelectItem value="compact">Compact</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
