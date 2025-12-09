'use client';

/**
 * Live Audio Listener Component
 * Connects to the ai-server WebSocket to receive live call audio
 * Decodes μ-law audio and plays via Web Audio API
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Headphones, Volume2, VolumeX, Loader2, Square } from 'lucide-react';

interface LiveAudioListenerProps {
  callControlId: string | null;
  isCallActive: boolean;
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

// μ-law decoding table (ITU-T G.711)
const MULAW_DECODE_TABLE = new Int16Array(256);
(function initMulawTable() {
  for (let i = 0; i < 256; i++) {
    // Invert the bits
    const mulaw = ~i & 0xFF;
    // Extract sign, exponent, and mantissa
    const sign = (mulaw & 0x80) ? -1 : 1;
    const exponent = (mulaw >> 4) & 0x07;
    const mantissa = mulaw & 0x0F;
    // Reconstruct the sample
    let sample: number;
    if (exponent === 0) {
      sample = (mantissa << 3) + 132;
    } else {
      sample = ((mantissa << 3) + 132) << exponent;
    }
    sample -= 132;
    MULAW_DECODE_TABLE[i] = sign * sample;
  }
})();

/**
 * Decode μ-law buffer to 16-bit PCM
 */
function decodeMulaw(mulawData: Uint8Array): Int16Array {
  const pcm = new Int16Array(mulawData.length);
  for (let i = 0; i < mulawData.length; i++) {
    pcm[i] = MULAW_DECODE_TABLE[mulawData[i]];
  }
  return pcm;
}

/**
 * Convert Int16 PCM to Float32 for Web Audio API
 */
function int16ToFloat32(int16: Int16Array): Float32Array {
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }
  return float32;
}

export function LiveAudioListener({ callControlId, isCallActive }: LiveAudioListenerProps) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [isListening, setIsListening] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(80);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [packetsReceived, setPacketsReceived] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const subscribedCallIdRef = useRef<string | null>(null);

  // Initialize Audio Context
  const initAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: 8000 });
      gainNodeRef.current = audioContextRef.current.createGain();
      gainNodeRef.current.connect(audioContextRef.current.destination);
      gainNodeRef.current.gain.value = volume / 100;
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    nextPlayTimeRef.current = audioContextRef.current.currentTime;
  }, [volume]);

  // Update volume
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = isMuted ? 0 : volume / 100;
    }
  }, [volume, isMuted]);

  // Play audio chunk
  const playAudioChunk = useCallback((mulawData: Uint8Array) => {
    if (!audioContextRef.current || !gainNodeRef.current) return;

    const pcm = decodeMulaw(mulawData);
    const float32 = int16ToFloat32(pcm);

    const buffer = audioContextRef.current.createBuffer(1, float32.length, 8000);
    buffer.getChannelData(0).set(float32);

    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(gainNodeRef.current);

    // Schedule playback
    const currentTime = audioContextRef.current.currentTime;
    const startTime = Math.max(currentTime, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + buffer.duration;
  }, []);

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (!callControlId) {
      setErrorMessage('No call ID available');
      return;
    }

    setConnectionState('connecting');
    setErrorMessage(null);

    // Get WebSocket URL from environment
    const wsUrl = process.env.NEXT_PUBLIC_AI_SERVER_WS_URL || 'wss://version-2-cr4fsa.fly.dev';
    const fullUrl = `${wsUrl}/live-audio`;

    console.log('[LiveAudio] Connecting to:', fullUrl);

    try {
      const ws = new WebSocket(fullUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[LiveAudio] WebSocket connected');
        // Subscribe to the call
        ws.send(JSON.stringify({
          type: 'subscribe',
          callControlId: callControlId,
        }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'subscribed') {
            console.log('[LiveAudio] Subscribed to call:', msg.callControlId);
            subscribedCallIdRef.current = msg.callControlId;
            setConnectionState('connected');
            setIsListening(true);
            initAudioContext();
          } else if (msg.type === 'audio' && msg.payload) {
            // Decode base64 and play
            const binaryString = atob(msg.payload);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            playAudioChunk(bytes);
            setPacketsReceived(prev => prev + 1);
          } else if (msg.type === 'call_ended') {
            console.log('[LiveAudio] Call ended');
            disconnect();
          }
        } catch (err) {
          console.error('[LiveAudio] Error parsing message:', err);
        }
      };

      ws.onerror = (error) => {
        console.error('[LiveAudio] WebSocket error:', error);
        setErrorMessage('WebSocket connection error');
        setConnectionState('error');
      };

      ws.onclose = (event) => {
        console.log('[LiveAudio] WebSocket closed:', event.code, event.reason);
        setConnectionState('disconnected');
        setIsListening(false);
        subscribedCallIdRef.current = null;
        wsRef.current = null;
      };
    } catch (err: any) {
      console.error('[LiveAudio] Failed to connect:', err);
      setErrorMessage(err.message || 'Failed to connect');
      setConnectionState('error');
    }
  }, [callControlId, initAudioContext, playAudioChunk]);

  // Disconnect from WebSocket
  const disconnect = useCallback(() => {
    if (wsRef.current) {
      if (subscribedCallIdRef.current) {
        wsRef.current.send(JSON.stringify({ type: 'unsubscribe' }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }
    subscribedCallIdRef.current = null;
    setConnectionState('disconnected');
    setIsListening(false);
    setPacketsReceived(0);
  }, []);

  // Cleanup on unmount or call end
  useEffect(() => {
    return () => {
      disconnect();
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, [disconnect]);

  // Auto-disconnect when call becomes inactive
  useEffect(() => {
    if (!isCallActive && isListening) {
      disconnect();
    }
  }, [isCallActive, isListening, disconnect]);

  const handleToggleListen = () => {
    if (isListening) {
      disconnect();
    } else {
      connect();
    }
  };

  const getStatusBadge = () => {
    switch (connectionState) {
      case 'connecting':
        return (
          <Badge variant="secondary" className="flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Connecting...
          </Badge>
        );
      case 'connected':
        return (
          <Badge variant="default" className="flex items-center gap-1 bg-green-600">
            <span className="inline-block h-2 w-2 bg-white rounded-full animate-pulse" />
            Listening ({packetsReceived} packets)
          </Badge>
        );
      case 'error':
        return <Badge variant="destructive">Error</Badge>;
      default:
        return <Badge variant="outline">Ready</Badge>;
    }
  };

  // Don't render if no call is active
  if (!isCallActive || !callControlId) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Headphones className="h-5 w-5" />
          Live Audio Monitor
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Status:</span>
          {getStatusBadge()}
        </div>

        {/* Error message */}
        {errorMessage && (
          <div className="bg-destructive/10 border border-destructive/20 rounded p-2 text-sm text-destructive">
            {errorMessage}
          </div>
        )}

        {/* Volume control */}
        {isListening && (
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsMuted(!isMuted)}
              className="h-8 w-8"
            >
              {isMuted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </Button>
            <input
              type="range"
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              min={0}
              max={100}
              step={1}
              className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
              disabled={isMuted}
            />
            <span className="text-sm text-muted-foreground w-8">{volume}%</span>
          </div>
        )}

        {/* Listen button */}
        <Button
          onClick={handleToggleListen}
          variant={isListening ? 'destructive' : 'default'}
          className="w-full"
          disabled={connectionState === 'connecting'}
        >
          {connectionState === 'connecting' ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Connecting...
            </>
          ) : isListening ? (
            <>
              <Square className="mr-2 h-4 w-4" />
              Stop Listening
            </>
          ) : (
            <>
              <Headphones className="mr-2 h-4 w-4" />
              Listen Live
            </>
          )}
        </Button>

        {/* Info text */}
        <p className="text-xs text-muted-foreground">
          Streams live audio from both the AI and the receiver in real-time.
        </p>
      </CardContent>
    </Card>
  );
}
