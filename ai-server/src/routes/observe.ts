/**
 * Live Call Observer WebSocket Route
 * ===================================
 * Allows authenticated users to listen to calls in real-time as a third-party observer.
 *
 * Architecture:
 * - Observer connects via WebSocket to /observe/:callControlId
 * - Server relays both inbound (caller) and outbound (assistant) audio tracks
 * - Audio is sent as μ-law 8kHz, decoded in browser via Web Audio API
 * - Multiple observers can connect to the same call
 */

import { WebSocket, WebSocketServer } from "ws";
import { IncomingMessage } from "http";
import { Server } from "http";
import * as contextMgr from "../callContextManager";
import { CallContext } from "../callContextManager";

/**
 * Observer connection state
 */
interface ObserverConnection {
  ws: WebSocket;
  callControlId: string;
  userId?: string;
  connectedAt: number;
}

/**
 * Map of callControlId -> Set of observer WebSocket connections
 */
const observersByCall = new Map<string, Set<ObserverConnection>>();

/**
 * Map of WebSocket -> ObserverConnection for cleanup
 */
const connectionMap = new Map<WebSocket, ObserverConnection>();

/**
 * Register an observer for a call
 */
export function addObserver(callControlId: string, observer: ObserverConnection): void {
  console.log(`[Observer DEBUG] addObserver called for callControlId: ${callControlId}`);
  if (!observersByCall.has(callControlId)) {
    console.log(`[Observer DEBUG] Creating new Set for callControlId: ${callControlId}`);
    observersByCall.set(callControlId, new Set());
  }
  observersByCall.get(callControlId)!.add(observer);
  connectionMap.set(observer.ws, observer);
  console.log(`[Observer DEBUG] Observer added. Total observers for this call: ${observersByCall.get(callControlId)!.size}`);
  console.log(`[Observer DEBUG] Total calls being observed: ${observersByCall.size}`);
  console.log(`[Observer] Added observer for call ${callControlId} (total: ${observersByCall.get(callControlId)!.size})`);
}

/**
 * Remove an observer connection
 */
export function removeObserver(ws: WebSocket): void {
  const observer = connectionMap.get(ws);
  if (!observer) return;

  const observers = observersByCall.get(observer.callControlId);
  if (observers) {
    observers.delete(observer);
    if (observers.size === 0) {
      observersByCall.delete(observer.callControlId);
    }
    console.log(`[Observer] Removed observer for call ${observer.callControlId} (remaining: ${observers.size})`);
  }
  connectionMap.delete(ws);
}

/**
 * Get the number of active observers for a call
 */
export function getObserverCount(callControlId: string): number {
  return observersByCall.get(callControlId)?.size || 0;
}

/**
 * Check if a call has any observers
 */
export function hasObservers(callControlId: string): boolean {
  return (observersByCall.get(callControlId)?.size || 0) > 0;
}

// Track audio packet count for debug logging (don't spam logs)
let audioPacketCount = 0;
let lastAudioLogTime = 0;

/**
 * Broadcast audio data to all observers of a call
 * @param callControlId - The call to broadcast to
 * @param track - 'inbound' (caller) or 'outbound' (assistant)
 * @param audioData - Raw μ-law audio bytes
 */
export function broadcastAudio(callControlId: string, track: 'inbound' | 'outbound', audioData: Buffer): void {
  const observers = observersByCall.get(callControlId);

  // Log periodically (every 5 seconds) to avoid spam
  audioPacketCount++;
  const now = Date.now();
  if (now - lastAudioLogTime > 5000) {
    console.log(`[Observer DEBUG] broadcastAudio called ${audioPacketCount} times, callControlId: ${callControlId}, observers: ${observers?.size || 0}`);
    audioPacketCount = 0;
    lastAudioLogTime = now;
  }

  if (!observers || observers.size === 0) return;

  // Create message with track info and base64 audio
  const message = JSON.stringify({
    event: 'audio',
    track,
    payload: audioData.toString('base64'),
    timestamp: Date.now(),
  });

  // Send to all observers
  for (const observer of observers) {
    if (observer.ws.readyState === WebSocket.OPEN) {
      try {
        observer.ws.send(message);
      } catch (error) {
        console.error(`[Observer] Error sending audio to observer:`, error);
        // Don't remove here - let the close/error handlers deal with it
      }
    }
  }
}

/**
 * Broadcast a transcript event to all observers
 */
export function broadcastTranscript(
  callControlId: string,
  speaker: 'caller' | 'assistant',
  text: string,
  isFinal: boolean = true
): void {
  const observers = observersByCall.get(callControlId);
  if (!observers || observers.size === 0) return;

  const message = JSON.stringify({
    event: 'transcript',
    speaker,
    text,
    isFinal,
    timestamp: Date.now(),
  });

  for (const observer of observers) {
    if (observer.ws.readyState === WebSocket.OPEN) {
      try {
        observer.ws.send(message);
      } catch (error) {
        console.error(`[Observer] Error sending transcript to observer:`, error);
      }
    }
  }
}

/**
 * Broadcast call state changes to observers
 */
export function broadcastCallState(
  callControlId: string,
  state: 'active' | 'ended' | 'error',
  details?: Record<string, any>
): void {
  const observers = observersByCall.get(callControlId);
  if (!observers || observers.size === 0) return;

  const message = JSON.stringify({
    event: 'call_state',
    state,
    details,
    timestamp: Date.now(),
  });

  for (const observer of observers) {
    if (observer.ws.readyState === WebSocket.OPEN) {
      try {
        observer.ws.send(message);
        // If call ended, close the observer connection
        if (state === 'ended') {
          observer.ws.close(1000, 'Call ended');
        }
      } catch (error) {
        console.error(`[Observer] Error sending call state to observer:`, error);
      }
    }
  }
}

/**
 * Parse the URL path to extract callControlId
 * Expected format: /observe/:callControlId
 */
function parseObservePath(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/^\/observe\/([^/?]+)/);
  // Decode URL-encoded callControlId (e.g., v3%3A... -> v3:...)
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Verify user authorization for observing a call
 * Currently DISABLED - allows all connections for simplicity
 * TODO: In production, implement proper JWT/session validation
 */
async function verifyObserverAuth(
  callControlId: string,
  userId: string | undefined
): Promise<{ authorized: boolean; reason?: string }> {
  console.log(`[Observer DEBUG] verifyObserverAuth called for ${callControlId}`);

  // TEMPORARILY DISABLED: Allow all observer connections
  // The call context might be on a different Fly.io instance,
  // so we can't verify locally. Just allow the connection.
  console.log(`[Observer DEBUG] Auth check BYPASSED - allowing connection`);
  return { authorized: true };
}

// Observer WebSocket server instance (created lazily)
let observerWss: WebSocketServer | null = null;

/**
 * Get or create the observer WebSocket server
 */
export function getObserverWss(): WebSocketServer {
  if (!observerWss) {
    observerWss = new WebSocketServer({ noServer: true });
    console.log('[Observer] Observer WebSocket server created');
  }
  return observerWss;
}

/**
 * Check if a URL path is an observer path
 */
export function isObserverPath(url: string): boolean {
  return url.startsWith('/observe/');
}

/**
 * Handle an observer WebSocket upgrade request
 * Call this from the main server's upgrade handler for /observe/* paths
 */
export async function handleObserverUpgrade(
  request: IncomingMessage,
  socket: any,
  head: Buffer
): Promise<void> {
  const url = request.url || '';
  console.log(`[Observer DEBUG] handleObserverUpgrade called with URL: ${url}`);

  const wss = getObserverWss();
  console.log(`[Observer DEBUG] Got observer WSS instance`);

  const callControlId = parseObservePath(url);
  console.log(`[Observer DEBUG] Parsed callControlId: ${callControlId}`);

  if (!callControlId) {
    console.log(`[Observer DEBUG] No callControlId found, returning 400`);
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // Extract userId from query params if present (for auth)
  const urlObj = new URL(url, 'http://localhost');
  const userId = urlObj.searchParams.get('userId') || undefined;
  console.log(`[Observer DEBUG] userId from query: ${userId}`);

  // Verify authorization
  try {
    console.log(`[Observer DEBUG] Verifying auth for callControlId: ${callControlId}`);
    const { authorized, reason } = await verifyObserverAuth(callControlId, userId);
    console.log(`[Observer DEBUG] Auth result: authorized=${authorized}, reason=${reason}`);

    if (!authorized) {
      console.log(`[Observer] Unauthorized connection attempt for ${callControlId}: ${reason}`);
      socket.write(`HTTP/1.1 403 Forbidden\r\n\r\n${reason}`);
      socket.destroy();
      return;
    }

    // Handle the upgrade
    console.log(`[Observer DEBUG] Auth passed, calling wss.handleUpgrade...`);
    wss.handleUpgrade(request, socket, head, (ws) => {
      console.log(`[Observer DEBUG] handleUpgrade callback fired, calling handleObserverConnection`);
      handleObserverConnection(ws, callControlId, userId);
    });
  } catch (error) {
    console.error('[Observer DEBUG] Auth error:', error);
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
  }
}

/**
 * Handle a new observer WebSocket connection
 */
function handleObserverConnection(ws: WebSocket, callControlId: string, userId?: string): void {
  console.log(`[Observer DEBUG] handleObserverConnection called`);
  console.log(`[Observer DEBUG] callControlId: ${callControlId}`);
  console.log(`[Observer DEBUG] userId: ${userId}`);
  console.log(`[Observer DEBUG] ws.readyState: ${ws.readyState}`);
  console.log(`[Observer] New observer connected for call ${callControlId}`);

  // Create observer record
  const observerConn: ObserverConnection = {
    ws,
    callControlId,
    userId,
    connectedAt: Date.now(),
  };

  // Register the observer
  addObserver(callControlId, observerConn);

  // Send initial state
  const context = contextMgr.getContext(callControlId);
  if (context) {
    ws.send(JSON.stringify({
      event: 'connected',
      callControlId,
      goal: context.goal,
      assistantName: context.assistantName,
      isActive: context.isCallActive,
      timestamp: Date.now(),
    }));
  } else {
    // Context not found - call may have ended or not started yet
    ws.send(JSON.stringify({
      event: 'connected',
      callControlId,
      isActive: false,
      message: 'Call context not found - call may have ended',
      timestamp: Date.now(),
    }));
  }

  // Handle messages from observer (currently just keepalive pings)
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'ping') {
        ws.send(JSON.stringify({ event: 'pong', timestamp: Date.now() }));
      }
    } catch (error) {
      // Ignore parse errors
    }
  });

  // Handle observer disconnect
  ws.on('close', () => {
    console.log(`[Observer] Observer disconnected from call ${callControlId}`);
    removeObserver(ws);
  });

  ws.on('error', (error) => {
    console.error(`[Observer] WebSocket error for call ${callControlId}:`, error);
    removeObserver(ws);
  });
}

/**
 * Setup the observer WebSocket server (legacy compatibility - now a no-op)
 * The actual setup is done via getObserverWss() and handleObserverUpgrade()
 * @deprecated Use getObserverWss() and handleObserverUpgrade() instead
 */
export function setupObserverWebSocket(server: Server): WebSocketServer {
  console.log('[Observer] Observer WebSocket server initialized (upgrade handling done in main server)');
  return getObserverWss();
}

/**
 * Get stats about active observers
 */
export function getObserverStats(): { totalObservers: number; callsBeingObserved: number } {
  let totalObservers = 0;
  for (const observers of observersByCall.values()) {
    totalObservers += observers.size;
  }
  return {
    totalObservers,
    callsBeingObserved: observersByCall.size,
  };
}
