'use client';

/**
 * Live Transcript Component
 * Subscribes to Supabase Realtime for live transcript updates
 */

import { useEffect, useState, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FileText, Radio } from 'lucide-react';

interface LiveTranscriptProps {
  callId: string;
  initialTranscript?: string | null;
  initialLiveTranscript?: string | null;
  status?: string;
}

export function LiveTranscript({
  callId,
  initialTranscript,
  initialLiveTranscript,
  status
}: LiveTranscriptProps) {
  const [liveTranscript, setLiveTranscript] = useState(initialLiveTranscript || '');
  const [isLive, setIsLive] = useState(status === 'answered' || status === 'initiated' || status === 'ringing');
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const supabase = createClient();

  // Auto-scroll to bottom when transcript updates
  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [liveTranscript]);

  useEffect(() => {
    if (!callId) return;

    // Subscribe to realtime updates for this specific call
    const channel = supabase
      .channel(`call-${callId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'calls',
          filter: `id=eq.${callId}`,
        },
        (payload) => {
          console.log('Received realtime update:', payload);

          const newCall = payload.new as any;

          // Update live transcript if it changed
          if (newCall.live_transcript !== undefined) {
            setLiveTranscript(newCall.live_transcript || '');
            setLastUpdate(new Date());
          }

          // Update live status based on call status
          if (newCall.status) {
            const callIsLive = ['initiated', 'ringing', 'answered'].includes(newCall.status);
            setIsLive(callIsLive);
          }
        }
      )
      .subscribe((status) => {
        console.log('Realtime subscription status:', status);
      });

    // Cleanup subscription on unmount
    return () => {
      console.log('Cleaning up realtime subscription');
      supabase.removeChannel(channel);
    };
  }, [callId, supabase]);

  // Determine what to display
  const displayTranscript = liveTranscript || initialTranscript;
  const hasTranscript = displayTranscript && displayTranscript.trim().length > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <FileText className="h-4 w-4" />
            {isLive ? 'Live Transcript' : 'Call Transcript'}
          </CardTitle>
          <div className="flex items-center gap-2">
            {isLive && (
              <Badge variant="default" className="animate-pulse">
                <Radio className="h-3 w-3 mr-1" />
                LIVE
              </Badge>
            )}
            {lastUpdate && (
              <span className="text-xs text-muted-foreground">
                Updated {lastUpdate.toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="max-h-[400px] overflow-y-auto">
          {hasTranscript ? (
            <div className="prose prose-sm max-w-none">
              <pre className="whitespace-pre-wrap font-sans text-sm bg-muted/30 p-4 rounded-md">
                {displayTranscript}
              </pre>
              <div ref={transcriptEndRef} />
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              {isLive ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-center gap-2">
                    <div className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                    <span>Waiting for transcript...</span>
                  </div>
                  <p className="text-xs">The transcript will appear here as the call progresses</p>
                </div>
              ) : (
                <div>
                  {status === 'completed'
                    ? 'No transcript available for this call'
                    : 'Call has not started yet'}
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
