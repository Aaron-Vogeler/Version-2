'use client';

/**
 * Real-Time Calls Table with Supabase Realtime
 * Uses WebSockets to receive live database changes without polling
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Call } from '@/lib/types/database';
import { CallsTable } from './calls-table';

interface RealTimeCallsTableProps {
  displayCalls: Call[]; // The filtered calls to display
  onViewDetails?: (call: Call) => void;
  onCallsUpdate: (calls: Call[]) => void; // Callback when all calls are updated
}

export function RealTimeCallsTable({ displayCalls, onViewDetails, onCallsUpdate }: RealTimeCallsTableProps) {
  const [allCalls, setAllCalls] = useState<Call[]>(displayCalls); // All unfiltered calls
  const [isLive, setIsLive] = useState(true);
  const [newCallsCount, setNewCallsCount] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string>('connecting');

  const callIdsRef = useRef<Set<string>>(new Set(displayCalls.map(c => c.id)));
  const newCallIdsRef = useRef<Set<string>>(new Set());
  const supabase = createClient();

  // Load initial data once
  const loadInitialData = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch('/api/calls?limit=100');

      if (!response.ok) {
        throw new Error(`Failed to fetch calls: ${response.status}`);
      }

      const data = await response.json();
      const fetchedCalls: Call[] = data.calls || [];

      setAllCalls(fetchedCalls);
      callIdsRef.current = new Set(fetchedCalls.map(c => c.id));
      onCallsUpdate(fetchedCalls);
      setLastUpdated(new Date());
    } catch (err: any) {
      console.error('Error loading initial data:', err);
      setError(err.message || 'Failed to load calls');
    } finally {
      setIsLoading(false);
    }
  }, [onCallsUpdate]);

  // Set up Supabase Realtime subscription
  useEffect(() => {
    if (!isLive) return;

    // Load initial data
    loadInitialData();

    console.log('Setting up Supabase Realtime subscription...');

    // Subscribe to all changes on calls table
    const channel = supabase
      .channel('realtime-calls-table')
      .on(
        'postgres_changes',
        {
          event: '*', // Listen to INSERT, UPDATE, DELETE
          schema: 'public',
          table: 'calls',
        },
        (payload) => {
          console.log('Received realtime update:', payload);

          setLastUpdated(new Date());

          if (payload.eventType === 'INSERT') {
            // New call created
            const newCall = payload.new as Call;

            if (!callIdsRef.current.has(newCall.id)) {
              setAllCalls((prev) => {
                const updated = [newCall, ...prev];
                callIdsRef.current.add(newCall.id);
                onCallsUpdate(updated);
                return updated;
              });

              // Mark as new for animation
              newCallIdsRef.current.add(newCall.id);
              setNewCallsCount((prev) => prev + 1);

              // Clear the "new" indicator after 5 seconds
              setTimeout(() => {
                newCallIdsRef.current.delete(newCall.id);
              }, 5000);
            }
          } else if (payload.eventType === 'UPDATE') {
            // Existing call updated
            const updatedCall = payload.new as Call;

            setAllCalls((prev) => {
              const updated = prev.map((call) =>
                call.id === updatedCall.id ? updatedCall : call
              );
              onCallsUpdate(updated);
              return updated;
            });
          } else if (payload.eventType === 'DELETE') {
            // Call deleted
            const deletedCall = payload.old as Call;

            setAllCalls((prev) => {
              const updated = prev.filter((call) => call.id !== deletedCall.id);
              callIdsRef.current.delete(deletedCall.id);
              onCallsUpdate(updated);
              return updated;
            });
          }
        }
      )
      .subscribe((status) => {
        console.log('Realtime subscription status:', status);
        setConnectionStatus(status);
      });

    // Cleanup subscription on unmount or when paused
    return () => {
      console.log('Cleaning up Realtime subscription');
      supabase.removeChannel(channel);
    };
  }, [isLive, supabase, onCallsUpdate, loadInitialData]);

  const toggleLive = () => {
    setIsLive((prev) => !prev);
    if (!isLive) {
      setNewCallsCount(0);
    }
  };

  const handleRefresh = () => {
    setNewCallsCount(0);
    loadInitialData();
  };

  return (
    <div>
      {/* Calls Table - Display the filtered calls passed from parent */}
      <div className="real-time-calls-container">
        <style jsx global>{`
          @keyframes slideInFromTop {
            from {
              opacity: 0;
              transform: translateY(-10px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }

          ${Array.from(newCallIdsRef.current).map(
            (id) => `
            tr[data-call-id="${id}"] {
              animation: slideInFromTop 0.5s ease-out;
              background-color: rgba(34, 197, 94, 0.1);
            }
            tr[data-call-id="${id}"]:hover {
              background-color: rgba(34, 197, 94, 0.15);
            }
          `
          ).join('\n')}
        `}</style>

        <CallsTable calls={displayCalls} onViewDetails={onViewDetails} />
      </div>
    </div>
  );
}
