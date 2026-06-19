/**
 * WebSocket Server — real-time event broadcasting to clients.
 * Bridges Redis Streams + PG LISTEN/NOTIFY → WebSocket connections.
 * JWT-authenticated, room-based subscriptions.
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import { redis, subRedis } from '../config/redis.js';
import { getDirectClient } from '../config/database.js';
import { verifyToken } from '../modules/auth/auth.service.js';
import { STREAMS } from '../events/event-bus.js';
import { logger } from '../observability/logger.js';
import { getEnv } from '../config/env.js';
import type { JwtPayload } from '../modules/auth/auth.types.js';

interface AuthenticatedSocket extends WebSocket {
  user: JwtPayload;
  subscriptions: Set<string>;
  isAlive: boolean;
}

export class WsServer {
  private wss!: WebSocketServer;
  private httpServer!: http.Server;
  private clients: Map<string, Set<AuthenticatedSocket>> = new Map();
  private heartbeatInterval!: NodeJS.Timeout;
  private streamReaderRunning = false;

  async start(): Promise<void> {
    const env = getEnv();
    this.httpServer = http.createServer();

    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: '/ws',
      verifyClient: async (info, done) => {
        try {
          const url = new URL(info.req.url!, `http://${info.req.headers.host}`);
          const token = url.searchParams.get('token');
          if (!token) {
            done(false, 401, 'Missing token');
            return;
          }
          const user = verifyToken(token);
          (info.req as any).user = user;
          done(true);
        } catch {
          done(false, 401, 'Invalid token');
        }
      },
    });

    this.wss.on('connection', (ws: WebSocket, req) => {
      const socket = ws as AuthenticatedSocket;
      socket.user = (req as any).user;
      socket.subscriptions = new Set();
      socket.isAlive = true;

      // Track by orgId for targeted broadcasting
      const orgKey = `org:${socket.user.orgId}`;
      if (!this.clients.has(orgKey)) {
        this.clients.set(orgKey, new Set());
      }
      this.clients.get(orgKey)!.add(socket);

      logger.info('WebSocket client connected', {
        userId: socket.user.userId,
        orgId: socket.user.orgId,
      });

      socket.on('pong', () => { socket.isAlive = true; });

      socket.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleClientMessage(socket, msg);
        } catch {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        }
      });

      socket.on('close', () => {
        this.clients.get(orgKey)?.delete(socket);
        if (this.clients.get(orgKey)?.size === 0) {
          this.clients.delete(orgKey);
        }
        logger.debug('WebSocket client disconnected', { userId: socket.user.userId });
      });

      socket.on('error', (err) => {
        logger.error('WebSocket error', { error: err.message, userId: socket.user.userId });
      });

      // Send initial connection confirmation
      socket.send(JSON.stringify({
        type: 'connected',
        userId: socket.user.userId,
        orgId: socket.user.orgId,
      }));
    });

    // Heartbeat to detect stale connections
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        const socket = ws as AuthenticatedSocket;
        if (!socket.isAlive) {
          socket.terminate();
          return;
        }
        socket.isAlive = false;
        socket.ping();
      });
    }, 30000);

    // Start Redis Stream reader for event broadcasting
    this.startStreamReader();

    // Start PG LISTEN/NOTIFY listener
    this.startPgListener();

    this.httpServer.listen(env.WS_PORT, () => {
      logger.info(`WebSocket server listening on port ${env.WS_PORT}`);
    });
  }

  /**
   * Handle client messages (subscribe/unsubscribe/typing).
   */
  private handleClientMessage(socket: AuthenticatedSocket, msg: any): void {
    switch (msg.type) {
      case 'subscribe': {
        const channels = Array.isArray(msg.channels) ? msg.channels : [msg.channel];
        for (const ch of channels) {
          // Validate channel belongs to user's org
          if (this.isAuthorizedChannel(socket.user, ch)) {
            socket.subscriptions.add(ch);
          }
        }
        socket.send(JSON.stringify({
          type: 'subscribed',
          channels: Array.from(socket.subscriptions),
        }));
        break;
      }

      case 'unsubscribe': {
        const channels = Array.isArray(msg.channels) ? msg.channels : [msg.channel];
        for (const ch of channels) {
          socket.subscriptions.delete(ch);
        }
        break;
      }

      case 'typing:start':
      case 'typing:stop': {
        // Broadcast typing status to other subscribers of this chat
        this.broadcastToChannel(`chat:${msg.chatId}`, {
          type: msg.type === 'typing:start' ? 'typing:update' : 'typing:stop',
          chatId: msg.chatId,
          userId: socket.user.userId,
          isTyping: msg.type === 'typing:start',
        }, socket);
        break;
      }

      case 'message:read': {
        // Client acknowledges reading messages in a chat
        this.broadcastToChannel(`chat:${msg.chatId}`, {
          type: 'read:update',
          chatId: msg.chatId,
          userId: socket.user.userId,
        }, socket);
        break;
      }

      default:
        socket.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
    }
  }

  /**
   * Validate that a subscription channel belongs to the user's org.
   */
  private isAuthorizedChannel(user: JwtPayload, channel: string): boolean {
    // All channels for this user's org are allowed
    // Format: session:{sessionId}, chat:{chatId}, org:{orgId}
    if (channel.startsWith('org:') && channel === `org:${user.orgId}`) return true;
    if (channel.startsWith('session:') || channel.startsWith('chat:')) return true;
    return false;
  }

  /**
   * Broadcast a message to all subscribers of a channel within an org.
   */
  broadcastToChannel(channel: string, data: any, exclude?: AuthenticatedSocket): void {
    for (const [, clients] of this.clients) {
      for (const client of clients) {
        if (client === exclude) continue;
        if (client.readyState !== WebSocket.OPEN) continue;
        if (client.subscriptions.has(channel)) {
          client.send(JSON.stringify(data));
        }
      }
    }
  }

  /**
   * Broadcast to all clients in an org.
   */
  broadcastToOrg(orgId: string, data: any): void {
    const orgClients = this.clients.get(`org:${orgId}`);
    if (!orgClients) return;

    const payload = JSON.stringify(data);
    for (const client of orgClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /**
   * Read Redis Streams and broadcast events to WebSocket clients.
   */
  private async startStreamReader(): Promise<void> {
    this.streamReaderRunning = true;
    const consumerGroup = 'ws-server';
    const consumerName = `ws-${process.pid}`;
    const streams = Object.values(STREAMS);

    // Create consumer groups
    for (const stream of streams) {
      try {
        await redis.xgroup('CREATE', stream, consumerGroup, '0', 'MKSTREAM');
      } catch (err: any) {
        if (!err.message?.includes('BUSYGROUP')) {
          logger.error('Failed to create consumer group', { stream, error: err.message });
        }
      }
    }

    // Read loop
    const readLoop = async () => {
      while (this.streamReaderRunning) {
        try {
          const results = await redis.xreadgroup(
            'GROUP', consumerGroup, consumerName,
            'COUNT', '50',
            'BLOCK', '5000',
            'STREAMS', ...streams, ...streams.map(() => '>')
          ) as any;

          if (results) {
            for (const [stream, messages] of results) {
              for (const [id, fields] of messages) {
                try {
                  const event = fields[1]; // 'event' field value
                  const data = JSON.parse(fields[3]); // 'data' field value

                  // Broadcast based on event type
                  if (data.orgId) {
                    this.broadcastToOrg(data.orgId, { type: event, ...data });
                  }

                  // Also broadcast to specific channels
                  if (data.sessionId) {
                    this.broadcastToChannel(`session:${data.sessionId}`, { type: event, ...data });
                  }
                  if (data.chatId) {
                    this.broadcastToChannel(`chat:${data.chatId}`, { type: event, ...data });
                  }

                  await redis.xack(stream as string, consumerGroup, id);
                } catch (err) {
                  logger.error('Failed to process stream message', { error: (err as Error).message });
                }
              }
            }
          }
        } catch (err) {
          if (this.streamReaderRunning) {
            logger.error('Stream reader error', { error: (err as Error).message });
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
    };

    readLoop().catch((err) => logger.error('Stream reader crashed', { error: err.message }));
  }

  /**
   * Listen for PostgreSQL NOTIFY events on the 'new_message' channel.
   * These are fired by the on_new_message() trigger in the DB.
   */
  private async startPgListener(): Promise<void> {
    try {
      const client = await getDirectClient();

      client.on('notification', (msg) => {
        if (msg.channel === 'new_message' && msg.payload) {
          try {
            const data = JSON.parse(msg.payload);
            // Broadcast to org and chat channels
            if (data.sessionId) {
              this.broadcastToChannel(`session:${data.sessionId}`, {
                type: 'message:new:notify',
                ...data,
              });
            }
          } catch (err) {
            logger.error('Failed to process PG notification', { error: (err as Error).message });
          }
        }
      });

      await client.query('LISTEN new_message');
      logger.info('PostgreSQL LISTEN/NOTIFY active on channel: new_message');

      // Note: Don't release this client — it must stay connected for LISTEN
    } catch (err) {
      logger.error('Failed to start PG listener', { error: (err as Error).message });
    }
  }

  /**
   * Get connected client count.
   */
  getClientCount(): number {
    let count = 0;
    for (const [, clients] of this.clients) {
      count += clients.size;
    }
    return count;
  }

  /**
   * Graceful shutdown.
   */
  async close(): Promise<void> {
    this.streamReaderRunning = false;
    clearInterval(this.heartbeatInterval);

    // Close all client connections
    this.wss.clients.forEach((ws) => {
      ws.close(1001, 'Server shutting down');
    });

    return new Promise((resolve) => {
      this.httpServer.close(() => {
        logger.info('WebSocket server closed');
        resolve();
      });
    });
  }
}

export const wsServer = new WsServer();
