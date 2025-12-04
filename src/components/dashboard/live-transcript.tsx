'use client';

/**
 * Live Transcript Component
 * Fetches and displays real-time transcript segments from call_transcript_segments table
 */

import { useEffect, useState, useRef, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { TranscriptSegment } from '@/lib/types/database';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FileText, Radio } from 'lucide-react';

interface LiveTranscriptProps {
  callId: string;
  status?: string;
}

export function LiveTranscript({ callId, status }: LiveTranscriptProps) {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [isLive, setIsLive] = useState(status === 'answered' || status === 'initiated' || status === 'ringing');
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Create supabase client only once
  const supabase = useMemo(() => createClient(), []);

  // Auto-scroll to bottom when segments update
  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [segments]);

  useEffect(() => {
    if (!callId) return;

    let isMounted = true;
    let channel: any = null;

    const initializeTranscript = async () => {
      try {
        // Fetch existing segments
        const { data, error } = await supabase
          .from('call_transcript_segments')
          .select('*')
          .eq('call_id', callId)
          .order('created_at', { ascending: true });

        if (error) throw error;

        if (!isMounted) return;

        setSegments(data || []);
        setIsLoading(false);

        // Subscribe to new segments
        channel = supabase
          .channel(`transcript-${callId}`)
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'call_transcript_segments',
              filter: `call_id=eq.${callId}`,
            },
            (payload) => {
              console.log('Received new transcript segment:', payload);

              const newSegment = payload.new as TranscriptSegment;

              // Prevent duplicates
              setSegments((prevSegments) => {
                if (prevSegments.some((s) => s.id === newSegment.id)) {
                  return prevSegments;
                }
                return [...prevSegments, newSegment];
              });

              setLastUpdate(new Date());
            }
          )
          .subscribe((subscriptionStatus) => {
            console.log('Transcript realtime subscription status:', subscriptionStatus);
          });
      } catch (err) {
        console.error('Error initializing transcript:', err);
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    initializeTranscript();

    return () => {
      isMounted = false;
      if (channel) {
        console.log('Cleaning up transcript realtime subscription');
        supabase.removeChannel(channel);
      }
    };
  }, [callId]);

  const hasSegments = segments.length > 0;

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
        <div className="max-h-[400px] overflow-y-auto space-y-3">
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">
              <div className="flex items-center justify-center gap-2">
                <div className="h-2 w-2 rounded-full bg-muted-foreground animate-pulse" />
                <span>Loading transcript...</span>
              </div>
            </div>
          ) : hasSegments ? (
            <>
              {segments.map((segment) => (
                <div
                  key={segment.id}
                  className={`flex gap-3 ${
                    segment.speaker === 'assistant' ? 'flex-row-reverse' : ''
                  }`}
                >
                  {/* Speaker Badge */}
                  <div className="flex-shrink-0 pt-0.5">
                    <Badge
                      variant={segment.speaker === 'assistant' ? 'default' : 'secondary'}
                      className="text-xs whitespace-nowrap"
                    >
                      {segment.speaker === 'assistant' ? 'Assistant' : 'Caller'}
                    </Badge>
                  </div>

                  {/* Message Bubble */}
                  <div
                    className={`flex-1 px-3 py-2 rounded-lg ${
                      segment.speaker === 'assistant'
                        ? 'bg-blue-100 dark:bg-blue-900 text-blue-900 dark:text-blue-100'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100'
                    }`}
                  >
                    <p className="text-sm leading-relaxed">{segment.text}</p>
                    {segment.confidence !== null && (
                      <p className="text-xs opacity-70 mt-1">
                        Confidence: {(segment.confidence * 100).toFixed(1)}%
                      </p>
                    )}
                  </div>
                </div>
              ))}
              <div ref={transcriptEndRef} />
            </>
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
