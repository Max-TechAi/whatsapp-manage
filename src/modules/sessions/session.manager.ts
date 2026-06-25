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
import { eq, and, inArray, sql, lte, ne, desc } from 'drizzle-orm';
import { Boom } from '@hapi/boom';

import { db } from '../../config/database.js';
import { sessions, sessionKeys, messages } from '../../db/schema.js';
import { redis } from '../../config/redis.js';
import { logger } from '../../observability/logger.js';
import { usePostgresAuthState } from './session.auth-state.js';
import { SessionEventType, normalizeJid } from './session.events.js';
import type { ActiveSession, SessionStatus, WhatsAppSession } from './session.types.js';
import { saveLidMapping, resolveLidJid } from './lid-mapping.js';
import { eventBus, STREAMS } from '../../events/event-bus.js';

/** Maximum number of reconnection attempts before giving up */
const MAX_RETRIES = 10;

/** Maximum reconnection delay in milliseconds (5 minutes) */
const MAX_RETRY_DELAY_MS = 300_000;

/**
 * Validate that a given string is a valid UUID v4 format.
 * This prevents PostgreSQL from throwing "invalid input syntax for type uuid".
 */
export function isValidUuid(id: unknown): boolean {
  if (typeof id !== 'string') return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

/**
 * Manages all active WhatsApp Baileys sessions.

 *
 * Maintains an in-memory map of active sockets and coordinates
 * their lifecycle against the PostgreSQL session records.
 */
class SessionManager {
  /** Map of sessionId → active Baileys socket and metadata */
  private activeSessions: Map<string, ActiveSession> = new Map();

  /** Set of sessionIds currently initializing to prevent concurrent duplicate sockets */
  private initializingSessions: Set<string> = new Set();

  /** Map of sessionId → scheduled reconnect Timeout */
  private pendingReconnects: Map<string, NodeJS.Timeout> = new Map();

  /** Map of sessionId → initial sync timeout (inactivity timer) */
  private syncTimeouts: Map<string, NodeJS.Timeout> = new Map();

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
    // Add guard to prevent invalid/null UUID check crashes in PostgreSQL
    if (!isValidUuid(sessionId) || !isValidUuid(orgId)) {
      logger.warn('initializeSocket skipped for invalid sessionId or orgId', { sessionId, orgId, stack: new Error().stack });
      return;
    }
    if (this.initializingSessions.has(sessionId)) {
      logger.warn('Socket initialization already in progress for session', { sessionId });
      return;
    }
    this.initializingSessions.add(sessionId);

    try {
      // Clear any pending reconnect timeout
      const reconnectTimeout = this.pendingReconnects.get(sessionId);
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        this.pendingReconnects.delete(sessionId);
      }

      // Check and close existing active socket to avoid leak/duplication
      const existingSession = this.activeSessions.get(sessionId);
      if (existingSession) {
        try {
          logger.info('Ending existing socket before reinitializing', { sessionId });
          existingSession.socket.ev.removeAllListeners('connection.update');
          existingSession.socket.ev.removeAllListeners('creds.update');
          existingSession.socket.ev.removeAllListeners('messages.upsert');
          existingSession.socket.ev.removeAllListeners('messages.update');
          existingSession.socket.ev.removeAllListeners('message-receipt.update');
          existingSession.socket.ev.removeAllListeners('messaging-history.set');
          existingSession.socket.end(undefined);
        } catch (err) {
          logger.warn('Error ending existing socket during reinitialization', { sessionId, error: (err as Error).message });
        }
        this.removeActiveSession(sessionId);
      }

      // Load encrypted auth state from database
      const { state, saveCreds } = await usePostgresAuthState(sessionId);

      // Get latest Baileys version for maximum compatibility
      const { version } = await fetchLatestBaileysVersion();

      // Read historySyncCompleted from session metadata to prevent Baileys from requesting history again
      const [sessionRecord] = await db
        .select({ metadata: sessions.metadata })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      const metadata = (sessionRecord?.metadata || {}) as Record<string, any>;
      const historySyncCompleted = !!metadata.historySyncCompleted;

      logger.info('Initializing Baileys socket', {
        sessionId,
        baileysVersion: version.join('.'),
        historySyncCompleted,
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
        syncFullHistory: !historySyncCompleted,
        shouldSyncHistoryMessage: () => !historySyncCompleted,
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
        isInitialSyncConnection: !historySyncCompleted,
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
    } finally {
      this.initializingSessions.delete(sessionId);
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
    // Add guard to prevent invalid/null UUID check crashes in PostgreSQL
    if (!isValidUuid(sessionId)) {
      logger.warn('destroySession skipped for invalid sessionId', { sessionId, stack: new Error().stack });
      return;
    }
    logger.info('Destroying session', { sessionId });

    // Clear reconnection and sync timeouts
    const reconnectTimeout = this.pendingReconnects.get(sessionId);
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      this.pendingReconnects.delete(sessionId);
    }
    this.clearSyncTimeout(sessionId);

    // Close the socket if active
    const active = this.activeSessions.get(sessionId);
    if (active) {
      try {
        active.socket.ev.removeAllListeners('connection.update');
        active.socket.ev.removeAllListeners('creds.update');
        active.socket.ev.removeAllListeners('messages.upsert');
        active.socket.ev.removeAllListeners('messages.update');
        active.socket.ev.removeAllListeners('message-receipt.update');
        active.socket.ev.removeAllListeners('messaging-history.set');
        active.socket.end(undefined);
      } catch (error) {
        logger.warn('Error closing socket during destroy', {
          sessionId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      this.removeActiveSession(sessionId);
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

          // Broadcast QR to WebSocket clients
          await eventBus.publishToStream(STREAMS.SESSIONS, 'session:status', {
            sessionId,
            orgId,
            status: 'qr_pending',
            qrCode: qrDataUrl,
          });
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
          this.setupPresenceKeepAlive(active);
        }

        // Clear any pending reconnects
        const reconnectTimeout = this.pendingReconnects.get(sessionId);
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout);
          this.pendingReconnects.delete(sessionId);
        }

        const phoneNumber = socket.user?.id
          ? socket.user.id.split('@')[0]?.split(':')[0] || null
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

        // Check if history sync has been completed before
        const [sessionRecord] = await db
          .select({ metadata: sessions.metadata })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        const metadata = (sessionRecord?.metadata || {}) as Record<string, any>;
        const historySyncCompleted = !!metadata.historySyncCompleted;

        if (!historySyncCompleted) {
          // Initialize sync state to pending on first-time pairing connect
          const progressKey = `sync:progress:${sessionId}`;
          const hasStarted = await redis.exists(progressKey);
          if (!hasStarted) {
            await updateSyncProgress(sessionId, 'pending', 0, 0);
          }
          this.resetSyncTimeout(sessionId, orgId);
        }

        // Broadcast connection event
        await eventBus.publishToStream(STREAMS.SESSIONS, 'session:status', {
          sessionId,
          orgId,
          status: 'connected',
          phoneNumber,
          historySyncCompleted,
        });
      }

      // Connection closed — determine if retryable or terminal
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isBanned = statusCode === 401;

        if (isLoggedOut || isBanned) {
          // Terminal state — user logged out or account banned
          const terminalStatus: SessionStatus = isBanned ? 'banned' : 'disconnected';

          // Clear timeouts
          this.clearSyncTimeout(sessionId);
          const reconnectTimeout = this.pendingReconnects.get(sessionId);
          if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            this.pendingReconnects.delete(sessionId);
          }

          await db
            .update(sessions)
            .set({
              status: terminalStatus,
              qrCode: null,
            })
            .where(eq(sessions.id, sessionId));

          // Clean up in-memory state
          this.removeActiveSession(sessionId);

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

          // Broadcast disconnection event
          await eventBus.publishToStream(STREAMS.SESSIONS, 'session:status', {
            sessionId,
            orgId,
            status: terminalStatus,
          });
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

            // Deduplicate reconnection schedule
            if (this.pendingReconnects.has(sessionId)) {
              logger.info('Reconnection already scheduled for session', { sessionId });
              return;
            }

            // Schedule reconnection after backoff delay
            const timeout = setTimeout(async () => {
              try {
                this.pendingReconnects.delete(sessionId);
                // Remove stale socket before reinitializing
                this.removeActiveSession(sessionId);
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
            this.pendingReconnects.set(sessionId, timeout);
          } else {
            // Exhausted retries
            await this.updateSessionStatus(sessionId, 'disconnected');
            this.removeActiveSession(sessionId);

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

      // Check for decryption failure (StubType.CIPHERTEXT) and reset per-contact session
      for (const msg of messages) {
        const isDecryptionFailure =
          msg.messageStubType === 2 ||
          (msg.messageStubType as any) === 'CIPHERTEXT';
        
        if (isDecryptionFailure && msg.key.remoteJid) {
          const remoteJid = msg.key.remoteJid;
          logger.warn('Decryption failure detected, resetting Signal session for contact', {
            sessionId,
            remoteJid,
            msgId: msg.key.id
          });
          
          try {
            await socket.signalRepository.deleteSession([remoteJid]);
            logger.info('Successfully cleared Signal session for contact', { sessionId, remoteJid });
          } catch (err) {
            logger.error('Failed to clear Signal session for contact', {
              sessionId,
              remoteJid,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }
      }

      // Publish to message-inbound BullMQ queue
      await eventBus.publishMessageInbound(sessionId, orgId, messages, type).catch((err) => {
        logger.error('Failed to publish inbound messages', { sessionId, error: err.message });
      });
    });

    // ── History Sync ──────────────────────────────────────────────────

    socket.ev.on('messaging-history.set', async (data) => {
      const { chats, contacts, messages, isLatest } = data;

      const active = this.getSession(sessionId);
      const isInitial = active?.isInitialSyncConnection ?? false;

      // 1. Skip if already completed in DB AND this connection is not the initial sync connection
      try {
        const [sessionRecord] = await db
          .select({ metadata: sessions.metadata })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        const metadata = (sessionRecord?.metadata || {}) as Record<string, any>;
        if (metadata.historySyncCompleted && !isInitial) {
          logger.info('History sync event skipped because history sync is already marked complete and this is not the initial sync connection', { sessionId });
          return;
        }
      } catch (err) {
        logger.error('Error checking historySyncCompleted in event listener', { sessionId, error: (err as Error).message });
      }

      // 2. Redis circuit breaker: max 100 history sync events per 10 minutes per session
      if (!isInitial) {
        try {
          const rateLimitKey = `sync:limit:${sessionId}`;
          const syncCount = await redis.incr(rateLimitKey);
          if (syncCount === 1) {
            await redis.expire(rateLimitKey, 600); // 10 minutes
          }
          const limit = 100;
          if (syncCount > limit) {
            logger.warn('History sync rate-limit exceeded (circuit breaker triggered)', { sessionId, syncCount, limit });
            return;
          }
        } catch (err) {
          logger.error('Error applying history sync rate limit', { sessionId, error: (err as Error).message });
        }
      }

      logger.info('History sync received', {
        sessionId,
        chats: chats.length,
        contacts: contacts.length,
        messages: messages.length,
        isLatest,
      });

      // 3. Mark progress as syncing and reset the inactivity timer
      try {
        const progressKey = `sync:progress:${sessionId}`;
        const progressData = await redis.hgetall(progressKey);
        const processed = parseInt(progressData.syncProcessedMessages || '0');
        const total = parseInt(progressData.syncTotalMessages || '0');
        await updateSyncProgress(sessionId, 'syncing', processed, total);
        this.resetSyncTimeout(sessionId, orgId);
      } catch (err) {
        logger.error('Error updating progress in history sync event listener', { sessionId, error: (err as Error).message });
      }

      // Publish to history sync BullMQ queue
      await eventBus.publishHistorySync(sessionId, orgId, data).catch((err) => {
        logger.error('Failed to publish history sync', { sessionId, error: err.message });
      });
    });

    // ── Chat Events ───────────────────────────────────────────────────

    socket.ev.on('chats.upsert', async (chats) => {
      logger.debug('Chats upsert', {
        sessionId,
        count: chats.length,
      });

      for (const chat of chats) {
        if (chat.unreadCount !== undefined) {
          logger.info('[DEBUG UNREAD] Baileys chats.upsert event contains unreadCount', {
            sessionId,
            waChatId: chat.id,
            unreadCount: chat.unreadCount,
          });
        }
      }

      // Publish to chat sync BullMQ queue
      await eventBus.publishChatSync(sessionId, orgId, chats, 'upsert').catch((err) => {
        logger.error('Failed to publish chat upsert', { sessionId, error: err.message });
      });
    });

    socket.ev.on('chats.update', async (updates) => {
      logger.debug('Chats update', {
        sessionId,
        count: updates.length,
      });

      for (const update of updates) {
        if (update.unreadCount !== undefined) {
          logger.info('[DEBUG UNREAD] Baileys chats.update event contains unreadCount', {
            sessionId,
            waChatId: update.id,
            unreadCount: update.unreadCount,
          });
        }
      }

      // Publish to chat sync BullMQ queue
      await eventBus.publishChatSync(sessionId, orgId, updates, 'update').catch((err) => {
        logger.error('Failed to publish chat update', { sessionId, error: err.message });
      });
    });

    socket.ev.on('chats.delete', async (deletions) => {
      logger.debug('Chats delete', {
        sessionId,
        count: deletions.length,
      });

      // Publish to chat sync BullMQ queue
      await eventBus.publishChatSync(sessionId, orgId, deletions, 'delete').catch((err) => {
        logger.error('Failed to publish chat delete', { sessionId, error: err.message });
      });
    });

    // ── Contact Events ────────────────────────────────────────────────

    socket.ev.on('contacts.upsert', async (contacts) => {
      logger.debug('Contacts upsert', {
        sessionId,
        count: contacts.length,
      });

      // Publish to contact sync BullMQ queue
      await eventBus.publishContactSync(sessionId, orgId, contacts).catch((err) => {
        logger.error('Failed to publish contact upsert', { sessionId, error: err.message });
      });
    });

    socket.ev.on('contacts.update', async (updates) => {
      logger.debug('Contacts update', {
        sessionId,
        count: updates.length,
      });

      // Publish to contact sync BullMQ queue
      await eventBus.publishContactSync(sessionId, orgId, updates).catch((err) => {
        logger.error('Failed to publish contact update', { sessionId, error: err.message });
      });
    });

    /* BUG 1: Listen to dynamic LID-to-Phone JID mappings as they are discovered */
    socket.ev.on('lid-mapping.update', async (mapping) => {
      const { lid, pn } = mapping;
      logger.debug('LID mapping update event received', { sessionId, lid, pn });
      if (lid && pn) {
        try {
          await saveLidMapping(sessionId, lid, pn);
        } catch (err) {
          logger.error('Failed to save dynamic LID mapping in event listener', { sessionId, error: (err as Error).message });
        }
      }
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

    socket.ev.on('messages.update', async (updates) => {
      logger.info('[DEBUG RECEIPT] Baileys messages.update (status update) event received', {
        sessionId,
        updatesCount: updates.length,
        updatesDetails: updates.map(u => ({
          msgId: u.key.id,
          remoteJid: u.key.remoteJid,
          status: u.update.status
        }))
      });

      for (const update of updates) {
        if (update.update.status !== undefined && update.update.status !== null) {
          const statusMap: Record<number, string> = {
            0: 'failed',
            1: 'pending',
            2: 'sent',
            3: 'delivered',
            4: 'read',
            5: 'read',
          };
          const status = statusMap[update.update.status] || 'sent';
          const messageId = update.key.id;
          const remoteJid = update.key.remoteJid;
          if (messageId && remoteJid) {
            await this.processMessageReceiptUpdate(sessionId, orgId, remoteJid, messageId, status);
          }
        }
      }
    });

    socket.ev.on('message-receipt.update', async (receipts) => {
      logger.info('[DEBUG RECEIPT] Baileys message-receipt.update event received', {
        sessionId,
        receiptsCount: receipts.length,
        receiptsDetails: receipts.map(r => ({
          msgId: r.key.id,
          remoteJid: r.key.remoteJid,
          receipt: r.receipt
        }))
      });

      for (const receipt of receipts) {
        const remoteJid = receipt.key.remoteJid;
        const messageId = receipt.key.id;
        if (remoteJid && messageId && receipt.receipt) {
          let status: string | undefined = undefined;
          if (receipt.receipt.readTimestamp || receipt.receipt.playedTimestamp) {
            status = 'read';
          } else if (receipt.receipt.receiptTimestamp) {
            status = 'delivered';
          }

          if (status) {
            await this.processMessageReceiptUpdate(sessionId, orgId, remoteJid, messageId, status);
          }
        }
      }
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
    // Add guard to prevent invalid/null UUID check crashes in PostgreSQL
    if (!isValidUuid(sessionId)) {
      logger.warn('updateSessionStatus skipped for invalid sessionId', { sessionId, stack: new Error().stack });
      return;
    }
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

  /**
   * Clear initial history sync inactivity timeout.
   */
  clearSyncTimeout(sessionId: string): void {
    // Add guard to prevent invalid/null UUID checks
    if (!isValidUuid(sessionId)) {
      logger.warn('clearSyncTimeout skipped for invalid sessionId', { sessionId, stack: new Error().stack });
      return;
    }
    const timeout = this.syncTimeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.syncTimeouts.delete(sessionId);
      logger.info('Cleared initial sync timeout', { sessionId });
    }
  }

  /**
   * Reset or set initial history sync inactivity timeout (5 minutes).
   */
  resetSyncTimeout(sessionId: string, orgId: string): void {
    // Add guard to prevent invalid/null UUID checks
    if (!isValidUuid(sessionId) || !isValidUuid(orgId)) {
      logger.warn('resetSyncTimeout skipped for invalid sessionId or orgId', { sessionId, orgId, stack: new Error().stack });
      return;
    }
    this.clearSyncTimeout(sessionId);

    const timeout = setTimeout(async () => {
      try {
        // Query database to see if sync has been marked complete by the worker in the background
        const [sessionRecord] = await db
          .select({ metadata: sessions.metadata })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        const metadata = (sessionRecord?.metadata || {}) as Record<string, any>;
        if (metadata.historySyncCompleted) {
          logger.info('Initial history sync timeout triggered but ignored because history sync completed successfully in database', { sessionId });
          this.syncTimeouts.delete(sessionId);
          return;
        }

        // Fallback: Check if all expected messages were processed in DB or Redis progress trackers
        const dbTotal = parseInt(metadata.syncTotalMessages || '0');
        const dbProcessed = parseInt(metadata.syncProcessedMessages || '0');

        const totalKey = `sync:chunks:total:${sessionId}`;
        const processedKey = `sync:chunks:processed:${sessionId}`;

        const totals = await redis.hvals(totalKey);
        const processeds = await redis.hvals(processedKey);

        const redisTotal = totals.reduce((sum, val) => sum + (parseInt(val) || 0), 0);
        const redisProcessed = processeds.reduce((sum, val) => sum + (parseInt(val) || 0), 0);

        const finalProcessed = Math.max(dbProcessed, redisProcessed);
        const finalTotal = Math.max(dbTotal, redisTotal);

        if (finalProcessed >= finalTotal) {
          logger.info('Initial history sync inactivity timeout triggered, but marking completed because all expected messages were processed', { 
            sessionId, 
            processed: finalProcessed, 
            total: finalTotal 
          });
          await updateSyncProgress(sessionId, 'completed', finalTotal, finalTotal);
          this.syncTimeouts.delete(sessionId);
          return;
        }

        logger.error('Initial history sync timed out (no progress for 2 minutes)', { sessionId });
        await updateSyncProgress(sessionId, 'failed', 0, 0, 'Sync timed out due to inactivity');
      } catch (err) {
        logger.error('Failed to handle sync timeout', { sessionId, error: (err as Error).message });
      }
    }, 2 * 60 * 1000); // 2 minutes

    this.syncTimeouts.set(sessionId, timeout);
    logger.info('Set/reset initial sync timeout (2 minutes)', { sessionId });
  }

  private setupPresenceKeepAlive(active: ActiveSession): void {
    // Clear any existing interval
    if (active.presenceInterval) {
      clearInterval(active.presenceInterval);
    }

    // Call once after a 5-second delay to let connection settle
    setTimeout(() => {
      active.socket.sendPresenceUpdate('unavailable').catch((err) => {
        logger.warn('Failed to send unavailable presence update on connect', { sessionId: active.sessionId, error: err.message });
      });
    }, 5000);

    // Call periodically every 5 minutes (300000 ms)
    active.presenceInterval = setInterval(() => {
      active.socket.sendPresenceUpdate('unavailable').catch((err) => {
        logger.warn('Failed to send unavailable presence update in keep-alive', { sessionId: active.sessionId, error: err.message });
      });
    }, 300000);
  }

  private clearPresenceKeepAlive(active: ActiveSession): void {
    if (active.presenceInterval) {
      clearInterval(active.presenceInterval);
      active.presenceInterval = undefined;
    }
  }

  private removeActiveSession(sessionId: string): void {
    const active = this.activeSessions.get(sessionId);
    if (active) {
      this.clearPresenceKeepAlive(active);
      this.activeSessions.delete(sessionId);
    }
  }

  /**
   * Process receipt/status updates for messages (delivery/read checks).
   * Updates all preceding outbound messages in the chat to match status.
   */
  private async processMessageReceiptUpdate(
    sessionId: string,
    orgId: string,
    remoteJid: string,
    messageId: string,
    status: string,
  ): Promise<void> {
    try {
      const resolvedJid = await resolveLidJid(sessionId, remoteJid);
      const normalizedRemoteJid = normalizeJid(resolvedJid);

      // Find the reference message by waMessageId and sessionId
      const [msgRecord] = await db
        .select({
          id: messages.id,
          chatId: messages.chatId,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, sessionId),
            eq(messages.waMessageId, messageId)
          )
        )
        .limit(1);

      if (!msgRecord) {
        logger.debug('Reference message not found for receipt update', { sessionId, messageId, status });
        return;
      }

      let statusCondition;
      if (status === 'read' || status === 'delivered') {
        if (status === 'read') {
          statusCondition = ne(messages.status, 'read');
        } else {
          statusCondition = inArray(messages.status, ['pending', 'sent']);
        }

        // Update all prior outbound messages in that chat up to the reference message's createdAt
        await db
          .update(messages)
          .set({
            status,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(messages.chatId, msgRecord.chatId),
              eq(messages.fromMe, true),
              lte(messages.createdAt, msgRecord.createdAt),
              statusCondition
            )
          );
      } else {
        // Only update the single referenced message, preventing status downgrades (e.g., read/delivered -> sent)
        if (status === 'sent') {
          statusCondition = inArray(messages.status, ['pending']);
        } else if (status === 'pending') {
          statusCondition = eq(messages.status, 'pending');
        } else {
          statusCondition = ne(messages.status, status);
        }

        await db
          .update(messages)
          .set({
            status,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(messages.id, msgRecord.id),
              statusCondition
            )
          );
      }

      logger.debug('Receipt status updated in database', {
        sessionId,
        chatId: msgRecord.chatId,
        messageId,
        status,
      });

      // Broadcast status update to frontend
      await eventBus.publishToStream(STREAMS.MESSAGES, 'message:status_update', {
        sessionId,
        orgId,
        chatId: msgRecord.chatId,
        status,
        waMessageId: messageId,
      });

    } catch (error) {
      logger.error('Failed to process message receipt update', {
        sessionId,
        messageId,
        status,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

/**
 * Update the initial history sync progress for a session.
 * Updates Redis, PostgreSQL sessions.metadata, and broadcasts updates via WebSocket (Redis Stream).
 */
export async function updateSyncProgress(
  sessionId: string,
  syncStatus: 'pending' | 'syncing' | 'completed' | 'failed',
  syncProcessedMessages: number,
  syncTotalMessages: number,
  errorReason?: string,
): Promise<void> {
  // Add guard to prevent invalid/null UUID query crashes in PostgreSQL
  if (!isValidUuid(sessionId)) {
    logger.warn('updateSyncProgress skipped for invalid sessionId', { sessionId, stack: new Error().stack });
    return;
  }
  const progressKey = `sync:progress:${sessionId}`;
  
  // Get current started timestamp from Redis, or set to now
  let syncStartedAt = await redis.hget(progressKey, 'syncStartedAt');
  if (!syncStartedAt) {
    syncStartedAt = new Date().toISOString();
  }

  // Save progress to Redis
  await redis.hset(progressKey, {
    syncStatus,
    syncTotalMessages: syncTotalMessages.toString(),
    syncProcessedMessages: syncProcessedMessages.toString(),
    syncStartedAt,
  });

  // Retrieve orgId
  const active = sessionManager.getSession(sessionId);
  let orgId = active?.orgId;
  if (!orgId) {
    const [sessionRecord] = await db
      .select({ orgId: sessions.orgId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    orgId = sessionRecord?.orgId;
  }

  // Update Postgres sessions.metadata atomically using JSONB merge to prevent concurrent race conditions (lost updates)
  if (orgId) {
    try {
      const basePayload = {
        syncStatus,
        syncStartedAt,
        ...(syncStatus === 'completed' && { historySyncCompleted: true, historySyncCompletedAt: new Date().toISOString() }),
        ...(errorReason && { syncErrorReason: errorReason }),
      };

      await db
        .update(sessions)
        .set({
          metadata: sql`
            COALESCE(sessions.metadata, '{}'::jsonb) || 
            ${JSON.stringify(basePayload)}::jsonb || 
            jsonb_build_object(
              'syncTotalMessages', GREATEST(COALESCE((sessions.metadata->>'syncTotalMessages')::int, 0), ${syncTotalMessages}::int),
              'syncProcessedMessages', GREATEST(COALESCE((sessions.metadata->>'syncProcessedMessages')::int, 0), ${syncProcessedMessages}::int)
            )
          `,
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, sessionId));
    } catch (err) {
      logger.error('Failed to update session metadata atomically in updateSyncProgress', { sessionId, error: (err as Error).message });
    }
  }

  // Cleanup Redis progress and chunk keys on completion or failure
  if (syncStatus === 'completed' || syncStatus === 'failed') {
    try {
      await redis.del(progressKey);
      await redis.del(`sync:chunks:total:${sessionId}`);
      await redis.del(`sync:chunks:processed:${sessionId}`);
      logger.info('Cleaned up Redis history sync keys', { sessionId, syncStatus });
    } catch (err) {
      logger.warn('Failed to cleanup Redis sync keys', { sessionId, error: (err as Error).message });
    }
  }

  // Broadcast over WebSocket (Redis Stream)
  if (orgId) {
    const payload = {
      sessionId,
      orgId,
      syncStatus,
      syncProcessedMessages,
      syncTotalMessages,
      ...(errorReason && { reason: errorReason }),
    };

    if (syncStatus === 'completed') {
      await eventBus.publishToStream(STREAMS.SESSIONS, 'sync:completed', payload);
    } else if (syncStatus === 'failed') {
      await eventBus.publishToStream(STREAMS.SESSIONS, 'sync:failed', payload);
    } else {
      await eventBus.publishToStream(STREAMS.SESSIONS, 'sync:progress', payload);
    }
  }
}

/** Singleton SessionManager instance for application-wide use */
export const sessionManager = new SessionManager();

