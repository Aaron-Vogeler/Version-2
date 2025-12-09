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
  if (!observersByCall.has(callControlId)) {
    observersByCall.set(callControlId, new Set());
  }
  observersByCall.get(callControlId)!.add(observer);
  connectionMap.set(observer.ws, observer);
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

/**
 * Broadcast audio data to all observers of a call
 * @param callControlId - The call to broadcast to
 * @param track - 'inbound' (caller) or 'outbound' (assistant)
 * @param audioData - Raw μ-law audio bytes
 */
export function broadcastAudio(callControlId: string, track: 'inbound' | 'outbound', audioData: Buffer): void {
  const observers = observersByCall.get(callControlId);
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
  return match ? match[1] : null;
}

/**
 * Verify user authorization for observing a call
 * Currently checks if the call exists and user matches
 * In production, you'd want proper JWT/session validation
 */
async function verifyObserverAuth(
  callControlId: string,
  userId: string | undefined
): Promise<{ authorized: boolean; reason?: string }> {
  // Get the call context
  const context = contextMgr.getContext(callControlId);

  if (!context) {
    return { authorized: false, reason: 'Call not found or not active' };
  }

  if (!context.isCallActive) {
    return { authorized: false, reason: 'Call is not active' };
  }

  // For now, allow observation if user owns the call or no userId check
  // In production, implement proper authorization
  if (userId && context.userId && context.userId !== userId) {
    return { authorized: false, reason: 'Not authorized to observe this call' };
  }

  return { authorized: true };
}

/**
 * Setup the observer WebSocket server on an existing HTTP server
 * Uses a separate path (/observe/:callControlId) from the main media WebSocket
 */
export function setupObserverWebSocket(server: Server): WebSocketServer {
  // Create a new WebSocket server for observers
  const observerWss = new WebSocketServer({
    noServer: true,
  });

  // Handle upgrade requests
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = request.url || '';

    // Only handle /observe/* paths
    if (!url.startsWith('/observe/')) {
      return; // Let other handlers deal with it
    }

    const callControlId = parseObservePath(url);
    if (!callControlId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // Extract userId from query params if present (for auth)
    const urlObj = new URL(url, 'http://localhost');
    const userId = urlObj.searchParams.get('userId') || undefined;

    // Verify authorization
    verifyObserverAuth(callControlId, userId).then(({ authorized, reason }) => {
      if (!authorized) {
        console.log(`[Observer] Unauthorized connection attempt for ${callControlId}: ${reason}`);
        socket.write(`HTTP/1.1 403 Forbidden\r\n\r\n${reason}`);
        socket.destroy();
        return;
      }

      // Handle the upgrade
      observerWss.handleUpgrade(request, socket, head, (ws) => {
        observerWss.emit('connection', ws, request, callControlId, userId);
      });
    }).catch((error) => {
      console.error('[Observer] Auth error:', error);
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    });
  });

  // Handle new observer connections
  observerWss.on('connection', (ws: WebSocket, request: IncomingMessage, callControlId: string, userId?: string) => {
    console.log(`[Observer] New observer connected for call ${callControlId}`);

    // Create observer record
    const observer: ObserverConnection = {
      ws,
      callControlId,
      userId,
      connectedAt: Date.now(),
    };

    // Register the observer
    addObserver(callControlId, observer);

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
  });

  console.log('[Observer] Observer WebSocket server initialized');
  return observerWss;
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
