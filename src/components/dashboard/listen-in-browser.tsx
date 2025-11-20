'use client';

/**
 * Listen in Browser Component
 * Enables real-time audio monitoring of calls via WebRTC
 * Sends target_call_id in clientState to Cloudflare Worker
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Headphones, Mic, MicOff, Phone, Loader2 } from 'lucide-react';
import { TelnyxRTC } from '@telnyx/webrtc';

interface ListenInBrowserProps {
  callId: string;
  isCallOngoing: boolean;
}

type ConnectionState = 'idle' | 'connecting' | 'listening' | 'error' | 'disconnected';

export function ListenInBrowser({ callId, isCallOngoing }: ListenInBrowserProps) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const telnyxClientRef = useRef<any>(null);
  const currentCallRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  // Initialize Telnyx client on component mount
  useEffect(() => {
    const initializeTelnyxClient = async () => {
      try {
        // Fetch authentication token from backend
        const tokenResponse = await fetch('/api/telnyx/token', {
          method: 'POST',
        });

        if (!tokenResponse.ok) {
          const errorData = await tokenResponse.json().catch(() => ({}));
          const errorMsg = errorData.detail
            ? `${errorData.error}: ${errorData.detail}`
            : errorData.error || 'Failed to fetch Telnyx token';
          throw new Error(errorMsg);
        }

        const { token } = await tokenResponse.json();

        if (!token) {
          throw new Error('No token received from server');
        }

        // Create a new Telnyx RTC client instance with authentication
        const client = new TelnyxRTC({
          login_token: token,
        });

        // Open the websocket connection so calls can be placed
        client.connect();

        // Set up event listeners
        client.on('telnyx.ready', () => {
          console.log('Telnyx WebRTC client ready and authenticated');
        });

        client.on('telnyx.error', (error: any) => {
          console.error('Telnyx error:', error);
          setErrorMessage(`Connection error: ${error.message || 'Unknown error'}`);
          setConnectionState('error');
        });

        client.on('telnyx.notification', (notification: any) => {
          console.log('Telnyx notification:', notification);
        });

        telnyxClientRef.current = client;
      } catch (error: any) {
        console.error('Failed to initialize Telnyx client:', error);
        setErrorMessage(error.message || 'Failed to initialize WebRTC client');
        setConnectionState('error');
      }
    };

    initializeTelnyxClient();

    return () => {
      // Cleanup on unmount
      if (currentCallRef.current) {
        try {
          currentCallRef.current.hangup();
        } catch (e) {
          console.warn('Error hanging up during cleanup:', e);
        }
      }
    };
  }, []);

  const handleListenClick = async () => {
    if (!telnyxClientRef.current) {
      setErrorMessage('WebRTC client not initialized');
      return;
    }

    if (connectionState === 'listening') {
      // Disconnect if already listening
      handleDisconnect();
      return;
    }

    try {
      setConnectionState('connecting');
      setErrorMessage(null);

      // Request microphone permission
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        console.warn('Microphone permission denied or unavailable:', e);
        // Continue anyway - we can still listen without microphone
      }

      // Get the monitor number from environment
      const monitorNumber = process.env.NEXT_PUBLIC_MONITOR_NUMBER;
      if (!monitorNumber) {
        throw new Error('NEXT_PUBLIC_MONITOR_NUMBER not configured');
      }

      // Create client state with target_call_id
      const clientState = {
        target_call_id: callId,
        monitoring: true,
        timestamp: new Date().toISOString(),
      };

      // Initiate the WebRTC call with the monitor number
      // The Cloudflare Worker listens on this number and routes based on target_call_id
      const newCall = telnyxClientRef.current.newCall({
        // Destination number that Cloudflare Worker listens for
        destinationNumber: monitorNumber,
        // Client state to identify the target call
        clientState: JSON.stringify(clientState),
        // Enable audio
        audio: true,
        // Custom headers for additional context
        customHeaders: [
          {
            name: 'X-Target-Call-ID',
            value: callId,
          },
        ],
      });

      if (!newCall) {
        throw new Error('Failed to create WebRTC call');
      }

      currentCallRef.current = newCall;

      // Set up call event listeners
      newCall.on('telnyx.call.active', () => {
        console.log('Call active - listening to audio stream');
        setConnectionState('listening');

        // Get the remote audio stream
        const remoteStream = newCall.getRemoteStream?.();
        if (remoteStream && remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteStream;
          remoteAudioRef.current.play();
        }
      });

      newCall.on('telnyx.call.hangup', () => {
        console.log('Call ended');
        handleDisconnect();
      });

      newCall.on('telnyx.call.error', (error: any) => {
        console.error('Call error:', error);
        setErrorMessage(`Call error: ${error.message || 'Unknown error'}`);
        setConnectionState('error');
      });

      newCall.on('telnyx.error', (error: any) => {
        console.error('Call negotiation error:', error);
        setErrorMessage(`Error: ${error.message || 'Connection failed'}`);
        setConnectionState('error');
      });
    } catch (error: any) {
      console.error('Failed to initiate listen session:', error);
      setErrorMessage(
        error.message || 'Failed to establish WebRTC connection'
      );
      setConnectionState('error');
    }
  };

  const handleDisconnect = () => {
    if (currentCallRef.current) {
      try {
        currentCallRef.current.hangup();
        currentCallRef.current = null;
      } catch (e) {
        console.warn('Error hanging up:', e);
      }
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
    }

    setConnectionState('disconnected');
    setIsMuted(false);
  };

  const handleMuteToggle = () => {
    if (!currentCallRef.current) return;

    try {
      if (isMuted) {
        currentCallRef.current.unmute();
        setIsMuted(false);
      } else {
        currentCallRef.current.mute();
        setIsMuted(true);
      }
    } catch (error: any) {
      console.error('Error toggling mute:', error);
      setErrorMessage('Failed to toggle mute');
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
      case 'listening':
        return (
          <Badge variant="success" className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 bg-green-500 rounded-full animate-pulse" />
            Listening Live
          </Badge>
        );
      case 'error':
        return <Badge variant="destructive">Connection Failed</Badge>;
      case 'disconnected':
        return <Badge variant="outline">Disconnected</Badge>;
      default:
        return <Badge variant="outline">Ready</Badge>;
    }
  };

  // Don't show component if call is not ongoing
  if (!isCallOngoing) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Headphones className="h-5 w-5" />
          Listen in Browser
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Hidden audio element for remote audio */}
        <audio
          ref={remoteAudioRef}
          autoPlay
          playsInline
          className="hidden"
        />

        {/* Status */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Connection Status:</span>
          {getStatusBadge()}
        </div>

        {/* Error message */}
        {errorMessage && (
          <div className="bg-destructive/10 border border-destructive/20 rounded p-2 text-sm text-destructive">
            {errorMessage}
          </div>
        )}

        {/* Controls */}
        <div className="flex gap-2">
          <Button
            onClick={handleListenClick}
            disabled={!isCallOngoing || connectionState === 'error'}
            variant={connectionState === 'listening' ? 'destructive' : 'default'}
            className="flex-1"
          >
            {connectionState === 'connecting' && (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Connecting...
              </>
            )}
            {connectionState === 'listening' && (
              <>
                <Phone className="mr-2 h-4 w-4" />
                Disconnect
              </>
            )}
            {connectionState !== 'connecting' && connectionState !== 'listening' && (
              <>
                <Headphones className="mr-2 h-4 w-4" />
                Listen Live
              </>
            )}
          </Button>

          {connectionState === 'listening' && (
            <Button
              onClick={handleMuteToggle}
              variant="outline"
              size="icon"
              title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
            >
              {isMuted ? (
                <MicOff className="h-4 w-4" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>

        {/* Info text */}
        <p className="text-xs text-muted-foreground">
          Connects to the target call via WebRTC. Audio streams in real-time to your browser.
          {connectionState === 'listening' && ' Mic is available for two-way audio.'}
        </p>
      </CardContent>
    </Card>
  );
}
