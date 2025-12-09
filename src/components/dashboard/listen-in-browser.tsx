'use client';

/**
 * Listen in Browser Component
 * Enables real-time audio monitoring of calls via WebRTC
 * Uses direct SIP credentials for authentication
 * Sends target_call_id in clientState to Cloudflare Worker
 *
 * Audio Quality Optimizations:
 * - Opus codec preference for high quality audio (48kHz, stereo capable)
 * - Proper remoteElement binding for efficient stream handling
 * - Enhanced audio constraints for input quality
 * - Audio element optimizations for playback
 */

import { useEffect, useRef, useState, useCallback } from 'react';
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
type ListenMode = 'listen' | 'join';

// Audio element ID for SDK binding
const REMOTE_AUDIO_ELEMENT_ID = 'telnyx-remote-audio';

// WebRTC codec capability type (browser API, define locally for SSR compatibility)
interface AudioCodecCapability {
  mimeType: string;
  clockRate?: number;
  channels?: number;
  sdpFmtpLine?: string;
}

/**
 * Get preferred audio codecs for high quality streaming
 * Prioritizes Opus (high quality, low latency) over legacy codecs
 */
function getPreferredAudioCodecs(): AudioCodecCapability[] {
  try {
    // RTCRtpReceiver is only available in browser
    if (typeof window === 'undefined' || typeof RTCRtpReceiver === 'undefined') {
      return [];
    }

    const capabilities = RTCRtpReceiver.getCapabilities('audio');
    if (!capabilities?.codecs) return [];

    // Priority order: Opus > PCMU > PCMA
    // Opus provides much higher quality (48kHz vs 8kHz for PCMU/PCMA)
    const codecPriority = ['opus', 'PCMU', 'PCMA'];

    const sortedCodecs = [...capabilities.codecs].sort((a, b) => {
      const aCodec = a.mimeType.split('/')[1]?.toLowerCase() || '';
      const bCodec = b.mimeType.split('/')[1]?.toLowerCase() || '';

      const aIndex = codecPriority.findIndex(c => aCodec.includes(c.toLowerCase()));
      const bIndex = codecPriority.findIndex(c => bCodec.includes(c.toLowerCase()));

      // Put unknown codecs at the end
      const aRank = aIndex === -1 ? 999 : aIndex;
      const bRank = bIndex === -1 ? 999 : bIndex;

      return aRank - bRank;
    });

    // Return top codecs, prioritizing Opus
    const opusCodecs = sortedCodecs.filter(c => c.mimeType.toLowerCase().includes('opus'));
    const otherCodecs = sortedCodecs.filter(c => !c.mimeType.toLowerCase().includes('opus'));

    return [...opusCodecs, ...otherCodecs.slice(0, 3)];
  } catch (e) {
    console.warn('Failed to get audio codec capabilities:', e);
    return [];
  }
}

export function ListenInBrowser({ callId, isCallOngoing }: ListenInBrowserProps) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [listenMode, setListenMode] = useState<ListenMode>('listen'); // Default to listen-only mode
  const [isMuted, setIsMuted] = useState(true); // Start muted by default for monitoring
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<string[]>([]);
  const [audioStats, setAudioStats] = useState<{ bitrate?: number; codec?: string } | null>(null);
  const telnyxClientRef = useRef<any>(null);
  const currentCallRef = useRef<any>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const statsIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Helper to safely stringify objects with circular references
  const safeStringify = (obj: any, indent?: number): string => {
    const seen = new WeakSet();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular Reference]';
        }
        seen.add(value);
      }
      return value;
    }, indent);
  };

  // Helper to add debug messages
  const addDebug = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    const debugMsg = `[${timestamp}] ${message}`;
    console.log(debugMsg);
    setDebugInfo(prev => [...prev, debugMsg].slice(-20)); // Keep last 20 messages
  };

  // Disconnect handler - defined before useEffect so notification handler can access it
  const handleDisconnect = useCallback(() => {
    addDebug('Disconnecting...');

    // Clear stats interval
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }

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
    setIsMuted(true);
    setAudioStats(null);
  }, []);

  // Initialize Telnyx client on component mount
  useEffect(() => {
    const initializeTelnyxClient = async () => {
      try {
        addDebug('🔧 Initializing Telnyx client...');

        // Validate required environment variables
        const sipUser = process.env.NEXT_PUBLIC_TELNYX_SIP_USER;
        const sipPassword = process.env.NEXT_PUBLIC_TELNYX_SIP_PASSWORD;
        
        // Monitor number is needed for the call destination
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
          // Don't throw here to allow UI to render error state gracefully
          setErrorMessage(errorMsg);
          setConnectionState('error');
          return;
        }

        addDebug('Creating TelnyxRTC client with SIP credentials and audio optimizations...');

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
          const errorDetails = safeStringify(error, 2);
          addDebug(`❌ Telnyx error event: ${errorDetails}`);
          console.error('Telnyx error:', error);
          setErrorMessage(`Connection error: ${error.message || safeStringify(error)}`);
          setConnectionState('error');
        });

        client.on('telnyx.notification', (notification: any) => {
          // Filter out noisy notifications if needed
          // addDebug(`📢 Notification: ${safeStringify(notification)}`);
          console.log('Telnyx notification:', notification);

          // Handle call state updates
          if (notification.type === 'callUpdate' && notification.call) {
            const call = notification.call;

            // Check if this notification is for our current call
            if (currentCallRef.current && call.id === currentCallRef.current.id) {
              addDebug(`📞 Call state changed: ${call.prevState} → ${call.state}`);

              // Handle different call states
              if (call.state === 'active') {
                addDebug('✅ CALL ACTIVE - Audio stream connected!');
                setConnectionState('listening');

                // Get the remote audio stream from the call object
                // Try multiple ways to access the stream as SDK versions vary
                let remoteStream = call.remoteStream;

                if (!remoteStream && typeof call.getRemoteStream === 'function') {
                  remoteStream = call.getRemoteStream();
                }

                if (remoteStream && remoteAudioRef.current) {
                  addDebug('🔊 Remote audio stream received, binding to audio element...');
                  remoteAudioRef.current.srcObject = remoteStream;
                  remoteAudioRef.current.play().catch(err => {
                    addDebug(`⚠️ Audio autoplay blocked: ${err.message} - User interaction may be required`);
                  });
                } else {
                  addDebug('⚠️ No remote stream available yet');
                }

                // Log codec information for debugging
                try {
                  if (call.peer && call.peer.instance) {
                    const receivers = call.peer.instance.getReceivers?.();
                    if (receivers) {
                      receivers.forEach((receiver: RTCRtpReceiver) => {
                        if (receiver.track?.kind === 'audio') {
                          const params = receiver.getParameters?.();
                          if (params?.codecs?.[0]) {
                            const codec = params.codecs[0];
                            addDebug(`🎵 Audio codec: ${codec.mimeType} (${codec.clockRate}Hz)`);
                            setAudioStats(prev => ({ ...prev, codec: codec.mimeType }));
                          }
                        }
                      });
                    }
                  }
                } catch (e) {
                  // Codec info is nice-to-have, don't fail on errors
                  console.log('Could not get codec info:', e);
                }
              } else if (call.state === 'hangup' || call.state === 'destroy') {
                addDebug('📴 Call ended');
                handleDisconnect();
              } else if (call.state === 'purge') {
                addDebug('🗑️ Call purged');
                handleDisconnect();
              }
            }
          }
        });

        // Connect the client
        client.connect();
        telnyxClientRef.current = client;
        
      } catch (error: any) {
        const errorDetails = `${error.message || 'Unknown error'}\nStack: ${error.stack || 'No stack trace'}`;
        addDebug(`❌ Init failed: ${errorDetails}`);
        console.error('Failed to initialize Telnyx client:', error);
        setErrorMessage(`Initialization Error: ${error.message || 'Failed to initialize WebRTC client'}`);
        setConnectionState('error');
      }
    };

    initializeTelnyxClient();

    return () => {
      // Cleanup on unmount
      if (statsIntervalRef.current) {
        clearInterval(statsIntervalRef.current);
        statsIntervalRef.current = null;
      }

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

      // Request microphone permission with high-quality audio constraints
      // Even if just listening, WebRTC requires mic permission
      try {
        addDebug('Requesting microphone permission with optimized constraints...');
        await navigator.mediaDevices.getUserMedia({
          audio: {
            // High quality audio constraints
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            // Prefer higher sample rates for better quality
            sampleRate: { ideal: 48000 },
            channelCount: { ideal: 2, min: 1 },
          }
        });
        addDebug('✅ Microphone permission granted with optimized constraints');
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

      // Create client state with target_call_id for the backend to route the call
      // NOTE: Don't include user_id - it would cause Supabase UUID validation error
      // The backend skips logging when userId is not present (see index.ts line ~1114)
      const clientState = {
        target_call_id: callId,
        isListener: true, // Mark as listener call for backend identification
        mode: listenMode, // 'listen' = silent monitoring, 'join' = full two-way audio
      };

      addDebug(`🎯 Mode: ${listenMode === 'listen' ? 'LISTEN (silent monitoring)' : 'JOIN (two-way audio)'}`);

      addDebug(`📋 Client state object: ${JSON.stringify(clientState, null, 2)}`);

      // Telnyx SDK expects clientState as a JSON STRING
      const clientStateString = JSON.stringify(clientState);

      // Get preferred codecs for high quality audio (Opus > PCMU > PCMA)
      const preferredCodecs = getPreferredAudioCodecs();
      addDebug(`🎵 Preferred codecs: ${preferredCodecs.map(c => c.mimeType).join(', ') || 'browser default'}`);

      const callParams: any = {
        destinationNumber: monitorNumber,
        clientState: clientStateString,
        audio: true,
        video: false,
        // Use debug mode to enable quality monitoring
        debug: process.env.NODE_ENV === 'development',
      };

      // Add preferred codecs if available (prioritizes Opus for high quality)
      if (preferredCodecs.length > 0) {
        callParams.preferred_codecs = preferredCodecs;
      }

      addDebug('Initiating WebRTC call via newCall() with codec preferences...');

      // Initiate the WebRTC call with the monitor number
      // The Cloudflare Worker listens on this number and routes based on target_call_id
      const newCall = telnyxClientRef.current.newCall(callParams);

      if (!newCall) {
        throw new Error('Failed to create WebRTC call - newCall() returned null/undefined');
      }

      addDebug('✅ Call object created');
      addDebug(`Call ID: ${newCall.id}`);

      // Store the call reference
      currentCallRef.current = newCall;

      // Ensure mute is set initially for monitoring
      setIsMuted(true);
      try {
         newCall.mute();
      } catch (e) {
         // Mute might fail if call isn't ready, handled later too
      }

      addDebug('Call initiated, waiting for state changes...');
    } catch (error: any) {
      const errorDetails = `${error.message || 'Unknown error'}\nStack: ${error.stack || 'No stack'}`;
      addDebug(`❌ Listen session failed: ${errorDetails}`);
      console.error('Failed to initiate listen session:', error);
      setErrorMessage(
        `Failed to start listen session:\n${error.message || 'Unknown error'}`
      );
      setConnectionState('error');
    }
  };

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
        addDebug('Sx Microphone muted');
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
        {/* Audio element for remote audio - bound to SDK via id */}
        <audio
          id={REMOTE_AUDIO_ELEMENT_ID}
          ref={remoteAudioRef}
          autoPlay
          playsInline
          className="hidden"
        />

        {/* Status */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Connection Status:</span>
          <div className="flex items-center gap-2">
            {getStatusBadge()}
            {audioStats?.codec && connectionState === 'listening' && (
              <Badge variant="outline" className="text-xs">
                {audioStats.codec.split('/')[1]?.toUpperCase() || audioStats.codec}
              </Badge>
            )}
          </div>
        </div>

        {/* Mode Selection - only show when not connected */}
        {connectionState !== 'listening' && connectionState !== 'connecting' && (
          <div className="space-y-2">
            <span className="text-sm text-muted-foreground">Mode:</span>
            <div className="flex gap-2">
              <Button
                variant={listenMode === 'listen' ? 'default' : 'outline'}
                size="sm"
                className="flex-1"
                onClick={() => setListenMode('listen')}
              >
                <Headphones className="mr-2 h-4 w-4" />
                Listen Only
              </Button>
              <Button
                variant={listenMode === 'join' ? 'default' : 'outline'}
                size="sm"
                className="flex-1"
                onClick={() => setListenMode('join')}
              >
                <Mic className="mr-2 h-4 w-4" />
                Join Call
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {listenMode === 'listen'
                ? 'Silent monitoring - you can hear but cannot be heard'
                : 'Two-way audio - you can take over the conversation'}
            </p>
          </div>
        )}

        {/* Error message */}
        {errorMessage && (
          <div className="bg-destructive/10 border border-destructive/20 rounded p-3 text-sm text-destructive">
            <div className="font-semibold mb-1">Error Details:</div>
            <pre className="whitespace-pre-wrap font-mono text-xs overflow-auto max-h-40">
              {errorMessage}
            </pre>
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
                {listenMode === 'listen' ? (
                  <Headphones className="mr-2 h-4 w-4" />
                ) : (
                  <Mic className="mr-2 h-4 w-4" />
                )}
                {listenMode === 'listen' ? 'Listen Live' : 'Join Call'}
              </>
            )}
          </Button>

          {/* Only show mute toggle in Join mode when connected */}
          {connectionState === 'listening' && listenMode === 'join' && (
            <Button
              onClick={handleMuteToggle}
              variant="outline"
              size="icon"
              title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
              className={isMuted ? 'text-muted-foreground' : 'text-destructive'}
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
          {connectionState === 'listening' ? (
            listenMode === 'listen'
              ? 'You are silently monitoring this call. Neither party can hear you.'
              : 'You are connected with two-way audio. Use the mic button to speak.'
          ) : (
            'Connect to monitor or join the ongoing call in real-time.'
          )}
        </p>
      </CardContent>
    </Card>
  );
}
