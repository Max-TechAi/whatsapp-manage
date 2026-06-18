/**
 * SessionManager — orchestrates all active WhatsApp connections.
 *
 * This is the core runtime component of the platform. It manages the
 * lifecycle of Baileys WebSocket connections, including:
 * - Creating new sessions (insert DB record → open socket → QR pairing)
 * - Reconnecting with exponential backoff on disconnection
 * - Restoring all sessions on server startup
 * - Routing Baileys events to internal queues and WebSocket broadcasts
 *
 * Exported as a singleton (`sessionManager`) for use across the application.
 */

import makeWASocket, {
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import type { WASocket, BaileysEventMap, WAMessage } from '@whiskeysockets/baileys';
import * as QRCode from 'qrcode';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { eq, and, inArray } from 'drizzle-orm';
import { Boom } from '@hapi/boom';

import { db } from '../../config/database.js';
import { sessions, sessionKeys } from '../../db/schema.js';
import { redis } from '../../config/redis.js';
import { logger } from '../../observability/logger.js';
import { usePostgresAuthState } from './session.auth-state.js';
import { SessionEventType, normalizeJid } from './session.events.js';
import type { ActiveSession, SessionStatus, WhatsAppSession } from './session.types.js';

/** Maximum number of reconnection attempts before giving up */
const MAX_RETRIES = 10;

/** Maximum reconnection delay in milliseconds (5 minutes) */
const MAX_RETRY_DELAY_MS = 300_000;

/**
 * Manages all active WhatsApp Baileys sessions.
 *
 * Maintains an in-memory map of active sockets and coordinates
 * their lifecycle against the PostgreSQL session records.
 */
class SessionManager {
  /** Map of sessionId → active Baileys socket and metadata */
  private activeSessions: Map<string, ActiveSession> = new Map();

  /**
   * Create a new WhatsApp session.
   *
   * Inserts a session record in the database, then initializes the
   * Baileys socket which will emit a QR code for pairing.
   *
   * @param orgId - Organization creating the session
   * @param userId - User who initiated the creation
   * @param sessionName - Human-readable label for the session
   * @returns The created session record
   */
  async createSession(
    orgId: string,
    userId: string,
    sessionName: string,
  ): Promise<WhatsAppSession> {
    const sessionId = uuidv4();
    const now = new Date();

    logger.info('Creating new WhatsApp session', {
      sessionId,
      orgId,
      sessionName,
    });

    // Insert the session record
    await db.insert(sessions).values({
      id: sessionId,
      orgId,
      userId,
      sessionName,
      phoneNumber: null,
      status: 'initializing',
      qrCode: null,
      authCreds: null,
      lastConnectedAt: null,
      createdAt: now,
    });

    // Initialize the Baileys socket (async, will emit QR events)
    await this.initializeSocket(sessionId, orgId);

    // Return the session record
    const session: WhatsAppSession = {
      id: sessionId,
      orgId,
      userId,
      sessionName,
      phoneNumber: null,
      status: 'initializing',
      qrCode: null,
      lastConnectedAt: null,
      createdAt: now,
    };

    return session;
  }

  /**
   * Initialize a Baileys WebSocket connection for a session.
   *
   * Loads auth state from PostgreSQL, creates the socket with optimal
   * settings, and wires up all event handlers.
   *
   * @param sessionId - Session to initialize
   * @param orgId - Organization scope for event routing
   */
  async initializeSocket(sessionId: string, orgId: string): Promise<void> {
    try {
      // Load encrypted auth state from database
      const { state, saveCreds } = await usePostgresAuthState(sessionId);

      // Get latest Baileys version for maximum compatibility
      const { version } = await fetchLatestBaileysVersion();

      logger.info('Initializing Baileys socket', {
        sessionId,
        baileysVersion: version.join('.'),
      });

      // Create the Baileys socket with production-optimized settings
      const socket = makeWASocket({
        auth: state,
        version,
        browser: Browsers.macOS('Desktop'),
        logger: pino({ level: 'silent' }) as any,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: true,
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true,
      });

      // Wire up all Baileys event handlers
      this.registerEventHandlers(socket, sessionId, orgId, saveCreds);

      // Store in active sessions map
      this.activeSessions.set(sessionId, {
        socket,
        sessionId,
        orgId,
        retryCount: 0,
        lastRetry: null,
      });

      logger.info('Baileys socket initialized', { sessionId });
    } catch (error) {
      logger.error('Failed to initialize Baileys socket', {
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      // Update DB status to reflect failure
      await this.updateSessionStatus(sessionId, 'disconnected');
      throw error;
    }
  }

  /**
   * Destroy a session permanently.
   *
   * Closes the WebSocket, removes from memory, updates DB status,
   * and deletes all associated signal protocol keys.
   *
   * @param sessionId - Session to destroy
   */
  async destroySession(sessionId: string): Promise<void> {
    logger.info('Destroying session', { sessionId });

    // Close the socket if active
    const active = this.activeSessions.get(sessionId);
    if (active) {
      try {
        active.socket.end(undefined);
      } catch (error) {
        logger.warn('Error closing socket during destroy', {
          sessionId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      this.activeSessions.delete(sessionId);
    }

    // Update DB status
    await this.updateSessionStatus(sessionId, 'disconnected');

    // Clean up signal keys
    try {
      await db
        .delete(sessionKeys)
        .where(eq(sessionKeys.sessionId, sessionId));
      logger.debug('Deleted session keys', { sessionId });
    } catch (error) {
      logger.error('Failed to delete session keys', {
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    // Clean up Redis presence data
    try {
      const presenceKeys = await redis.keys(`presence:${sessionId}:*`);
      if (presenceKeys.length > 0) {
        await redis.del(...presenceKeys);
      }
    } catch (error) {
      logger.warn('Failed to clean up presence data', {
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Restore all previously active sessions on server startup.
   *
   * Queries sessions with 'connected' or 'disconnected' status
   * and reinitializes their sockets. This enables seamless restarts.
   */
  async restoreAllSessions(): Promise<void> {
    logger.info('Restoring all active sessions...');

    try {
      const sessionsToRestore = await db
        .select({ id: sessions.id, orgId: sessions.orgId })
        .from(sessions)
        .where(
          inArray(sessions.status, ['connected', 'disconnected']),
        );

      logger.info(`Found ${sessionsToRestore.length} sessions to restore`);

      // Restore sessions sequentially to avoid overwhelming the system
      for (const session of sessionsToRestore) {
        try {
          await this.initializeSocket(session.id, session.orgId);
          logger.info('Session restored', { sessionId: session.id });
        } catch (error) {
          logger.error('Failed to restore session', {
            sessionId: session.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      logger.info('Session restoration complete', {
        total: sessionsToRestore.length,
        active: this.activeSessions.size,
      });
    } catch (error) {
      logger.error('Failed to query sessions for restoration', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get an active session by ID.
   *
   * @param sessionId - Session to look up
   * @returns Active session or undefined if not in memory
   */
  getSession(sessionId: string): ActiveSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * Get all active sessions for an organization.
   *
   * @param orgId - Organization to filter by
   * @returns Array of active sessions belonging to the org
   */
  getAllSessions(orgId?: string): ActiveSession[] {
    const result: ActiveSession[] = [];
    for (const session of this.activeSessions.values()) {
      if (!orgId || session.orgId === orgId) {
        result.push(session);
      }
    }
    return result;
  }

  /**
   * Get the current status of a session from the in-memory state.
   * Falls back to 'disconnected' if the session is not in memory.
   *
   * @param sessionId - Session to check
   * @returns Current session status
   */
  getSessionStatus(sessionId: string): SessionStatus {
    const active = this.activeSessions.get(sessionId);
    if (!active) return 'disconnected';

    // Check if the socket user is available (indicates connected state)
    if (active.socket.user) return 'connected';

    return 'connecting';
  }

  // ─── Private Methods ──────────────────────────────────────────────────

  /**
   * Register all Baileys event handlers on a socket.
   *
   * This is the main event wiring that translates Baileys protocol
   * events into our internal event system (BullMQ queues, WebSocket
   * broadcasts, Redis presence, etc.).
   *
   * @param socket - Baileys WASocket instance
   * @param sessionId - Session ID for scoping
   * @param orgId - Organization scope for multi-tenancy
   * @param saveCreds - Callback to persist updated credentials
   */
  private registerEventHandlers(
    socket: WASocket,
    sessionId: string,
    orgId: string,
    saveCreds: () => Promise<void>,
  ): void {
    // ── Connection State Updates ──────────────────────────────────────

    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR code generated — convert to data URL for client display
      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, {
            width: 300,
            margin: 2,
            color: {
              dark: '#000000',
              light: '#FFFFFF',
            },
          });

          await db
            .update(sessions)
            .set({
              qrCode: qrDataUrl,
              status: 'qr_pending',
            })
            .where(eq(sessions.id, sessionId));

          logger.info('QR code generated', { sessionId });

          // TODO: Broadcast QR to WebSocket clients
          // eventBus.broadcast(orgId, SessionEventType.QR_GENERATED, { sessionId, qrCode: qrDataUrl });
        } catch (error) {
          logger.error('Failed to generate QR data URL', {
            sessionId,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      // Connection opened — session is fully authenticated
      if (connection === 'open') {
        const active = this.activeSessions.get(sessionId);
        if (active) {
          active.retryCount = 0;
          active.lastRetry = null;
        }

        const phoneNumber = socket.user?.id
          ? normalizeJid(socket.user.id)
          : null;

        await db
          .update(sessions)
          .set({
            status: 'connected',
            qrCode: null,
            phoneNumber,
            lastConnectedAt: new Date(),
          })
          .where(eq(sessions.id, sessionId));

        logger.info('Session connected', {
          sessionId,
          phoneNumber: phoneNumber ? '[REDACTED]' : null,
        });

        // TODO: Broadcast connection event
        // eventBus.broadcast(orgId, SessionEventType.CONNECTED, { sessionId });
      }

      // Connection closed — determine if retryable or terminal
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isBanned = statusCode === 401;

        if (isLoggedOut || isBanned) {
          // Terminal state — user logged out or account banned
          const terminalStatus: SessionStatus = isBanned ? 'banned' : 'disconnected';

          await db
            .update(sessions)
            .set({
              status: terminalStatus,
              qrCode: null,
            })
            .where(eq(sessions.id, sessionId));

          // Clean up in-memory state
          this.activeSessions.delete(sessionId);

          // Clean up signal keys on logout
          if (isLoggedOut) {
            await db
              .delete(sessionKeys)
              .where(eq(sessionKeys.sessionId, sessionId));
          }

          logger.warn('Session terminated', {
            sessionId,
            reason: isLoggedOut ? 'logged_out' : 'banned',
            statusCode,
          });

          // TODO: Broadcast disconnection event
          // eventBus.broadcast(orgId, SessionEventType.DISCONNECTED, { sessionId, reason });
        } else {
          // Retryable disconnection — attempt reconnection with backoff
          const active = this.activeSessions.get(sessionId);
          const retryCount = active ? active.retryCount + 1 : 1;

          if (retryCount <= MAX_RETRIES) {
            // Exponential backoff: delay = min(retryCount^2 * 1000, 300000)
            const delay = Math.min(
              Math.pow(retryCount, 2) * 1000,
              MAX_RETRY_DELAY_MS,
            );

            if (active) {
              active.retryCount = retryCount;
              active.lastRetry = new Date();
            }

            await this.updateSessionStatus(sessionId, 'disconnected');

            logger.info('Scheduling reconnection', {
              sessionId,
              retryCount,
              delayMs: delay,
              statusCode,
            });

            // Schedule reconnection after backoff delay
            setTimeout(async () => {
              try {
                // Remove stale socket before reinitializing
                this.activeSessions.delete(sessionId);
                await this.initializeSocket(sessionId, orgId);
              } catch (error) {
                logger.error('Reconnection failed', {
                  sessionId,
                  retryCount,
                  error:
                    error instanceof Error ? error.message : 'Unknown error',
                });
              }
            }, delay);
          } else {
            // Exhausted retries
            await this.updateSessionStatus(sessionId, 'disconnected');
            this.activeSessions.delete(sessionId);

            logger.error('Max reconnection attempts reached', {
              sessionId,
              maxRetries: MAX_RETRIES,
            });
          }
        }
      }
    });

    // ── Credential Updates ────────────────────────────────────────────

    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (error) {
        logger.error('Failed to save credentials on update', {
          sessionId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // ── Inbound Messages ──────────────────────────────────────────────

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      logger.debug('Messages upsert received', {
        sessionId,
        count: messages.length,
        type,
      });

      // TODO: Publish to message-inbound BullMQ queue
      // eventBus.publishMessageInbound(sessionId, orgId, messages, type);
    });

    // ── History Sync ──────────────────────────────────────────────────

    socket.ev.on('messaging-history.set', async (data) => {
      const { chats, contacts, messages, isLatest } = data;

      logger.info('History sync received', {
        sessionId,
        chats: chats.length,
        contacts: contacts.length,
        messages: messages.length,
        isLatest,
      });

      // TODO: Publish to history sync BullMQ queue
      // eventBus.publishHistorySync(sessionId, orgId, data);
    });

    // ── Chat Events ───────────────────────────────────────────────────

    socket.ev.on('chats.upsert', async (chats) => {
      logger.debug('Chats upsert', {
        sessionId,
        count: chats.length,
      });

      // TODO: Publish to chat sync BullMQ queue
      // eventBus.publishChatSync(sessionId, orgId, 'upsert', chats);
    });

    socket.ev.on('chats.update', async (updates) => {
      logger.debug('Chats update', {
        sessionId,
        count: updates.length,
      });

      // TODO: Publish to chat sync BullMQ queue
      // eventBus.publishChatSync(sessionId, orgId, 'update', updates);
    });

    socket.ev.on('chats.delete', async (deletions) => {
      logger.debug('Chats delete', {
        sessionId,
        count: deletions.length,
      });

      // TODO: Publish to chat sync BullMQ queue
      // eventBus.publishChatSync(sessionId, orgId, 'delete', deletions);
    });

    // ── Contact Events ────────────────────────────────────────────────

    socket.ev.on('contacts.upsert', async (contacts) => {
      logger.debug('Contacts upsert', {
        sessionId,
        count: contacts.length,
      });

      // TODO: Publish to contact sync BullMQ queue
      // eventBus.publishContactSync(sessionId, orgId, 'upsert', contacts);
    });

    socket.ev.on('contacts.update', async (updates) => {
      logger.debug('Contacts update', {
        sessionId,
        count: updates.length,
      });

      // TODO: Publish to contact sync BullMQ queue
      // eventBus.publishContactSync(sessionId, orgId, 'update', updates);
    });

    // ── Presence Updates ──────────────────────────────────────────────

    socket.ev.on('presence.update', async (presence) => {
      const { id: jid, presences } = presence;

      if (!presences) return;

      try {
        // Store each participant's presence in Redis with 5-minute TTL
        for (const [participantJid, presenceData] of Object.entries(presences)) {
          const redisKey = `presence:${sessionId}:${normalizeJid(jid)}:${normalizeJid(participantJid)}`;
          const value = JSON.stringify({
            lastKnownPresence: presenceData.lastKnownPresence,
            lastSeen: presenceData.lastSeen ?? null,
            updatedAt: Date.now(),
          });

          await redis.setex(redisKey, 300, value); // 5-minute TTL
        }
      } catch (error) {
        logger.warn('Failed to store presence in Redis', {
          sessionId,
          jid,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      // TODO: Broadcast presence to WebSocket clients
      // eventBus.broadcast(orgId, SessionEventType.PRESENCE_UPDATED, { sessionId, jid, presences });
    });
  }

  /**
   * Helper to update session status in the database.
   *
   * @param sessionId - Session to update
   * @param status - New status value
   */
  private async updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
  ): Promise<void> {
    try {
      await db
        .update(sessions)
        .set({ status })
        .where(eq(sessions.id, sessionId));
    } catch (error) {
      logger.error('Failed to update session status', {
        sessionId,
        status,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

/** Singleton SessionManager instance for application-wide use */
export const sessionManager = new SessionManager();
