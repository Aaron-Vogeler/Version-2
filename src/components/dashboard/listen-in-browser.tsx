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
  const [isMuted, setIsMuted] = useState(true); // start muted for monitoring
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<string[]>([]);

  const telnyxClientRef = useRef<any>(null);
  const currentCallRef = useRef<any>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  /** Safely serialize objects with circular references */
  const safeStringify = (obj: any, indent: number = 2): string => {
    const seen = new WeakSet();
    return JSON.stringify(
      obj,
      (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        return value;
      },
      indent
    );
  };

  /** Add timestamped debug message */
  const addDebug = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    const debugMsg = `[${timestamp}] ${message}`;
    console.log(debugMsg);
    setDebugInfo((prev) => [...prev, debugMsg].slice(-20));
  };

  /** Disconnect call + cleanup audio */
  const handleDisconnect = () => {
    addDebug('Disconnecting...');

    if (currentCallRef.current) {
      try {
        currentCallRef.current.hangup();
      } catch (e) {
        console.warn('Error hanging up:', e);
      }
      currentCallRef.current = null;
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
    }

    setConnectionState('disconnected');
    setIsMuted(true);
  };

  /** Initialize Telnyx WebRTC client */
  useEffect(() => {
    const initializeTelnyxClient = async () => {
      try {
        addDebug('🔧 Initializing Telnyx client...');

        const sipUser = process.env.NEXT_PUBLIC_TELNYX_SIP_USER;
        const sipPassword = process.env.NEXT_PUBLIC_TELNYX_SIP_PASSWORD;
        const monitorNumber = process.env.NEXT_PUBLIC_MONITOR_NUMBER;

        addDebug(`ENV Check - SIP User: ${sipUser ? '✓' : '✗ MISSING'}`);
        addDebug(`ENV Check - SIP Password: ${sipPassword ? '✓' : '✗ MISSING'}`);
        addDebug(`ENV Check - Monitor Number: ${monitorNumber || '✗ MISSING'}`);

        if (!sipUser || !sipPassword || !monitorNumber) {
          const missing = [];
          if (!sipUser) missing.push('NEXT_PUBLIC_TELNYX_SIP_USER');
          if (!sipPassword) missing.push('NEXT_PUBLIC_TELNYX_SIP_PASSWORD');
          if (!monitorNumber) missing.push('NEXT_PUBLIC_MONITOR_NUMBER');

          const msg = `Missing required environment variables: ${missing.join(', ')}`;
          addDebug(`❌ ${msg}`);
          setErrorMessage(msg);
          setConnectionState('error');
          return;
        }

        const client = new TelnyxRTC({
          login: sipUser,
          password: sipPassword,
          ringtoneFile: 'https://cdn.telnyx.com/audio/ring.mp3',
        });

        addDebug('TelnyxRTC client created, connecting...');
        client.connect();

        client.on('telnyx.ready', () => {
          addDebug('✅ Telnyx client READY - authenticated successfully');
        });

        client.on('telnyx.error', (error: any) => {
          const details = safeStringify(error);
          addDebug(`❌ Telnyx error: ${details}`);
          setErrorMessage(`Connection error: ${error.message || details}`);
          setConnectionState('error');
        });

        client.on('telnyx.notification', (notification: any) => {
          console.log('Telnyx notification:', notification);

          if (notification.type === 'callUpdate' && notification.call) {
            const call = notification.call;

            if (currentCallRef.current && call.id === currentCallRef.current.id) {
              addDebug(`📞 Call state: ${call.prevState} → ${call.state}`);

              if (call.state === 'active') {
                setConnectionState('listening');
                addDebug('🔊 Remote audio active');

                let remoteStream = call.remoteStream;
                if (!remoteStream && typeof call.getRemoteStream === 'function') {
                  remoteStream = call.getRemoteStream();
                }

                if (remoteStream && remoteAudioRef.current) {
                  remoteAudioRef.current.srcObject = remoteStream;
                  remoteAudioRef.current.play().catch((err) =>
                    addDebug(`⚠️ Audio play failed: ${err.message}`)
                  );
                } else {
                  addDebug('⚠️ No remote stream yet');
                }
              }

              if (['hangup', 'destroy', 'purge'].includes(call.state)) {
                addDebug(`📴 Call ended: ${call.state}`);
                handleDisconnect();
              }
            }
          }
        });

        telnyxClientRef.current = client;
      } catch (error: any) {
        addDebug(`❌ Init failed: ${error.message}`);
        setErrorMessage(`Initialization Error: ${error.message}`);
        setConnectionState('error');
      }
    };

    initializeTelnyxClient();

    return () => {
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
          console.warn('Error disconnecting client:', e);
        }
        telnyxClientRef.current = null;
      }
    };
  }, []);

  /** Handle Listen/Disconnect button */
  const handleListenClick = async () => {
    if (!telnyxClientRef.current) {
      const msg = 'WebRTC client not initialized';
      addDebug(`❌ ${msg}`);
      setErrorMessage(msg);
      return;
    }

    if (connectionState === 'listening') {
      addDebug('Disconnecting from active call...');
      handleDisconnect();
      return;
    }

    try {
      addDebug('🎧 Starting listen session...');
      setConnectionState('connecting');
      setErrorMessage(null);

      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        addDebug('✅ Microphone permission granted');
      } catch (e: any) {
        addDebug(`⚠️ Mic unavailable: ${e.message}`);
      }

      const monitorNumber = process.env.NEXT_PUBLIC_MONITOR_NUMBER!;
      addDebug(`📞 Calling monitor number: ${monitorNumber}`);
      addDebug(`🎯 target_call_id = ${callId}`);

      const clientState = {
        target_call_id: callId,
        user_id: 'admin_listener',
      };

      const newCall = telnyxClientRef.current.newCall({
        destinationNumber: monitorNumber,
        clientState: JSON.stringify(clientState),
        audio: true,
        video: false,
      });

      if (!newCall) throw new Error('Failed to create WebRTC call');

      currentCallRef.current = newCall;

      setIsMuted(true);
      try {
        newCall.mute();
      } catch {}

      addDebug('Call initiated, awaiting state changes...');
    } catch (error: any) {
      addDebug(`❌ Listen session failed: ${error.message}`);
      setErrorMessage(`Failed to start listen session:\n${error.message}`);
      setConnectionState('error');
    }
  };

  /** Toggle mute/unmute */
  const handleMuteToggle = () => {
    if (!currentCallRef.current) return;

    try {
      if (isMuted) {
        currentCallRef.current.unmute();
        setIsMuted(false);
        addDebug('🎤 Microphone unmuted');
      } else {
        currentCallRef.current.mute();
        setIsMuted(true);
        addDebug('🎤 Microphone muted');
      }
    } catch {
      setErrorMessage('Failed to toggle mute');
    }
  };

  /** Badge UI */
  const getStatusBadge = () => {
    switch (connectionState) {
      case 'connecting':
        return (
          <Badge variant="secondary" className="flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> Connecting...
          </Badge>
        );
      case 'listening':
        return (
          <Badge variant="success" className="flex items-center gap-1">
            <span className="h-2 w-2 bg-green-500 rounded-full animate-pulse" />
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

  if (!isCallOngoing) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Headphones className="h-5 w-5" />
          Listen in Browser
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Connection Status:</span>
          {getStatusBadge()}
        </div>

        {errorMessage && (
          <div className="bg-destructive/10 border border-destructive/20 rounded p-3 text-sm text-destructive">
            <div className="font-semibold mb-1">Error Details:</div>
            <pre className="whitespace-pre-wrap text-xs">{errorMessage}</pre>
          </div>
        )}

        {debugInfo.length > 0 && (
          <div className="bg-muted/50 border rounded p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold">Debug Log:</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigator.clipboard.writeText(debugInfo.join('\n'))}
                className="h-6 text-xs"
              >
                Copy Log
              </Button>
            </div>
            <div className="bg-background rounded p-2 max-h-60 overflow-y-auto">
              <pre className="text-xs whitespace-pre-wrap">{debugInfo.join('\n')}</pre>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <Button
            onClick={handleListenClick}
            disabled={!isCallOngoing || connectionState === 'error'}
            variant={connectionState === 'listening' ? 'destructive' : 'default'}
            className="flex-1"
          >
            {connectionState === 'connecting' && (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Connecting...
              </>
            )}
            {connectionState === 'listening' && (
              <>
                <Phone className="mr-2 h-4 w-4" /> Disconnect
              </>
            )}
            {connectionState !== 'connecting' && connectionState !== 'listening' && (
              <>
                <Headphones className="mr-2 h-4 w-4" /> Listen Live
              </>
            )}
          </Button>

          {connectionState === 'listening' && (
            <Button
              onClick={handleMuteToggle}
              variant="outline"
              size="icon"
              className={isMuted ? 'text-muted-foreground' : 'text-destructive'}
            >
              {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Connects to the target call via WebRTC using SIP credentials. Audio streams in real-time to
          your browser.
          {connectionState === 'listening' && ' Mic is available for two-way audio.'}
        </p>
      </CardContent>
    </Card>
  );
}
