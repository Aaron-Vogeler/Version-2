'use client';

/**
 * Live Call Observer Component
 * ============================
 * Allows users to listen to an active call in real-time via WebSocket.
 * Features:
 * - Real-time audio playback (stereo: left=caller, right=assistant)
 * - Live transcript display
 * - Volume control
 * - Connection status indicator
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import {
  Headphones,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  User,
  Bot,
  Radio,
  Square,
  CircleOff,
} from 'lucide-react';
import { MulawAudioPlayer } from '@/lib/audio/mulaw-decoder';

interface TranscriptEntry {
  speaker: 'caller' | 'assistant';
  text: string;
  timestamp: number;
  isFinal: boolean;
}

interface LiveCallObserverProps {
  /** The call control ID to observe */
  callControlId: string;
  /** Optional user ID for authorization */
  userId?: string;
  /** Called when observer disconnects or call ends */
  onDisconnect?: () => void;
  /** AI Server WebSocket URL (defaults to Fly.io production) */
  aiServerUrl?: string;
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
type AudioState = 'stopped' | 'buffering' | 'playing';

export function LiveCallObserver({
  callControlId,
  userId,
  onDisconnect,
  aiServerUrl,
}: LiveCallObserverProps) {
  // Connection state
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Audio state
  const [audioState, setAudioState] = useState<AudioState>('stopped');
  const [isListening, setIsListening] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);

  // Transcript state
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Call info
  const [callInfo, setCallInfo] = useState<{
    goal?: string;
    assistantName?: string;
  } | null>(null);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const audioPlayerRef = useRef<MulawAudioPlayer | null>(null);

  // Auto-scroll transcripts
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcripts]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, []);

  // Update audio player volume
  useEffect(() => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.setVolume(isMuted ? 0 : volume);
    }
  }, [volume, isMuted]);

  /**
   * Build the WebSocket URL for the observer endpoint
   */
  const buildWsUrl = useCallback(() => {
    // Determine the base URL
    let baseUrl = aiServerUrl;

    if (!baseUrl) {
      // Auto-detect based on environment
      if (typeof window !== 'undefined') {
        // In browser, use relative path or configured URL
        const isLocalhost = window.location.hostname === 'localhost';
        if (isLocalhost) {
          // Local development - ai-server runs on port 3001
          baseUrl = 'ws://localhost:3001';
        } else {
          // Production - use the Fly.io server
          baseUrl = process.env.NEXT_PUBLIC_AI_SERVER_WS_URL || 'wss://delegator-ai-server.fly.dev';
        }
      }
    }

    // Build observer URL with optional userId
    let url = `${baseUrl}/observe/${encodeURIComponent(callControlId)}`;
    if (userId) {
      url += `?userId=${encodeURIComponent(userId)}`;
    }

    return url;
  }, [callControlId, userId, aiServerUrl]);

  /**
   * Connect to the observer WebSocket
   */
  const connect = useCallback(async () => {
    if (wsRef.current) {
      console.log('[Observer] Already connected');
      return;
    }

    try {
      setConnectionState('connecting');
      setErrorMessage(null);

      // Initialize audio player (requires user gesture, hence in connect)
      if (!audioPlayerRef.current) {
        audioPlayerRef.current = new MulawAudioPlayer((state) => {
          setAudioState(state);
        });
      }
      await audioPlayerRef.current.initialize();

      // Connect to WebSocket
      const wsUrl = buildWsUrl();
      console.log('[Observer] Connecting to:', wsUrl);

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[Observer] Connected');
        setConnectionState('connected');
        setIsListening(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          switch (msg.event) {
            case 'connected':
              console.log('[Observer] Received connection info:', msg);
              setCallInfo({
                goal: msg.goal,
                assistantName: msg.assistantName,
              });
              break;

            case 'audio':
              // Add audio to player
              if (audioPlayerRef.current && isListening) {
                audioPlayerRef.current.addAudio(msg.track, msg.payload);
              }
              break;

            case 'transcript':
              // Add transcript entry
              setTranscripts((prev) => {
                const newEntry: TranscriptEntry = {
                  speaker: msg.speaker,
                  text: msg.text,
                  timestamp: msg.timestamp,
                  isFinal: msg.isFinal,
                };

                // If interim transcript, update last entry for same speaker
                if (!msg.isFinal && prev.length > 0) {
                  const lastEntry = prev[prev.length - 1];
                  if (lastEntry.speaker === msg.speaker && !lastEntry.isFinal) {
                    return [...prev.slice(0, -1), newEntry];
                  }
                }

                return [...prev, newEntry];
              });
              break;

            case 'call_state':
              console.log('[Observer] Call state changed:', msg.state);
              if (msg.state === 'ended') {
                disconnect();
              }
              break;

            case 'pong':
              // Keepalive response
              break;

            default:
              console.log('[Observer] Unknown event:', msg.event);
          }
        } catch (error) {
          console.error('[Observer] Error parsing message:', error);
        }
      };

      ws.onerror = (error) => {
        console.error('[Observer] WebSocket error:', error);
        setConnectionState('error');
        setErrorMessage('Connection error');
      };

      ws.onclose = (event) => {
        console.log('[Observer] Disconnected:', event.code, event.reason);
        setConnectionState('disconnected');
        setIsListening(false);
        wsRef.current = null;

        if (event.code !== 1000) {
          setErrorMessage(event.reason || 'Connection closed unexpectedly');
        }

        onDisconnect?.();
      };

      // Setup keepalive ping
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: 'ping' }));
        }
      }, 30000);

      // Clear interval on close
      ws.addEventListener('close', () => clearInterval(pingInterval));

    } catch (error) {
      console.error('[Observer] Connection error:', error);
      setConnectionState('error');
      setErrorMessage(error instanceof Error ? error.message : 'Failed to connect');
    }
  }, [buildWsUrl, isListening, onDisconnect]);

  /**
   * Disconnect from the observer WebSocket
   */
  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close(1000, 'User disconnected');
      wsRef.current = null;
    }

    if (audioPlayerRef.current) {
      audioPlayerRef.current.stop();
    }

    setConnectionState('disconnected');
    setIsListening(false);
    setAudioState('stopped');
  }, []);

  /**
   * Toggle listening state
   */
  const toggleListening = useCallback(() => {
    if (connectionState === 'disconnected') {
      connect();
    } else {
      disconnect();
    }
  }, [connectionState, connect, disconnect]);

  /**
   * Format timestamp for display
   */
  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  return (
    <Card className="w-full">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Radio className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Live Call Observer</CardTitle>
            {connectionState === 'connected' && (
              <Badge variant="success" className="gap-1 animate-pulse">
                <span className="h-2 w-2 rounded-full bg-green-500" />
                Live
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Connection Status */}
            {connectionState === 'connected' ? (
              <Wifi className="h-4 w-4 text-green-500" />
            ) : connectionState === 'connecting' ? (
              <Wifi className="h-4 w-4 text-yellow-500 animate-pulse" />
            ) : (
              <WifiOff className="h-4 w-4 text-muted-foreground" />
            )}

            {/* Audio Status */}
            {audioState === 'playing' && (
              <Badge variant="outline" className="gap-1">
                <Volume2 className="h-3 w-3" />
                Playing
              </Badge>
            )}
            {audioState === 'buffering' && (
              <Badge variant="outline" className="gap-1 animate-pulse">
                Buffering...
              </Badge>
            )}
          </div>
        </div>
        <CardDescription>
          {callInfo?.goal
            ? `Goal: ${callInfo.goal.slice(0, 50)}${callInfo.goal.length > 50 ? '...' : ''}`
            : `Call ID: ${callControlId.slice(-8)}`}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Error Message */}
        {errorMessage && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-md text-sm">
            {errorMessage}
          </div>
        )}

        {/* Controls */}
        <div className="flex items-center gap-4">
          {/* Listen/Stop Button */}
          <Button
            onClick={toggleListening}
            variant={isListening ? 'destructive' : 'default'}
            className="gap-2"
          >
            {isListening ? (
              <>
                <Square className="h-4 w-4" />
                Stop Listening
              </>
            ) : (
              <>
                <Headphones className="h-4 w-4" />
                Start Listening
              </>
            )}
          </Button>

          {/* Volume Control */}
          <div className="flex items-center gap-2 flex-1 max-w-[200px]">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setIsMuted(!isMuted)}
            >
              {isMuted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </Button>
            <Slider
              value={[volume * 100]}
              min={0}
              max={100}
              step={5}
              onValueChange={([v]) => setVolume(v / 100)}
              className="flex-1"
              disabled={!isListening}
            />
          </div>
        </div>

        {/* Audio Channel Legend */}
        {isListening && (
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <User className="h-3 w-3" />
              Left ear: Caller
            </span>
            <span className="flex items-center gap-1">
              <Bot className="h-3 w-3" />
              Right ear: Assistant
            </span>
          </div>
        )}

        {/* Live Transcript */}
        {transcripts.length > 0 && (
          <div className="border rounded-lg">
            <div className="px-3 py-2 border-b bg-muted/30">
              <span className="text-sm font-medium">Live Transcript</span>
            </div>
            <div className="max-h-[300px] overflow-y-auto p-3 space-y-2">
              {transcripts.map((entry, index) => (
                <div
                  key={`${entry.timestamp}-${index}`}
                  className={`flex gap-2 ${
                    entry.isFinal ? '' : 'opacity-60'
                  }`}
                >
                  <span className="text-[10px] text-muted-foreground mt-1 shrink-0 w-16">
                    {formatTime(entry.timestamp)}
                  </span>
                  <div
                    className={`flex-1 rounded-lg px-3 py-2 text-sm ${
                      entry.speaker === 'caller'
                        ? 'bg-blue-50 dark:bg-blue-900/20 border-l-2 border-blue-400'
                        : 'bg-green-50 dark:bg-green-900/20 border-l-2 border-green-400'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {entry.speaker === 'caller' ? (
                        <User className="h-3 w-3 text-blue-500" />
                      ) : (
                        <Bot className="h-3 w-3 text-green-500" />
                      )}
                      <span className="text-xs font-medium">
                        {entry.speaker === 'caller' ? 'Caller' : callInfo?.assistantName || 'Assistant'}
                      </span>
                      {!entry.isFinal && (
                        <span className="text-[10px] text-muted-foreground">(speaking...)</span>
                      )}
                    </div>
                    <p className="text-sm">{entry.text}</p>
                  </div>
                </div>
              ))}
              <div ref={transcriptEndRef} />
            </div>
          </div>
        )}

        {/* Empty State */}
        {!isListening && transcripts.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            <Headphones className="h-10 w-10 mx-auto mb-3 opacity-20" />
            <p>Click &quot;Start Listening&quot; to hear the call live</p>
            <p className="text-xs mt-1">Audio will play in stereo: caller in left ear, assistant in right</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
