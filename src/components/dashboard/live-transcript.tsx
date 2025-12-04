'use client';

/**
 * Live Transcript Component
 * Subscribes to Supabase Realtime for live transcript updates via call_transcript_segments
 */

import { useEffect, useState, useRef, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { FileText, Radio, User, Bot } from 'lucide-react';
import type { TranscriptSegment } from '@/lib/types/database';

interface LiveTranscriptProps {
  callId: string;
  status?: string;
}

export function LiveTranscript({
  callId,
  status
}: LiveTranscriptProps) {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [isLive, setIsLive] = useState(
    status === 'answered' || status === 'initiated' || status === 'ringing'
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const supabase = useMemo(() => createClient(), []);

  // Update live status when prop changes
  useEffect(() => {
    setIsLive(
      status === 'answered' || status === 'initiated' || status === 'ringing'
    );
  }, [status]);

  // 1. Fetch existing transcript history on mount
  useEffect(() => {
    if (!callId) return;

    const fetchSegments = async () => {
      try {
        const { data, error } = await supabase
          .from('call_transcript_segments')
          .select('*')
          .eq('call_id', callId)
          .order('created_at', { ascending: true });

        if (error) {
          console.error('Error fetching transcript segments:', error);
          return;
        }

        if (data) {
          setSegments(data);
        }
      } catch (err) {
        console.error('Failed to fetch segments:', err);
      }
    };

    fetchSegments();
  }, [callId, supabase]);

  // 2. Subscribe to NEW segments in real-time
  useEffect(() => {
    if (!callId) return;

    console.log(`Setting up realtime subscription for transcript segments (call_id: ${callId})`);

    const channel = supabase
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
          
          setSegments((prev) => {
            // Simple deduplication check based on ID
            if (prev.some((s) => s.id === newSegment.id)) {
              return prev;
            }
            return [...prev, newSegment];
          });
        }
      )
      .subscribe((status) => {
        console.log(`Transcript subscription status: ${status}`);
      });

    return () => {
      console.log('Cleaning up transcript subscription');
      supabase.removeChannel(channel);
    };
  }, [callId, supabase]);

  // Auto-scroll to bottom when new segments arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [segments]);

  return (
    <Card className="h-[500px] flex flex-col">
      <CardHeader className="py-3 border-b bg-muted/40">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Live Transcript
          </CardTitle>
          <div className="flex items-center gap-2">
            {isLive && (
              <Badge variant="default" className="animate-pulse bg-red-500 hover:bg-red-600 border-none text-white">
                <Radio className="h-3 w-3 mr-1" />
                LIVE
              </Badge>
            )}
            {segments.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {segments.length} messages
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="flex-1 p-0 overflow-hidden relative bg-background">
        <div className="h-full overflow-y-auto p-4">
          <div className="space-y-6">
            {segments.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-[300px] text-muted-foreground">
                {isLive ? (
                  <>
                    <div className="h-2 w-2 rounded-full bg-red-500 animate-pulse mb-2" />
                    <p className="text-sm">Waiting for speech...</p>
                    <p className="text-xs opacity-70 mt-1">Transcript updates will appear here automatically</p>
                  </>
                ) : (
                  <p className="text-sm">No transcript available for this call.</p>
                )}
              </div>
            ) : (
              segments.map((segment) => {
                const isAssistant = segment.speaker === 'assistant';
                
                return (
                  <div
                    key={segment.id}
                    className={`flex gap-3 ${isAssistant ? 'flex-row-reverse' : 'flex-row'}`}
                  >
                    {/* Avatar */}
                    <div
                      className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center border shadow-sm ${
                        isAssistant
                          ? 'bg-primary/10 text-primary border-primary/20'
                          : 'bg-muted text-muted-foreground border-border'
                      }`}
                    >
                      {isAssistant ? (
                        <Bot className="h-4 w-4" />
                      ) : (
                        <User className="h-4 w-4" />
                      )}
                    </div>

                    {/* Message Bubble */}
                    <div
                      className={`flex flex-col max-w-[85%] ${
                        isAssistant ? 'items-end' : 'items-start'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1 px-1">
                        <span className="text-xs font-medium text-foreground capitalize">
                          {segment.speaker}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(segment.created_at).toLocaleTimeString([], { 
                            hour: '2-digit', 
                            minute: '2-digit', 
                            second: '2-digit' 
                          })}
                        </span>
                      </div>
                      
                      <div
                        className={`px-4 py-2.5 rounded-2xl text-sm shadow-sm leading-relaxed ${
                          isAssistant
                            ? 'bg-primary text-primary-foreground rounded-tr-none'
                            : 'bg-muted/50 border border-border rounded-tl-none'
                        }`}
                      >
                        {segment.text}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={scrollRef} className="h-px" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
