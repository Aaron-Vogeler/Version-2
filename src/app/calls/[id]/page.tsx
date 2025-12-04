'use client';

/**
 * Call Detail Page
 * Displays comprehensive call information with live transcript
 */

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Call } from '@/lib/types/database';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { LiveTranscript } from '@/components/dashboard/live-transcript';
import { ListenInBrowser } from '@/components/dashboard/listen-in-browser';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatPhoneNumber, formatDuration, formatCurrency, formatDateTime } from '@/lib/utils';

export default function CallDetailPage() {
  const params = useParams();
  const router = useRouter();
  const callId = params?.id as string | undefined;

  const [call, setCall] = useState<Call | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!callId) {
      setError('No call ID provided');
      setLoading(false);
      return;
    }

    const loadCall = async () => {
      try {
        setLoading(true);
        const supabase = createClient();

        const { data, error: fetchError } = await supabase
          .from('calls')
          .select('*')
          .eq('id', callId)
          .single();

        if (fetchError) throw fetchError;

        setCall(data);
      } catch (err: any) {
        console.error('Error loading call:', err);
        setError(err.message || 'Failed to load call details');
      } finally {
        setLoading(false);
      }
    };

    loadCall();
  }, [callId]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-2">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span>Loading call details...</span>
        </div>
      </div>
    );
  }

  if (error || !call) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center space-y-4">
          <h2 className="text-2xl font-bold text-destructive">Error</h2>
          <p className="text-muted-foreground">{error || 'Call not found'}</p>
          <Button onClick={() => router.push('/dashboard')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Dashboard
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Button
            variant="ghost"
            onClick={() => router.push('/dashboard')}
            className="mb-2"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Dashboard
          </Button>
          <h1 className="text-3xl font-bold">Call Details</h1>
          <p className="text-muted-foreground">
            {formatPhoneNumber(call.from_e164)} → {formatPhoneNumber(call.to_e164)}
          </p>
        </div>
        <Badge variant={call.status === 'completed' ? 'success' : 'default'}>
          {call.status.toUpperCase()}
        </Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Call Info */}
        <div className="lg:col-span-1 space-y-4">
          {/* Goal */}
          {call.goal && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Goal</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <Badge>{call.goal}</Badge>
                  {call.goal_status && (
                    <p className="text-sm text-muted-foreground capitalize">
                      Status: {call.goal_status}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Call Stats */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Call Statistics</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">Direction:</span>
                <span className="text-sm font-medium capitalize">{call.direction}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">Duration:</span>
                <span className="text-sm font-medium">
                  {formatDuration(call.duration_sec || 0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">Billable:</span>
                <span className="text-sm font-medium">
                  {formatDuration(call.billable_sec || 0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">Cost:</span>
                <span className="text-sm font-medium">
                  {formatCurrency(Number(call.cost_usd) || 0)}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Timestamps */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Timestamps</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Started:</span>
                <span>{call.started_at ? formatDateTime(call.started_at) : '-'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Answered:</span>
                <span>{call.answered_at ? formatDateTime(call.answered_at) : '-'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Ended:</span>
                <span>{call.ended_at ? formatDateTime(call.ended_at) : '-'}</span>
              </div>
            </CardContent>
          </Card>

          {/* Recording */}
          {call.recording_url && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Recording</CardTitle>
              </CardHeader>
              <CardContent>
                <audio
                  controls
                  className="w-full"
                  src={call.recording_url}
                >
                  Your browser does not support the audio element.
                </audio>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right Column - Listen in Browser & Live Transcript */}
        <div className="lg:col-span-2 space-y-4">
          <ListenInBrowser
            callId={call.id}
            isCallOngoing={call.status !== 'completed'}
          />
          <LiveTranscript
            callId={call.id}
            status={call.status}
          />
        </div>
      </div>
    </div>
  );
}
