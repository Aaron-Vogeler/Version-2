'use client';

/**
 * Listen in Browser Component
 * Enables real-time audio monitoring of calls via WebRTC
 * Uses direct SIP credentials for authentication
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
  const [debugInfo, setDebugInfo] = useState<string[]>([]);
  const telnyxClientRef = useRef<any>(null);
  const currentCallRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  // Helper to add debug messages
  const addDebug = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    const debugMsg = `[${timestamp}] ${message}`;
    console.log(debugMsg);
    setDebugInfo(prev => [...prev, debugMsg].slice(-20)); // Keep last 20 messages
  };

  // Initialize Telnyx client on component mount
  useEffect(() => {
    const initializeTelnyxClient = async () => {
      try {
        addDebug('🔧 Initializing Telnyx client...');

        // Validate required environment variables
        const sipUser = process.env.NEXT_PUBLIC_TELNYX_SIP_USER;
        const sipPassword = process.env.NEXT_PUBLIC_TELNYX_SIP_PASSWORD;
        const monitorNumber = process.env.NEXT_PUBLIC_MONITOR_NUMBER;

        addDebug(`ENV Check - SIP User: ${sipUser ? '✓ SET' : '✗ MISSING'}`);
        addDebug(`ENV Check - SIP Password: ${sipPassword ? '✓ SET' : '✗ MISSING'}`);
        addDebug(`ENV Check - Monitor Number: ${monitorNumber ? `✓ ${monitorNumber}` : '✗ MISSING'}`);

        if (!sipUser || !sipPassword || !monitorNumber) {
          const missing = [];
          if (!sipUser) missing.push('NEXT_PUBLIC_TELNYX_SIP_USER');
          if (!sipPassword) missing.push('NEXT_PUBLIC_TELNYX_SIP_PASSWORD');
          if (!monitorNumber) missing.push('NEXT_PUBLIC_MONITOR_NUMBER');

          const errorMsg = `Missing required environment variables: ${missing.join(', ')}`;
          addDebug(`❌ ${errorMsg}`);
          throw new Error(errorMsg);
        }

        addDebug('Creating TelnyxRTC client with SIP credentials...');

        // Create a new Telnyx RTC client instance with SIP credentials
        const client = new TelnyxRTC({
          login: sipUser,
          password: sipPassword,
          ringtoneFile: 'https://cdn.telnyx.com/audio/ring.mp3',
        });

        addDebug('TelnyxRTC client created, setting up event listeners...');

        // Set up event listeners
        client.on('telnyx.ready', () => {
          addDebug('✅ Telnyx client READY - authenticated successfully');
          console.log('Telnyx WebRTC client ready and authenticated with SIP credentials');
        });

        client.on('telnyx.error', (error: any) => {
          const errorDetails = JSON.stringify(error, null, 2);
          addDebug(`❌ Telnyx error event: ${errorDetails}`);
          console.error('Telnyx error:', error);
          setErrorMessage(`Connection error: ${error.message || JSON.stringify(error)}`);
          setConnectionState('error');
        });

        client.on('telnyx.notification', (notification: any) => {
          addDebug(`📢 Notification: ${JSON.stringify(notification)}`);
          console.log('Telnyx notification:', notification);
        });

        telnyxClientRef.current = client;
        addDebug('✅ Client initialization complete');
      } catch (error: any) {
        const errorDetails = `${error.message || 'Unknown error'}\nStack: ${error.stack || 'No stack trace'}`;
        addDebug(`❌ Init failed: ${errorDetails}`);
        console.error('Failed to initialize Telnyx client:', error);
        setErrorMessage(`Initialization Error: ${error.message || 'Failed to initialize WebRTC client'}\n\n${error.stack || ''}`);
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
        currentCallRef.current = null;
      }

      if (telnyxClientRef.current) {
        try {
          telnyxClientRef.current.disconnect();
        } catch (e) {
          console.warn('Error disconnecting client during cleanup:', e);
        }
        telnyxClientRef.current = null;
      }
    };
  }, []);

  const handleListenClick = async () => {
    if (!telnyxClientRef.current) {
      const errorMsg = 'WebRTC client not initialized';
      addDebug(`❌ ${errorMsg}`);
      setErrorMessage(errorMsg);
      return;
    }

    if (connectionState === 'listening') {
      // Disconnect if already listening
      addDebug('Disconnecting from active call...');
      handleDisconnect();
      return;
    }

    try {
      addDebug('🎧 Starting listen session...');
      setConnectionState('connecting');
      setErrorMessage(null);

      // Request microphone permission
      try {
        addDebug('Requesting microphone permission...');
        await navigator.mediaDevices.getUserMedia({ audio: true });
        addDebug('✅ Microphone permission granted');
      } catch (e: any) {
        addDebug(`⚠️ Microphone unavailable: ${e.message} - continuing anyway`);
        console.warn('Microphone permission denied or unavailable:', e);
        // Continue anyway - we can still listen without microphone
      }

      // Get the monitor number from environment
      const monitorNumber = process.env.NEXT_PUBLIC_MONITOR_NUMBER;
      if (!monitorNumber) {
        throw new Error('NEXT_PUBLIC_MONITOR_NUMBER not configured');
      }

      addDebug(`📞 Preparing call to monitor number: ${monitorNumber}`);
      addDebug(`🎯 Target call ID: ${callId}`);

      // Create client state with target_call_id for the Cloudflare Worker
      // CRITICAL: This exact format is required by the backend
      const clientState = {
        target_call_id: callId,
        user_id: 'admin_listener', // Helps backend identify us
      };

      const callParams = {
        destinationNumber: monitorNumber,
        clientState: clientState,
        audio: true,
        customHeaders: [
          {
            name: 'X-Target-Call-ID',
            value: callId,
          },
        ],
      };

      addDebug(`📋 Call parameters: ${JSON.stringify(callParams, null, 2)}`);
      addDebug('Initiating WebRTC call via newCall()...');

      // Initiate the WebRTC call with the monitor number
      // The Cloudflare Worker listens on this number and routes based on target_call_id
      const newCall = telnyxClientRef.current.newCall(callParams);

      if (!newCall) {
        throw new Error('Failed to create WebRTC call - newCall() returned null/undefined');
      }

      addDebug('✅ Call object created, setting up event listeners...');
      currentCallRef.current = newCall;

      // Set up call event listeners
      newCall.on('telnyx.call.active', () => {
        addDebug('✅ CALL ACTIVE - Audio stream connected!');
        console.log('Call active - listening to audio stream');
        setConnectionState('listening');

        // Get the remote audio stream
        const remoteStream = newCall.getRemoteStream?.();
        if (remoteStream && remoteAudioRef.current) {
          addDebug('🔊 Remote audio stream received, playing...');
          remoteAudioRef.current.srcObject = remoteStream;
          remoteAudioRef.current.play();
        } else {
          addDebug('⚠️ No remote stream available yet');
        }
      });

      newCall.on('telnyx.call.hangup', () => {
        addDebug('📴 Call hangup event received');
        console.log('Call ended');
        handleDisconnect();
      });

      newCall.on('telnyx.call.error', (error: any) => {
        const errorDetails = JSON.stringify(error, null, 2);
        addDebug(`❌ Call error event: ${errorDetails}`);
        console.error('Call error:', error);
        setErrorMessage(`Call error: ${error.message || errorDetails}`);
        setConnectionState('error');
      });

      newCall.on('telnyx.error', (error: any) => {
        const errorDetails = JSON.stringify(error, null, 2);
        addDebug(`❌ Telnyx error during call: ${errorDetails}`);
        console.error('Call negotiation error:', error);
        setErrorMessage(`Connection error: ${error.message || errorDetails}`);
        setConnectionState('error');
      });

      addDebug('Event listeners configured, waiting for connection...');
    } catch (error: any) {
      const errorDetails = `${error.message || 'Unknown error'}\nStack: ${error.stack || 'No stack'}`;
      addDebug(`❌ Listen session failed: ${errorDetails}`);
      console.error('Failed to initiate listen session:', error);
      setErrorMessage(
        `Failed to start listen session:\n${error.message || 'Unknown error'}\n\n${error.stack || ''}`
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
          <div className="bg-destructive/10 border border-destructive/20 rounded p-3 text-sm text-destructive">
            <div className="font-semibold mb-1">Error Details:</div>
            <pre className="whitespace-pre-wrap font-mono text-xs overflow-auto max-h-40">
              {errorMessage}
            </pre>
          </div>
        )}

        {/* Debug Info */}
        {debugInfo.length > 0 && (
          <div className="bg-muted/50 border border-border rounded p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-foreground">Debug Log:</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(debugInfo.join('\n'));
                  addDebug('📋 Debug log copied to clipboard');
                }}
                className="h-6 text-xs"
              >
                Copy Log
              </Button>
            </div>
            <div className="bg-background rounded p-2 max-h-60 overflow-y-auto">
              <pre className="text-xs font-mono whitespace-pre-wrap">
                {debugInfo.join('\n')}
              </pre>
            </div>
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
          Connects to the target call via WebRTC using SIP credentials. Audio streams in real-time to your browser.
          {connectionState === 'listening' && ' Mic is available for two-way audio.'}
        </p>
      </CardContent>
    </Card>
  );
}
