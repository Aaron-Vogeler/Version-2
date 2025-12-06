'use client';

/**
 * Live LLM Exchange Component
 * Subscribes to Supabase Realtime for live Groq input/output display
 * Shows side-by-side comparison of LLM inputs and outputs
 */

import { useEffect, useState, useRef, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Brain, Radio, ChevronDown, ChevronRight, Clock, Zap } from 'lucide-react';

interface LLMExchange {
  id: string;
  call_id: string;
  model: string;
  temperature: number | null;
  max_tokens: number | null;
  top_p: number | null;
  frequency_penalty: number | null;
  presence_penalty: number | null;
  stop_sequences: string[] | null;
  messages: Array<{ role: string; content: string }>;
  response_text: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  finish_reason: string | null;
  duration_ms: number | null;
  created_at: string;
}

interface LiveLLMExchangeProps {
  callId: string;
  status?: string;
}

function ExchangeCard({ exchange, index }: { exchange: LLMExchange; index: number }) {
  const [expanded, setExpanded] = useState(index === 0); // First one expanded by default

  const formatTime = (isoString: string) => {
    return new Date(isoString).toLocaleTimeString();
  };

  const truncateText = (text: string, maxLength: number = 100) => {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
  };

  // Get the last user message (the input that triggered this response)
  const lastUserMessage = exchange.messages
    .filter(m => m.role === 'user')
    .pop();

  return (
    <div className="border rounded-lg overflow-hidden bg-card">
      {/* Header - clickable to expand/collapse */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-xs font-mono text-muted-foreground">
            #{index + 1}
          </span>
          <span className="text-sm font-medium truncate max-w-[200px]">
            {lastUserMessage ? truncateText(lastUserMessage.content, 50) : 'System'}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {exchange.duration_ms}ms
          </span>
          <span className="flex items-center gap-1">
            <Zap className="h-3 w-3" />
            {exchange.total_tokens} tok
          </span>
          <span>{formatTime(exchange.created_at)}</span>
        </div>
      </button>

      {/* Expanded content - side by side */}
      {expanded && (
        <div className="border-t">
          <div className="grid grid-cols-2 divide-x">
            {/* INPUT Column */}
            <div className="p-4 space-y-3">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Input
              </div>

              {/* Parameters */}
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Model:</span>
                  <span className="font-mono">{exchange.model}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Temperature:</span>
                  <span className="font-mono">{exchange.temperature ?? 'default'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Max Tokens:</span>
                  <span className="font-mono">{exchange.max_tokens ?? 'default'}</span>
                </div>
                {exchange.top_p && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Top P:</span>
                    <span className="font-mono">{exchange.top_p}</span>
                  </div>
                )}
              </div>

              {/* Messages */}
              <div className="space-y-2 pt-2 border-t">
                <div className="text-xs font-medium text-muted-foreground">
                  Messages ({exchange.messages.length}):
                </div>
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {exchange.messages.map((msg, i) => (
                    <div key={i} className="text-xs">
                      <div className={`font-semibold uppercase ${
                        msg.role === 'system' ? 'text-purple-600 dark:text-purple-400' :
                        msg.role === 'assistant' ? 'text-blue-600 dark:text-blue-400' :
                        'text-green-600 dark:text-green-400'
                      }`}>
                        [{msg.role}]
                      </div>
                      <div className="mt-1 bg-muted/50 p-2 rounded text-[11px] font-mono whitespace-pre-wrap break-words max-h-[150px] overflow-y-auto">
                        {msg.content.length > 500
                          ? msg.content.slice(0, 500) + `\n\n... [${msg.content.length - 500} more chars]`
                          : msg.content
                        }
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* OUTPUT Column */}
            <div className="p-4 space-y-3">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Output
              </div>

              {/* Stats */}
              <div className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Duration:</span>
                  <span className="font-mono">{exchange.duration_ms}ms</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tokens:</span>
                  <span className="font-mono">
                    {exchange.prompt_tokens} in → {exchange.completion_tokens} out
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total:</span>
                  <span className="font-mono">{exchange.total_tokens} tokens</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Finish:</span>
                  <span className="font-mono">{exchange.finish_reason || '?'}</span>
                </div>
              </div>

              {/* Response */}
              <div className="space-y-2 pt-2 border-t">
                <div className="text-xs font-medium text-muted-foreground">
                  Response:
                </div>
                <div className="bg-muted/50 p-3 rounded text-sm font-mono whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto">
                  {exchange.response_text || '(empty)'}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function LiveLLMExchange({ callId, status }: LiveLLMExchangeProps) {
  const [exchanges, setExchanges] = useState<LLMExchange[]>([]);
  const [isLive, setIsLive] = useState(
    status === 'answered' || status === 'initiated' || status === 'ringing'
  );
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const supabase = useMemo(() => createClient(), []);

  // Auto-scroll to bottom when new exchanges arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [exchanges]);

  // Fetch initial exchanges
  useEffect(() => {
    if (!callId) return;

    const fetchExchanges = async () => {
      const { data, error } = await supabase
        .from('call_llm_exchanges')
        .select('*')
        .eq('call_id', callId)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Error fetching LLM exchanges:', error);
        return;
      }

      if (data) {
        const typedData = data as LLMExchange[];
        setExchanges(typedData);
        if (typedData.length > 0) {
          setLastUpdate(new Date(typedData[typedData.length - 1].created_at));
        }
      }
    };

    fetchExchanges();
  }, [callId, supabase]);

  // Subscribe to realtime updates
  useEffect(() => {
    if (!callId) return;

    const channel = supabase
      .channel(`llm-exchanges-${callId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'call_llm_exchanges',
          filter: `call_id=eq.${callId}`,
        },
        (payload) => {
          console.log('New LLM exchange:', payload);
          const newExchange = payload.new as LLMExchange;
          setExchanges(prev => [...prev, newExchange]);
          setLastUpdate(new Date());
        }
      )
      .subscribe((status) => {
        console.log('LLM exchanges subscription status:', status);
      });

    // Also subscribe to call status changes
    const statusChannel = supabase
      .channel(`call-status-${callId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'calls',
          filter: `id=eq.${callId}`,
        },
        (payload) => {
          const newCall = payload.new as any;
          if (newCall.status) {
            const callIsLive = ['initiated', 'ringing', 'answered'].includes(newCall.status);
            setIsLive(callIsLive);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(statusChannel);
    };
  }, [callId, supabase]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Brain className="h-4 w-4" />
            LLM Exchanges
          </CardTitle>
          <div className="flex items-center gap-2">
            {isLive && (
              <Badge variant="default" className="animate-pulse">
                <Radio className="h-3 w-3 mr-1" />
                LIVE
              </Badge>
            )}
            {exchanges.length > 0 && (
              <Badge variant="secondary">
                {exchanges.length} exchange{exchanges.length !== 1 ? 's' : ''}
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
        <div className="space-y-3 max-h-[600px] overflow-y-auto">
          {exchanges.length > 0 ? (
            <>
              {exchanges.map((exchange, index) => (
                <ExchangeCard
                  key={exchange.id}
                  exchange={exchange}
                  index={index}
                />
              ))}
              <div ref={scrollRef} />
            </>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              {isLive ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-center gap-2">
                    <div className="h-2 w-2 rounded-full bg-purple-500 animate-pulse" />
                    <span>Waiting for LLM exchanges...</span>
                  </div>
                  <p className="text-xs">
                    Groq inputs and outputs will appear here in real-time
                  </p>
                </div>
              ) : (
                <div>
                  {status === 'completed'
                    ? 'No LLM exchanges recorded for this call'
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
