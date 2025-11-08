'use client';

/**
 * Real-Time Calls Table with Live Polling
 * Polls /api/calls every second and merges new calls smoothly
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { Call } from '@/lib/types/database';
import { CallsTable } from './calls-table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Play, Pause, RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

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

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const callIdsRef = useRef<Set<string>>(new Set(displayCalls.map(c => c.id)));
  const newCallIdsRef = useRef<Set<string>>(new Set());

  const pollCalls = useCallback(async () => {
    if (!isLive) return;

    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch('/api/calls?limit=100');

      if (!response.ok) {
        throw new Error(`Failed to fetch calls: ${response.status}`);
      }

      const data = await response.json();
      const fetchedCalls: Call[] = data.calls || [];

      // Find truly new calls (not in our existing set)
      const newCalls: Call[] = [];
      const currentCallIds = new Set(callIdsRef.current);

      fetchedCalls.forEach((call) => {
        if (!currentCallIds.has(call.id)) {
          newCalls.push(call);
          newCallIdsRef.current.add(call.id);
        }
      });

      if (newCalls.length > 0) {
        // Merge new calls at the top
        const merged = [...newCalls, ...allCalls];

        // Update our internal state
        setAllCalls(merged);

        // Update ref with all current IDs
        callIdsRef.current = new Set(merged.map(c => c.id));

        // Notify parent of all updated calls
        onCallsUpdate(merged);

        setNewCallsCount((prev) => prev + newCalls.length);

        // Clear the "new" indicator after 5 seconds
        setTimeout(() => {
          newCallIdsRef.current = new Set();
        }, 5000);
      }

      setLastUpdated(new Date());
    } catch (err: any) {
      console.error('Polling error:', err);
      setError(err.message || 'Failed to fetch updates');
    } finally {
      setIsLoading(false);
    }
  }, [isLive, allCalls, onCallsUpdate]);

  // Set up polling interval
  useEffect(() => {
    if (isLive) {
      // Poll immediately
      pollCalls();

      // Then poll every second
      intervalRef.current = setInterval(pollCalls, 1000);

      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
        }
      };
    } else {
      // Clear interval when paused
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    }
  }, [isLive, pollCalls]);

  const toggleLive = () => {
    setIsLive((prev) => !prev);
    if (!isLive) {
      setNewCallsCount(0);
    }
  };

  const handleRefresh = () => {
    setNewCallsCount(0);
    pollCalls();
  };

  return (
    <div className="space-y-4">
      {/* Live Controls */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {/* Live Indicator */}
              <div className="flex items-center gap-2">
                {isLive ? (
                  <>
                    <div className="h-3 w-3 rounded-full bg-green-500 animate-pulse" />
                    <span className="text-sm font-medium text-green-600 dark:text-green-400">
                      Live Updates Active
                    </span>
                  </>
                ) : (
                  <>
                    <div className="h-3 w-3 rounded-full bg-gray-400" />
                    <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                      Updates Paused
                    </span>
                  </>
                )}
              </div>

              {/* New Calls Badge */}
              {newCallsCount > 0 && (
                <Badge variant="success" className="animate-pulse">
                  +{newCallsCount} new call{newCallsCount !== 1 ? 's' : ''}
                </Badge>
              )}

              {/* Loading Indicator */}
              {isLoading && (
                <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
            </div>

            <div className="flex items-center gap-2">
              {/* Last Updated */}
              <span className="text-xs text-muted-foreground">
                Updated {lastUpdated.toLocaleTimeString()}
              </span>

              {/* Refresh Button */}
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={isLoading}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>

              {/* Pause/Resume Toggle */}
              <Button
                variant={isLive ? 'default' : 'outline'}
                size="sm"
                onClick={toggleLive}
              >
                {isLive ? (
                  <>
                    <Pause className="h-4 w-4 mr-2" />
                    Pause
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-2" />
                    Resume
                  </>
                )}
              </Button>
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <div className="mt-4 text-sm text-destructive">
              Error: {error}
            </div>
          )}
        </CardContent>
      </Card>

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
