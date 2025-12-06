'use client';

/**
 * Groq Logs Viewer Component
 * Displays Groq LLM inputs and outputs side-by-side for prompt testing
 */

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  RefreshCw,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Zap,
  Clock,
  Hash,
  ArrowRight,
  Copy,
  Check,
} from 'lucide-react';

interface GroqLogEntry {
  id: string;
  timestamp: string;
  functionName: string;
  requestOptions: {
    model: string;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
  };
  messages: Array<{
    role: string;
    content: string;
  }>;
  output: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  finishReason?: string;
}

interface CallLogs {
  callId: string;
  logs: GroqLogEntry[];
}

export function GroqLogsViewer() {
  const [allLogs, setAllLogs] = useState<CallLogs[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/groq-logs');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch logs');
      }

      setAllLogs(data.data || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Auto-refresh every 5 seconds if enabled
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs]);

  const toggleLogExpanded = (logId: string) => {
    setExpandedLogs(prev => {
      const newSet = new Set(prev);
      if (newSet.has(logId)) {
        newSet.delete(logId);
      } else {
        newSet.add(logId);
      }
      return newSet;
    });
  };

  const toggleMessagesExpanded = (logId: string) => {
    setExpandedMessages(prev => {
      const newSet = new Set(prev);
      if (newSet.has(logId)) {
        newSet.delete(logId);
      } else {
        newSet.add(logId);
      }
      return newSet;
    });
  };

  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const totalLogs = allLogs.reduce((acc, call) => acc + call.logs.length, 0);

  return (
    <Card className="w-full">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Groq LLM Logs</CardTitle>
            <Badge variant="secondary" className="ml-2">
              {totalLogs} logs
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={autoRefresh ? "default" : "outline"}
              size="sm"
              onClick={() => setAutoRefresh(!autoRefresh)}
              className="h-8"
            >
              {autoRefresh ? "Auto-refresh ON" : "Auto-refresh"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchLogs}
              disabled={loading}
              className="h-8"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
        <CardDescription>
          View LLM inputs and outputs side-by-side for prompt testing
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <div className="p-3 bg-red-50 text-red-900 dark:bg-red-900/10 dark:text-red-400 rounded-md text-sm">
            {error}
          </div>
        )}

        {allLogs.length === 0 && !loading && !error && (
          <div className="text-center py-8 text-muted-foreground">
            No Groq logs yet. Make a call to see LLM interactions.
          </div>
        )}

        {allLogs.map((callData) => (
          <div key={callData.callId} className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Hash className="h-4 w-4" />
              Call: {callData.callId.substring(0, 20)}...
              <Badge variant="outline" className="ml-auto">
                {callData.logs.length} interactions
              </Badge>
            </div>

            {callData.logs.map((log) => {
              const isExpanded = expandedLogs.has(log.id);
              const areMessagesExpanded = expandedMessages.has(log.id);

              return (
                <div
                  key={log.id}
                  className="border rounded-lg overflow-hidden bg-card"
                >
                  {/* Header - Always visible */}
                  <button
                    onClick={() => toggleLogExpanded(log.id)}
                    className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <Badge
                        variant={log.functionName === 'generateAssistantReply' ? 'default' : 'secondary'}
                      >
                        {log.functionName === 'generateAssistantReply' ? 'Reply' : 'Summary'}
                      </Badge>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {formatTimestamp(log.timestamp)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {log.requestOptions.model}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {log.usage && (
                        <span className="text-xs text-muted-foreground">
                          {log.usage.total_tokens} tokens
                        </span>
                      )}
                      {isExpanded ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </div>
                  </button>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div className="border-t">
                      {/* Parameters Row */}
                      <div className="px-4 py-2 bg-muted/30 flex flex-wrap gap-4 text-xs">
                        <span>
                          <strong>Temp:</strong> {log.requestOptions.temperature ?? 'default'}
                        </span>
                        <span>
                          <strong>Max Tokens:</strong> {log.requestOptions.max_tokens ?? 'default'}
                        </span>
                        {log.requestOptions.top_p !== undefined && (
                          <span>
                            <strong>Top P:</strong> {log.requestOptions.top_p}
                          </span>
                        )}
                        {log.finishReason && (
                          <span>
                            <strong>Finish:</strong> {log.finishReason}
                          </span>
                        )}
                        {log.usage && (
                          <span className="ml-auto">
                            <strong>Usage:</strong> {log.usage.prompt_tokens} prompt + {log.usage.completion_tokens} completion = {log.usage.total_tokens} total
                          </span>
                        )}
                      </div>

                      {/* Input/Output Split View */}
                      <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x">
                        {/* INPUT SIDE */}
                        <div className="p-4">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2 text-sm font-medium">
                              <MessageSquare className="h-4 w-4 text-blue-500" />
                              INPUT ({log.messages.length} messages)
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2"
                                onClick={() => toggleMessagesExpanded(log.id)}
                              >
                                {areMessagesExpanded ? 'Collapse' : 'Expand All'}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2"
                                onClick={() => copyToClipboard(
                                  JSON.stringify(log.messages, null, 2),
                                  `input-${log.id}`
                                )}
                              >
                                {copiedId === `input-${log.id}` ? (
                                  <Check className="h-3 w-3" />
                                ) : (
                                  <Copy className="h-3 w-3" />
                                )}
                              </Button>
                            </div>
                          </div>

                          <div className="space-y-2 max-h-[400px] overflow-y-auto">
                            {log.messages.map((msg, idx) => (
                              <div
                                key={idx}
                                className="rounded border bg-muted/20 overflow-hidden"
                              >
                                <div className="px-2 py-1 bg-muted/50 text-xs font-medium flex items-center justify-between">
                                  <Badge
                                    variant={
                                      msg.role === 'system'
                                        ? 'destructive'
                                        : msg.role === 'assistant'
                                        ? 'default'
                                        : 'secondary'
                                    }
                                    className="text-[10px] h-5"
                                  >
                                    {msg.role.toUpperCase()}
                                  </Badge>
                                  <span className="text-muted-foreground">
                                    {msg.content.length} chars
                                  </span>
                                </div>
                                <pre
                                  className={`p-2 text-xs whitespace-pre-wrap font-mono ${
                                    areMessagesExpanded ? '' : 'max-h-[100px] overflow-hidden'
                                  }`}
                                >
                                  {msg.content}
                                </pre>
                                {!areMessagesExpanded && msg.content.length > 300 && (
                                  <div className="px-2 pb-1 text-xs text-muted-foreground">
                                    ... (click Expand All to see more)
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* OUTPUT SIDE */}
                        <div className="p-4">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2 text-sm font-medium">
                              <ArrowRight className="h-4 w-4 text-green-500" />
                              OUTPUT
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2"
                              onClick={() => copyToClipboard(log.output, `output-${log.id}`)}
                            >
                              {copiedId === `output-${log.id}` ? (
                                <Check className="h-3 w-3" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </Button>
                          </div>

                          <div className="rounded border bg-green-50 dark:bg-green-900/10 p-3">
                            <pre className="text-sm whitespace-pre-wrap font-mono">
                              {log.output || '(empty response)'}
                            </pre>
                          </div>

                          <div className="mt-2 text-xs text-muted-foreground">
                            {log.output.length} characters
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
