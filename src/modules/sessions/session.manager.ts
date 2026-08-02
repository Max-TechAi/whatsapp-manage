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
  fetchLatestWaWebVersion,
  BufferJSON,
} from '@whiskeysockets/baileys';
import type { WASocket, BaileysEventMap, WAMessage, WAVersion } from '@whiskeysockets/baileys';
import * as QRCode from 'qrcode';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { eq, and, or, inArray, sql, lte, ne, desc } from 'drizzle-orm';
import { Boom } from '@hapi/boom';
import { Worker } from 'bullmq';

/** Serialize Baileys payloads for diagnostic logs (Buffers → hex preview). */
function serializeDebugJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) => {
      if (v instanceof Buffer || v instanceof Uint8Array) {
        const buf = Buffer.from(v);
        const hex = buf.subarray(0, 32).toString('hex');
        return `<Buffer len=${buf.length} hex=${hex}${buf.length > 32 ? '…' : ''}>`;
      }
      return v;
    });
  } catch (err) {
    return `[serialize error: ${(err as Error).message}]`;
  }
}

function hasCallRelatedUpsertFields(msg: WAMessage): boolean {
  return !!(
    msg.messageStubType != null
    || msg.message?.callLogMesssage
    || msg.message?.call
  );
}

import { db } from '../../config/database.js';
import { env } from '../../config/env.js';
import { sessions, sessionKeys, messages, chats } from '../../db/schema.js';
import { redis, workerRedis } from '../../config/redis.js';
import { logger } from '../../observability/logger.js';
import { usePostgresAuthState } from './session.auth-state.js';
import { decryptJSON } from '../../security/encryption.js';
import { SessionEventType, normalizeJid } from './session.events.js';
import type { ActiveSession, SessionStatus, SessionDestroyResult, WhatsAppSession } from './session.types.js';
import { saveLidMapping, resolveLidJid } from './lid-mapping.js';
import { eventBus, STREAMS } from '../../events/event-bus.js';

/** Per-chat mark-read receipt cooldown (seconds) — gates Baileys readMessages only */
const MARK_READ_COOLDOWN_SEC = 10;
/** Randomized delay before readMessages (ms) */
const MARK_READ_DELAY_MIN_MS = 500;
const MARK_READ_DELAY_MAX_MS = 1000;

/** Maximum number of reconnection attempts before giving up */
const MAX_RETRIES = 10;

/** Maximum reconnection delay in milliseconds (5 minutes) */
const MAX_RETRY_DELAY_MS = 300_000;

/** Minimum first reconnect delay (ms) — avoids aggressive 1s retry */
const MIN_RECONNECT_DELAY_MS = 3000;

/**
 * Escalating backoff for never-paired sessions hitting 428 (connectionClosed).
 * Index 0 = 1st 428, … index 3 = 4th. A 5th 428 terminates with connection_failed.
 */
const NEVER_PAIRED_428_DELAYS_MS = [
  30_000,
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
] as const;

const NEVER_PAIRED_428_MAX_ATTEMPTS = NEVER_PAIRED_428_DELAYS_MS.length + 1;

const NEVER_PAIRED_428_TERMINAL_MESSAGE =
  'WhatsApp may be temporarily restricting new pairings. Wait 30+ minutes before trying again.';

/** Consecutive saveCreds failures before terminating session */
const SAVE_CREDS_MAX_FAILURES = 3;

/**
 * Resolve the WhatsApp Web protocol version for makeWASocket.
 *
 * Priority:
 * 1. WA_VERSION_OVERRIDE env (manual escape hatch)
 * 2. fetchLatestWaWebVersion() — live client_revision from web.whatsapp.com/sw.js
 * 3. fetchLatestBaileysVersion() — Baileys Defaults (can report isLatest:true while stale)
 *
 * See WhiskeySockets/Baileys#2679: stale [2,3000,1035194821] allows QR but blocks pairing.
 */
async function resolveWhatsAppVersion(): Promise<{ version: WAVersion; source: string }> {
  const override = env.WA_VERSION_OVERRIDE;
  if (override) {
    const parts = override.split(',').map((part) => parseInt(part.trim(), 10));
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      const version = parts as unknown as WAVersion;
      return { version, source: 'WA_VERSION_OVERRIDE' };
    }
    logger.warn('Invalid WA_VERSION_OVERRIDE ignored (expected "major,minor,revision")', {
      override,
    });
  }

  try {
    const waWeb = await fetchLatestWaWebVersion();
    if (waWeb.isLatest && Array.isArray(waWeb.version) && waWeb.version.length === 3) {
      return { version: waWeb.version, source: 'fetchLatestWaWebVersion' };
    }
    const waWebError = (waWeb as { error?: unknown }).error;
    logger.warn('fetchLatestWaWebVersion did not return a latest version — falling back', {
      isLatest: waWeb.isLatest,
      version: waWeb.version,
      error: waWebError instanceof Error
        ? waWebError.message
        : typeof waWebError === 'object' && waWebError && 'message' in waWebError
          ? String((waWebError as { message: unknown }).message)
          : undefined,
    });
  } catch (err) {
    logger.warn('fetchLatestWaWebVersion failed — falling back to fetchLatestBaileysVersion', {
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }

  const baileys = await fetchLatestBaileysVersion();
  return { version: baileys.version, source: 'fetchLatestBaileysVersion' };
}

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
  /** Unique identifier for this session-runner process/replica */
  readonly replicaId = uuidv4();

  /** Map of sessionId → lock renewal interval */
  private lockRenewals: Map<string, NodeJS.Timeout> = new Map();

  /** Map of sessionId → consecutive lock renewal failures */
  private lockRenewalFailures: Map<string, number> = new Map();

  /** Map of sessionId → last successful lock renewal timestamp */
  private lastSuccessfulRenewal: Map<string, number> = new Map();

  /** Map of sessionId → watchdog interval */
  private watchdogIntervals: Map<string, NodeJS.Timeout> = new Map();

  /** Map of sessionId → array of active BullMQ Worker instances */
  private dynamicWorkers: Map<string, Worker[]> = new Map();

  /** Map of sessionId → active Baileys socket and metadata */
  private activeSessions: Map<string, ActiveSession> = new Map();

  /** Set of sessionIds currently initializing to prevent concurrent duplicate sockets */
  private initializingSessions: Set<string> = new Set();

  /** Map of sessionId → scheduled reconnect Timeout */
  private pendingReconnects: Map<string, NodeJS.Timeout> = new Map();

  /** Map of sessionId → consecutive reconnect attempts (persists across socket instances) */
  private sessionRetryCounts: Map<string, number> = new Map();

  /** Map of sessionId → consecutive 428s while never-paired (persists across socket instances) */
  private neverPaired428Counts: Map<string, number> = new Map();

  /** Map of sessionId → consecutive saveCreds failures */
  private saveCredsFailures: Map<string, number> = new Map();

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
    if (process.env.RUN_SESSION_RUNNER === 'true') {
      await this.initializeSocket(sessionId, orgId);
    } else {
      const { eventBus } = await import('../../events/event-bus.js');
      await eventBus.publishSessionOrchestration(sessionId, orgId, 'start');
    }

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

    // Decoupled: only run Baileys sockets on runner replicas
    if (process.env.RUN_SESSION_RUNNER !== 'true') {
      logger.info('initializeSocket called on API container, skipping local socket initialization', { sessionId });
      return;
    }

    if (this.initializingSessions.has(sessionId)) {
      logger.warn('Socket initialization already in progress for session', { sessionId });
      return;
    }
    this.initializingSessions.add(sessionId);

    try {
      // 1. Try to acquire/renew the Redis lock
      const lockKey = `session:${sessionId}:owner`;
      const currentOwner = await redis.get(lockKey);
      if (currentOwner && currentOwner !== this.replicaId) {
        logger.warn('Session is owned by another replica, skipping initialization', { sessionId, currentOwner });
        return;
      }
      
      let acquired: string | null = null;
      if (currentOwner === this.replicaId) {
        acquired = await redis.set(lockKey, this.replicaId, 'EX', 10, 'XX');
      } else if (!currentOwner) {
        acquired = await redis.set(lockKey, this.replicaId, 'EX', 10, 'NX');
      }
      if (!acquired) {
        logger.warn('Failed to acquire lock for session, skipping initialization', { sessionId });
        return;
      }

      // 2. Fencing Delay (Lease Safety Check)
      logger.info('Acquired session lock. Waiting 1.5s fencing delay...', { sessionId });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const postDelayOwner = await redis.get(lockKey);
      if (postDelayOwner !== this.replicaId) {
        logger.error('Lost lock during fencing delay, aborting socket initialization', { sessionId });
        return;
      }

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
          existingSession.socket.ev.removeAllListeners('call');
          existingSession.socket.ev.removeAllListeners('messages.update');
          existingSession.socket.ev.removeAllListeners('message-receipt.update');
          existingSession.socket.ev.removeAllListeners('messaging-history.set');
          existingSession.socket.end(undefined);
        } catch (err) {
          logger.warn('Error ending existing socket during reinitialization', { sessionId, error: (err as Error).message });
        }
        this.removeActiveSession(sessionId);
      }

      // Partial creds from a failed pairing block QR emission — wipe before loading auth state
      await this.clearPartialAuthForNeverPairedSession(sessionId);

      // Load encrypted auth state from database
      const { state, saveCreds } = await usePostgresAuthState(sessionId);

      // Prefer live WA Web client_revision over Baileys Defaults (can be stale — #2679)
      const { version, source: versionSource } = await resolveWhatsAppVersion();

      // Read historySyncCompleted from session metadata to prevent Baileys from requesting history again
      const [sessionRecord] = await db
        .select({ metadata: sessions.metadata })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      const metadata = (sessionRecord?.metadata || {}) as Record<string, any>;
      const historySyncCompleted = !!metadata.historySyncCompleted;

      const versionSourceLabel =
        versionSource === 'WA_VERSION_OVERRIDE' ? versionSource : `${versionSource}()`;
      logger.info(`Using WA version from ${versionSourceLabel}: [${version.join(',')}]`, {
        sessionId,
        versionSource,
        baileysVersion: version.join('.'),
        historySyncCompleted,
      });

      logger.info('Initializing Baileys socket', {
        sessionId,
        baileysVersion: version.join('.'),
        versionSource,
        historySyncCompleted,
      });

      // Create the Baileys socket with production-optimized settings
      const socket = makeWASocket({
        auth: state,
        version,
        // WEB_BROWSER sub-platform (not DESKTOP) — fixes 428-before-QR pairing failure
        // (Baileys #2677). Trade-off: automatic history-sync backfill may 403; use the
        // existing per-chat "Sync older messages from phone" fallback when needed.
        browser: Browsers.ubuntu('Chrome'),
        logger: pino({ level: 'silent' }) as any,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: true,
        connectTimeoutMs: 60_000,
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

      // Start lock renewal heartbeat and dynamic workers
      this.startLockRenewal(sessionId);
      this.startDynamicWorkers(sessionId, orgId);

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
   * @param options.unlinkFromWhatsApp - When true (DELETE flow only), call Baileys logout()
   *   to send remove-companion-device to WhatsApp before closing the socket.
   */
  async destroySession(
    sessionId: string,
    options: { unlinkFromWhatsApp?: boolean } = {},
  ): Promise<SessionDestroyResult> {
    const destroyResult: SessionDestroyResult = {
      whatsAppUnlinkAttempted: false,
      whatsAppUnlinkSucceeded: true,
    };

    // Add guard to prevent invalid/null UUID check crashes in PostgreSQL
    if (!isValidUuid(sessionId)) {
      logger.warn('destroySession skipped for invalid sessionId', { sessionId, stack: new Error().stack });
      return destroyResult;
    }
    logger.info('Destroying session', { sessionId, unlinkFromWhatsApp: !!options.unlinkFromWhatsApp });

    // Clear reconnection and sync timeouts
    const reconnectTimeout = this.pendingReconnects.get(sessionId);
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      this.pendingReconnects.delete(sessionId);
    }
    this.clearSyncTimeout(sessionId);

    this.clearSessionRetryCount(sessionId);
    this.clearNeverPaired428Count(sessionId);

    // Unlink from WhatsApp / close the socket if active
    const active = this.activeSessions.get(sessionId);
    if (active?.socket) {
      // Only logout() when the session was previously paired — never-paired
      // sessions have no linked device on the phone, and logout() adds WA traffic.
      let shouldLogout = false;
      if (options.unlinkFromWhatsApp) {
        const neverPaired = await this.isNeverPairedSession(sessionId);
        if (neverPaired) {
          logger.info('Skipping logout() for never-paired session on DELETE', { sessionId });
        } else {
          shouldLogout = true;
          destroyResult.whatsAppUnlinkAttempted = true;
          destroyResult.whatsAppUnlinkSucceeded = await this.unlinkSessionFromWhatsApp(
            sessionId,
            active.socket,
          );
        }
      }

      try {
        this.detachSocketListeners(active.socket);
        if (!shouldLogout || !destroyResult.whatsAppUnlinkSucceeded) {
          active.socket.end(undefined);
        }
      } catch (error) {
        logger.warn('Error closing socket during destroy', {
          sessionId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      this.clearPresenceKeepAlive(active);
      this.activeSessions.delete(sessionId);
    }

    // Update DB status
    await this.updateSessionStatus(sessionId, 'disconnected');

    // Clean up lock and workers
    this.clearLockRenewal(sessionId);
    this.stopDynamicWorkers(sessionId);
    await this.releaseLock(sessionId);

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

    return destroyResult;
  }

  /**
   * Send WhatsApp remove-companion-device via Baileys logout().
   * Distinct from socket.end() — notifies the phone to drop this linked device.
   */
  private async unlinkSessionFromWhatsApp(sessionId: string, socket: WASocket): Promise<boolean> {
    const LOGOUT_TIMEOUT_MS = 10_000;
    try {
      await Promise.race([
        socket.logout(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('WhatsApp logout timed out')), LOGOUT_TIMEOUT_MS);
        }),
      ]);
      logger.info('WhatsApp companion device unlinked via logout()', { sessionId });
      return true;
    } catch (error) {
      logger.warn('WhatsApp logout() failed during session destroy', {
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  private detachSocketListeners(socket: WASocket): void {
    socket.ev.removeAllListeners('connection.update');
    socket.ev.removeAllListeners('creds.update');
    socket.ev.removeAllListeners('messages.upsert');
    socket.ev.removeAllListeners('call');
    socket.ev.removeAllListeners('messages.update');
    socket.ev.removeAllListeners('message-receipt.update');
    socket.ev.removeAllListeners('messaging-history.set');
  }

  /**
   * Restore all previously active sessions on server startup.
   *
   * Queries sessions with 'connected' or 'disconnected' status
   * and reinitializes their sockets. This enables seamless restarts.
   */
  async restoreAllSessions(): Promise<void> {
    if (process.env.RUN_SESSION_RUNNER !== 'true') {
      logger.info('restoreAllSessions called on API container, skipping restoration');
      return;
    }
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
          active.lastRetry = null;
          this.setupPresenceKeepAlive(active);
        }
        this.clearSessionRetryCount(sessionId);
        this.clearNeverPaired428Count(sessionId);

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
          this.clearSessionRetryCount(sessionId);
          this.clearNeverPaired428Count(sessionId);

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
          const isRestartRequired = statusCode === DisconnectReason.restartRequired;
          const isConnectionClosed = statusCode === DisconnectReason.connectionClosed;
          const neverPaired = await this.isNeverPairedSession(sessionId);

          // Never-paired + 428: escalating backoff (minutes), terminate on 5th attempt.
          // Do not use this curve for 515 restartRequired or already-paired reconnects.
          if (neverPaired && !isRestartRequired && isConnectionClosed) {
            const neverPaired428Count = this.incrementNeverPaired428Count(sessionId);
            await this.clearPartialAuthForNeverPairedSession(sessionId);

            if (neverPaired428Count >= NEVER_PAIRED_428_MAX_ATTEMPTS) {
              await this.terminateSessionDueToMaxRetries(
                sessionId,
                orgId,
                statusCode,
                neverPaired428Count,
                { message: NEVER_PAIRED_428_TERMINAL_MESSAGE },
              );
              return;
            }

            const delay = NEVER_PAIRED_428_DELAYS_MS[neverPaired428Count - 1] ?? 15 * 60_000;
            const active = this.activeSessions.get(sessionId);
            if (active) {
              active.lastRetry = new Date();
            }

            await this.updateSessionStatus(sessionId, 'disconnected');

            logger.warn('WhatsApp connection closed — scheduling reconnection', {
              sessionId,
              statusCode,
              reason: (lastDisconnect?.error as Boom)?.message,
              retryCount: neverPaired428Count,
              neverPaired428Count,
              delayMs: delay,
              neverPaired: true,
            });

            if (this.pendingReconnects.has(sessionId)) {
              logger.info('Reconnection already scheduled for session', { sessionId });
              return;
            }

            const timeout = setTimeout(async () => {
              try {
                this.pendingReconnects.delete(sessionId);
                const activeSocket = this.activeSessions.get(sessionId);
                if (activeSocket) {
                  try {
                    activeSocket.socket.ev.removeAllListeners('connection.update');
                    activeSocket.socket.ev.removeAllListeners('creds.update');
                    activeSocket.socket.ev.removeAllListeners('messages.upsert');
                    activeSocket.socket.ev.removeAllListeners('call');
                    activeSocket.socket.ev.removeAllListeners('messages.update');
                    activeSocket.socket.ev.removeAllListeners('message-receipt.update');
                    activeSocket.socket.ev.removeAllListeners('messaging-history.set');
                    activeSocket.socket.end(undefined);
                  } catch (err) {
                    logger.warn('Error closing stale socket during reconnect', {
                      sessionId,
                      error: (err as Error).message,
                    });
                  }
                  this.activeSessions.delete(sessionId);
                }
                await this.initializeSocket(sessionId, orgId);
              } catch (error) {
                logger.error('Reconnection failed', {
                  sessionId,
                  retryCount: neverPaired428Count,
                  error: error instanceof Error ? error.message : 'Unknown error',
                });
              }
            }, delay);

            this.pendingReconnects.set(sessionId, timeout);
            return;
          }

          const retryCount = isRestartRequired
            ? this.getSessionRetryCount(sessionId)
            : this.incrementSessionRetryCount(sessionId);

          if (!isRestartRequired && retryCount > MAX_RETRIES) {
            await this.terminateSessionDueToMaxRetries(sessionId, orgId, statusCode, retryCount);
            return;
          }

          const delay = isRestartRequired ? 0 : this.computeReconnectDelayMs(retryCount);

          const active = this.activeSessions.get(sessionId);
          if (active) {
            active.lastRetry = new Date();
          }

          await this.updateSessionStatus(
            sessionId,
            isRestartRequired ? 'connecting' : 'disconnected',
          );

          logger.warn('WhatsApp connection closed — scheduling reconnection', {
            sessionId,
            statusCode,
            reason: (lastDisconnect?.error as Boom)?.message,
            retryCount,
            delayMs: delay,
            neverPaired,
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

              // End the old socket and remove its event listeners to prevent any background reconnects/leaks,
              // but DO NOT clear lock renewal or watchdog yet, as they need to remain active in case initialization hangs.
              const active = this.activeSessions.get(sessionId);
              if (active) {
                try {
                  active.socket.ev.removeAllListeners('connection.update');
                  active.socket.ev.removeAllListeners('creds.update');
                  active.socket.ev.removeAllListeners('messages.upsert');
                  active.socket.ev.removeAllListeners('call');
                  active.socket.ev.removeAllListeners('messages.update');
                  active.socket.ev.removeAllListeners('message-receipt.update');
                  active.socket.ev.removeAllListeners('messaging-history.set');
                  active.socket.end(undefined);
                } catch (err) {
                  logger.warn('Error closing stale socket during reconnect', { sessionId, error: (err as Error).message });
                }
                this.activeSessions.delete(sessionId);
              }

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
        }
      }
    });

    // ── Credential Updates ────────────────────────────────────────────

    socket.ev.on('creds.update', async () => {
      if (this.activeSessions.get(sessionId)?.socket !== socket) {
        return;
      }

      try {
        await saveCreds();
        this.saveCredsFailures.delete(sessionId);
      } catch (error) {
        const failures = (this.saveCredsFailures.get(sessionId) ?? 0) + 1;
        this.saveCredsFailures.set(sessionId, failures);

        logger.error('Failed to save credentials on update', {
          sessionId,
          consecutiveFailures: failures,
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        if (failures >= SAVE_CREDS_MAX_FAILURES) {
          await this.terminateSessionDueToAuthFailure(
            sessionId,
            orgId,
            `Auth credentials could not be persisted after ${failures} consecutive attempts`,
          );
        }
      }
    });

    // ── Inbound Messages ──────────────────────────────────────────────

    socket.ev.on('call', async (calls) => {
      logger.info('[DEBUG CALL] Baileys call event received', {
        sessionId,
        orgId,
        callCount: calls?.length ?? 0,
        rawPayload: serializeDebugJson(calls),
      });
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      logger.debug('Messages upsert received', {
        sessionId,
        count: messages.length,
        type,
      });

      for (const msg of messages) {
        if (hasCallRelatedUpsertFields(msg)) {
          logger.info('[DEBUG CALL] messages.upsert call-related payload (pre-queue)', {
            sessionId,
            orgId,
            upsertType: type,
            waMessageId: msg.key?.id,
            remoteJid: msg.key?.remoteJid,
            fromMe: msg.key?.fromMe,
            messageStubType: msg.messageStubType,
            messageStubParameters: msg.messageStubParameters,
            hasCallLogMesssage: !!msg.message?.callLogMesssage,
            hasMessageCall: !!msg.message?.call,
            rawMessage: serializeDebugJson(msg),
          });
        }
      }

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

      logger.info('[RAW HISTORY SYNC EVENT]', {
        sessionId,
        syncType: data.syncType,
        chatsCount: chats?.length ?? 0,
        contactsCount: contacts?.length ?? 0,
        messagesCount: messages?.length ?? 0,
        isLatest
      });

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
        const isOnDemand = data.syncType === 5; // ON_DEMAND
        if (metadata.historySyncCompleted && !isInitial && !isOnDemand) {
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
          logger.debug('[DEBUG UNREAD] Baileys chats.upsert event contains unreadCount', {
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
          logger.debug('[DEBUG UNREAD] Baileys chats.update event contains unreadCount', {
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

    /* FIX: Listen to dynamic LID-to-Phone JID mappings as they are discovered */
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

      if (!presences || jid.endsWith('@g.us')) return;

      try {
        const canonicalChatJid = normalizeJid(await resolveLidJid(sessionId, jid));

        logger.debug('[DEBUG PRESENCE] presence.update event received from Baileys', {
          sessionId,
          jid,
          canonicalChatJid,
          participantCount: Object.keys(presences).length,
          presences: Object.fromEntries(
            Object.entries(presences).map(([p, data]) => [
              p,
              {
                lastKnownPresence: data.lastKnownPresence,
                lastSeen: data.lastSeen ?? null,
              },
            ]),
          ),
        });

        const canonicalPresences: Record<string, { lastKnownPresence: string; lastSeen?: number | null }> = {};

        for (const [participantJid, presenceData] of Object.entries(presences)) {
          const canonicalParticipantJid = normalizeJid(
            await resolveLidJid(sessionId, participantJid),
          );
          canonicalPresences[canonicalParticipantJid] = presenceData;

          const value = JSON.stringify({
            lastKnownPresence: presenceData.lastKnownPresence,
            lastSeen: presenceData.lastSeen ?? null,
            updatedAt: Date.now(),
          });

          const redisKey = `presence:${sessionId}:${canonicalChatJid}:${canonicalParticipantJid}`;
          await redis.setex(redisKey, 300, value);
          await redis.setex(`presence:lookup:${sessionId}:${canonicalParticipantJid}`, 300, value);
          if (canonicalChatJid !== canonicalParticipantJid) {
            await redis.setex(`presence:lookup:${sessionId}:${canonicalChatJid}`, 300, value);
          }
        }

        let chatId: string | undefined;
        try {
          const normalizedOriginalJid = normalizeJid(jid);
          const [chatRow] = await db
            .select({ id: chats.id })
            .from(chats)
            .where(
              and(
                eq(chats.sessionId, sessionId),
                eq(chats.orgId, orgId),
                or(
                  eq(chats.waChatId, canonicalChatJid),
                  eq(chats.waChatId, normalizedOriginalJid),
                ),
              ),
            )
            .limit(1);
          chatId = chatRow?.id;
        } catch (lookupErr) {
          logger.debug('Failed to resolve chatId for presence broadcast', {
            sessionId,
            jid,
            canonicalChatJid,
            error: (lookupErr as Error).message,
          });
        }

        await eventBus.publishToStream(STREAMS.PRESENCE, 'presence:update', {
          sessionId,
          orgId,
          chatJid: canonicalChatJid,
          ...(chatId ? { chatId } : {}),
          presences: canonicalPresences,
        });
      } catch (error) {
        logger.warn('Failed to store or broadcast presence update', {
          sessionId,
          jid,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
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
   * Compute reconnect backoff with a 3s floor and ±20% jitter (ban-risk mitigation).
   */
  private computeReconnectDelayMs(retryCount: number): number {
    const baseDelay = Math.min(
      Math.pow(retryCount, 2) * 1000,
      MAX_RETRY_DELAY_MS,
    );
    const flooredDelay = Math.max(MIN_RECONNECT_DELAY_MS, baseDelay);
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.round(flooredDelay * jitter);
  }

  /**
   * Never-paired sessions can accumulate partial auth_creds/session_keys after
   * failed connects; Baileys then skips QR and retries login indefinitely.
   */
  private async isNeverPairedSession(sessionId: string): Promise<boolean> {
    const [row] = await db
      .select({
        lastConnectedAt: sessions.lastConnectedAt,
        phoneNumber: sessions.phoneNumber,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    return !row?.lastConnectedAt && !row?.phoneNumber;
  }

  private async clearPartialAuthForNeverPairedSession(sessionId: string): Promise<void> {
    const [row] = await db
      .select({
        lastConnectedAt: sessions.lastConnectedAt,
        phoneNumber: sessions.phoneNumber,
        authCreds: sessions.authCreds,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (!row) return;

    const neverPaired = !row.lastConnectedAt && !row.phoneNumber;
    if (!neverPaired) return;

    if (row.authCreds && this.authCredsHaveRegisteredIdentity(row.authCreds as string)) {
      return;
    }

    await db.delete(sessionKeys).where(eq(sessionKeys.sessionId, sessionId));

    if (row.authCreds) {
      await db
        .update(sessions)
        .set({ authCreds: null, qrCode: null, updatedAt: new Date() })
        .where(eq(sessions.id, sessionId));

      logger.info('Cleared partial auth credentials for never-paired session', {
        sessionId,
      });
    }
  }

  /** True when stored creds include a paired WhatsApp identity (post-QR scan). */
  private authCredsHaveRegisteredIdentity(authCreds: string): boolean {
    try {
      const decrypted = decryptJSON(authCreds);
      const creds = JSON.parse(JSON.stringify(decrypted), BufferJSON.reviver) as {
        me?: { id?: string };
      };
      return !!creds.me?.id;
    } catch {
      return false;
    }
  }

  private getSessionRetryCount(sessionId: string): number {
    return this.sessionRetryCounts.get(sessionId) ?? 0;
  }

  private incrementSessionRetryCount(sessionId: string): number {
    const next = this.getSessionRetryCount(sessionId) + 1;
    this.sessionRetryCounts.set(sessionId, next);
    return next;
  }

  private clearSessionRetryCount(sessionId: string): void {
    this.sessionRetryCounts.delete(sessionId);
  }

  private incrementNeverPaired428Count(sessionId: string): number {
    const next = (this.neverPaired428Counts.get(sessionId) ?? 0) + 1;
    this.neverPaired428Counts.set(sessionId, next);
    return next;
  }

  private clearNeverPaired428Count(sessionId: string): void {
    this.neverPaired428Counts.delete(sessionId);
  }

  /**
   * Stop retrying after MAX_RETRIES consecutive disconnects.
   * Clears partial auth state when the session never paired successfully.
   */
  private async terminateSessionDueToMaxRetries(
    sessionId: string,
    orgId: string,
    statusCode: number | undefined,
    retryCount: number,
    options?: { message?: string },
  ): Promise<void> {
    if (!isValidUuid(sessionId)) return;

    const reconnectTimeout = this.pendingReconnects.get(sessionId);
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      this.pendingReconnects.delete(sessionId);
    }

    const terminalMessage =
      options?.message ??
      'Could not connect to WhatsApp after multiple attempts. Use Restart on the Sessions tab and try again.';

    logger.error('Max reconnection attempts reached — giving up', {
      sessionId,
      orgId,
      retryCount,
      maxRetries: MAX_RETRIES,
      statusCode,
      message: terminalMessage,
    });

    const [sessionRow] = await db
      .select({
        lastConnectedAt: sessions.lastConnectedAt,
        phoneNumber: sessions.phoneNumber,
        metadata: sessions.metadata,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    const neverPaired = !sessionRow?.lastConnectedAt && !sessionRow?.phoneNumber;
    const errorPayload = {
      connectionFailed: true,
      connectionFailedAt: new Date().toISOString(),
      lastDisconnectStatusCode: statusCode ?? null,
      connectionRetryCount: retryCount,
      connectionFailedMessage: terminalMessage,
    };
    const metadata = {
      ...((sessionRow?.metadata || {}) as Record<string, unknown>),
      ...errorPayload,
    };

    await db
      .update(sessions)
      .set({
        status: 'connection_failed',
        qrCode: null,
        ...(neverPaired ? { authCreds: null } : {}),
        metadata,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, sessionId));

    if (neverPaired) {
      try {
        await db.delete(sessionKeys).where(eq(sessionKeys.sessionId, sessionId));
        logger.warn('Cleared partial auth state for never-paired session after max retries', {
          sessionId,
        });
      } catch (err) {
        logger.error('Failed to clear session keys after max retries', {
          sessionId,
          error: (err as Error).message,
        });
      }
    }

    await eventBus.publishToStream(STREAMS.SESSIONS, 'session:status', {
      sessionId,
      orgId,
      status: 'connection_failed',
      connectionFailed: true,
      message: terminalMessage,
    });

    this.clearSessionRetryCount(sessionId);
    this.clearNeverPaired428Count(sessionId);
    await this.forceTerminateSocket(sessionId);
  }

  /**
   * Reset retry counters and connection_failed metadata before a manual restart.
   */
  private async prepareSessionForManualRestart(sessionId: string): Promise<void> {
    this.clearSessionRetryCount(sessionId);
    this.clearNeverPaired428Count(sessionId);

    const [sessionRow] = await db
      .select({ metadata: sessions.metadata })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    const metadata = { ...((sessionRow?.metadata || {}) as Record<string, unknown>) };
    delete metadata.connectionFailed;
    delete metadata.connectionFailedAt;
    delete metadata.lastDisconnectStatusCode;
    delete metadata.connectionRetryCount;
    delete metadata.connectionFailedMessage;

    await db
      .update(sessions)
      .set({
        status: 'initializing',
        metadata,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, sessionId));
  }

  /**
   * Terminate a session after repeated auth persistence failures.
   * Marks disconnected + metadata.authStateError so reconciliation does not auto-restart.
   */
  private async terminateSessionDueToAuthFailure(
    sessionId: string,
    orgId: string,
    reason: string,
  ): Promise<void> {
    if (!isValidUuid(sessionId)) return;

    this.saveCredsFailures.delete(sessionId);

    logger.error('Terminating session due to auth persistence failure', {
      sessionId,
      orgId,
      reason,
    });

    try {
      const errorPayload = {
        authStateError: reason,
        authStateErrorAt: new Date().toISOString(),
      };
      await db
        .update(sessions)
        .set({
          status: 'disconnected',
          metadata: sql`
            COALESCE(sessions.metadata, '{}'::jsonb) ||
            ${JSON.stringify(errorPayload)}::jsonb
          `,
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, sessionId));
    } catch (err) {
      logger.error('Failed to persist authStateError metadata', {
        sessionId,
        error: (err as Error).message,
      });
      await this.updateSessionStatus(sessionId, 'disconnected');
    }

    await eventBus.publishToStream(STREAMS.SESSIONS, 'session:status', {
      sessionId,
      orgId,
      status: 'disconnected',
      authStateError: reason,
    });

    await this.forceTerminateSocket(sessionId);
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

    // Call periodically every 15 minutes (900000 ms)
    active.presenceInterval = setInterval(() => {
      active.socket.sendPresenceUpdate('unavailable').catch((err) => {
        logger.warn('Failed to send unavailable presence update in keep-alive', { sessionId: active.sessionId, error: err.message });
      });
    }, 900000);
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
      this.clearLockRenewal(sessionId);
      this.stopDynamicWorkers(sessionId);
      
      // Explicitly remove listeners and end the socket to prevent leaks/reconnections
      try {
        active.socket.ev.removeAllListeners('connection.update');
        active.socket.ev.removeAllListeners('creds.update');
        active.socket.ev.removeAllListeners('messages.upsert');
        active.socket.ev.removeAllListeners('call');
        active.socket.ev.removeAllListeners('messages.update');
        active.socket.ev.removeAllListeners('message-receipt.update');
        active.socket.ev.removeAllListeners('messaging-history.set');
        active.socket.end(undefined);
      } catch (err) {
        logger.warn('Error closing socket in removeActiveSession', { sessionId, error: (err as Error).message });
      }

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

  private startLockRenewal(sessionId: string): void {
    this.clearLockRenewal(sessionId);
    this.lockRenewalFailures.set(sessionId, 0);
    this.lastSuccessfulRenewal.set(sessionId, Date.now());
    logger.info('Watchdog timer started for session', { sessionId });
    
    // 1. Heartbeat loop (runs every 3s to renew lease in Redis)
    const interval = setInterval(async () => {
      const lockKey = `session:${sessionId}:owner`;
      try {
        // Lua script to renew lock if we still own it
        const result = await redis.eval(`
          if redis.call('get', KEYS[1]) == ARGV[1] then
            return redis.call('expire', KEYS[1], ARGV[2])
          else
            return 0
          end
        `, 1, lockKey, this.replicaId, '10');
        
        if (Number(result) === 0) {
          logger.error('Failed to renew lock: Ownership changed or expired. Self-terminating socket.', { sessionId });
          await this.forceTerminateSocket(sessionId);
        } else {
          // Success, update timestamp and reset consecutive failures
          this.lastSuccessfulRenewal.set(sessionId, Date.now());
          this.lockRenewalFailures.set(sessionId, 0);
        }
      } catch (err) {
        const failures = (this.lockRenewalFailures.get(sessionId) || 0) + 1;
        this.lockRenewalFailures.set(sessionId, failures);
        logger.error('Error during lock renewal heartbeat', { sessionId, failures, error: (err as Error).message });
        
        if (failures >= 3) {
          logger.error('Consecutive heartbeat failures exceeded limit. Self-terminating socket.', { sessionId, failures });
          await this.forceTerminateSocket(sessionId);
        }
      }
    }, 3000); // Heartbeat every 3s
    
    this.lockRenewals.set(sessionId, interval);

    // 2. Local watchdog loop (runs every 2s, completely independent of Redis calls)
    const watchdogInterval = setInterval(async () => {
      const lastRenewal = this.lastSuccessfulRenewal.get(sessionId);
      if (lastRenewal) {
        const elapsed = Date.now() - lastRenewal;
        const maxElapsed = 8000; // 8 seconds fail-safe (under 10s Redis TTL)
        if (elapsed > maxElapsed) {
          logger.error('Watchdog: Lock renewal has not succeeded for 8s. Forcibly self-terminating socket.', { sessionId, elapsed });
          await this.forceTerminateSocket(sessionId);
        }
      }
    }, 2000);

    this.watchdogIntervals.set(sessionId, watchdogInterval);
  }

  private clearLockRenewal(sessionId: string): void {
    const interval = this.lockRenewals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      this.lockRenewals.delete(sessionId);
    }
    const watchdog = this.watchdogIntervals.get(sessionId);
    if (watchdog) {
      clearInterval(watchdog);
      this.watchdogIntervals.delete(sessionId);
      logger.info('Watchdog timer cleared for session', { sessionId });
    }
    this.lockRenewalFailures.delete(sessionId);
    this.lastSuccessfulRenewal.delete(sessionId);
  }

  async forceTerminateSocket(sessionId: string): Promise<void> {
    logger.warn('Forcibly terminating socket connection', { sessionId });
    
    // Clear reconnection timeout
    const reconnectTimeout = this.pendingReconnects.get(sessionId);
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      this.pendingReconnects.delete(sessionId);
    }

    this.saveCredsFailures.delete(sessionId);
    
    this.clearSyncTimeout(sessionId);
    this.clearLockRenewal(sessionId);
    this.stopDynamicWorkers(sessionId);
    
    const active = this.activeSessions.get(sessionId);
    if (active) {
      try {
        active.socket.ev.removeAllListeners('connection.update');
        active.socket.ev.removeAllListeners('creds.update');
        active.socket.ev.removeAllListeners('messages.upsert');
        active.socket.ev.removeAllListeners('call');
        active.socket.ev.removeAllListeners('messages.update');
        active.socket.ev.removeAllListeners('message-receipt.update');
        active.socket.ev.removeAllListeners('messaging-history.set');
        active.socket.end(undefined);
      } catch (err) {
        logger.warn('Error closing socket in forceTerminate', { sessionId, error: (err as Error).message });
      }
      this.activeSessions.delete(sessionId);
    }
    
    // Release Redis lock and update status asynchronously (do not await to prevent hanging)
    this.releaseLock(sessionId).catch(err => {
      logger.warn('releaseLock async error in forceTerminate', { sessionId, error: err.message });
    });
    this.updateSessionStatus(sessionId, 'disconnected').catch(err => {
      logger.warn('updateSessionStatus async error in forceTerminate', { sessionId, error: err.message });
    });
  }

  private async releaseLock(sessionId: string): Promise<void> {
    const lockKey = `session:${sessionId}:owner`;
    try {
      await redis.eval(`
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('del', KEYS[1])
        else
          return 0
        end
      `, 1, lockKey, this.replicaId);
      logger.info('Released Redis session lock', { sessionId });
    } catch (err) {
      logger.warn('Failed to release Redis lock', { sessionId, error: (err as Error).message });
    }
  }

  /**
   * Pace outbound WhatsApp sends per session (ban-risk mitigation):
   * 1. Per-minute cap (RATE_LIMIT_WA_MESSAGES): once the cap is reached,
   *    waits until the current 60s window expires before sending.
   * 2. Randomized inter-send gap (WA_SEND_DELAY_MIN_MS..WA_SEND_DELAY_MAX_MS)
   *    since the previous send, so bursts are spread into a human-like rhythm.
   *
   * Sleeping in the processor is safe: the outbound worker runs with
   * concurrency 1 per session and BullMQ auto-renews the job lock while
   * the processor is running, so queued jobs simply wait their turn.
   */
  private async throttleOutboundSend(sessionId: string): Promise<void> {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // 1. Per-minute send cap (no race: only the single lock-owning replica's
    //    serial outbound worker touches these keys for a given session)
    const countKey = `wa:send:count:${sessionId}`;
    for (;;) {
      const current = parseInt((await redis.get(countKey)) ?? '0', 10);
      if (current < env.RATE_LIMIT_WA_MESSAGES) {
        const count = await redis.incr(countKey);
        if (count === 1) {
          await redis.expire(countKey, 60);
        }
        break;
      }

      const ttl = await redis.ttl(countKey);
      if (ttl <= 0) {
        // Key expired or has no TTL (anomaly) — clear and retry
        await redis.del(countKey);
        continue;
      }

      logger.warn('Outbound send rate limit reached; delaying send', {
        sessionId,
        limitPerMinute: env.RATE_LIMIT_WA_MESSAGES,
        waitMs: ttl * 1000,
      });
      await sleep(ttl * 1000);
    }

    // 2. Randomized minimum gap since the previous send
    await this.paceWhatsAppGap(sessionId, `wa:send:last:${sessionId}`);
  }

  /**
   * Enforce a randomized inter-action gap for WhatsApp socket operations (ban-risk mitigation).
   * Uses WA_SEND_DELAY_MIN_MS..WA_SEND_DELAY_MAX_MS since the last action recorded in lastKey.
   */
  private async paceWhatsAppGap(sessionId: string, lastKey: string): Promise<void> {
    const minDelay = env.WA_SEND_DELAY_MIN_MS;
    const maxDelay = Math.max(env.WA_SEND_DELAY_MAX_MS, minDelay);
    const gapMs = minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1));

    const lastActionAt = parseInt((await redis.get(lastKey)) ?? '0', 10);
    const elapsed = Date.now() - lastActionAt;
    if (elapsed < gapMs) {
      await new Promise((resolve) => setTimeout(resolve, gapMs - elapsed));
    }
    await redis.set(lastKey, Date.now().toString(), 'EX', 3600);
  }

  /**
   * Pace Baileys readMessages receipts per chat (ban-risk mitigation).
   * Returns false if a receipt was sent for this chat within the cooldown window.
   */
  private async paceMarkReadReceipt(sessionId: string, waChatId: string): Promise<boolean> {
    const cooldownKey = `wa:mark-read:cooldown:${sessionId}:${waChatId}`;
    if (await redis.get(cooldownKey)) {
      logger.debug('mark-read skipped: per-chat cooldown active', { sessionId, waChatId });
      return false;
    }

    const maxDelay = Math.max(MARK_READ_DELAY_MAX_MS, MARK_READ_DELAY_MIN_MS);
    const delayMs =
      MARK_READ_DELAY_MIN_MS +
      Math.floor(Math.random() * (maxDelay - MARK_READ_DELAY_MIN_MS + 1));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return true;
  }

  private startDynamicWorkers(sessionId: string, orgId: string): void {
    this.stopDynamicWorkers(sessionId);
    
    logger.info('Starting dynamic workers for session', { sessionId });
    
    // 1. Outbound messages worker
    const outboundQueue = `queue-session-${sessionId}-outbound`;
    const outboundWorker = new Worker(
      outboundQueue,
      async (job: any) => {
        const {
          type,
          content,
          waChatJid,
          mediaUrl,
          mediaMimeType,
          mediaSize,
          filename,
          quotedWaMessageId,
          quotedMsgProto,
          quotedMsgFromMe,
          quotedContent,
          forwardRawMessage,
          sentByUserId,
          chatId,
        } = job.data;
        
        logger.info('Dynamic outbound worker processing job', { jobId: job.id, sessionId, waChatJid, type });
        
        let result: any;
        try {
          // Pace outbound sends (randomized delay + per-minute cap) to avoid
          // burst patterns that trigger WhatsApp bans
          await this.throttleOutboundSend(sessionId);

          // Fencing check before send
          const owner = await redis.get(`session:${sessionId}:owner`);
          if (owner !== this.replicaId) {
            logger.error('Outbound aborted: Lock ownership lost.', { sessionId });
            await this.forceTerminateSocket(sessionId);
            throw new Error('Lock ownership lost');
          }
          
          const active = this.activeSessions.get(sessionId);
          if (!active || !active.socket) {
            throw new Error(`Socket not active locally for session ${sessionId}`);
          }
          
          // Build Quoted context if present
          const sendOptions: any = {};
          if (quotedWaMessageId) {
            sendOptions.quoted = {
              key: { 
                remoteJid: waChatJid, 
                fromMe: quotedMsgFromMe ?? false, 
                id: quotedWaMessageId 
              },
              message: quotedMsgProto || { conversation: quotedContent || '' }
            };
          }

          // Send message
          if (type === 'forward') {
            if (!forwardRawMessage) throw new Error('forwardRawMessage is required for forwards');
            result = await active.socket.sendMessage(waChatJid, { forward: forwardRawMessage }, sendOptions);
          } else if (type === 'text') {
            if (!content) throw new Error('Content is required');
            result = await active.socket.sendMessage(waChatJid, { text: content }, sendOptions);
          } else if (type === 'image') {
            if (!mediaUrl) throw new Error('mediaUrl is required for image sends');
            result = await active.socket.sendMessage(waChatJid, { image: { url: mediaUrl }, caption: content || undefined }, sendOptions);
          } else if (type === 'video') {
            if (!mediaUrl) throw new Error('mediaUrl is required for video sends');
            result = await active.socket.sendMessage(waChatJid, { video: { url: mediaUrl }, caption: content || undefined }, sendOptions);
          } else if (type === 'audio') {
            if (!mediaUrl) throw new Error('mediaUrl is required for audio sends');
            result = await active.socket.sendMessage(waChatJid, { audio: { url: mediaUrl } }, sendOptions);
          } else if (type === 'document') {
            if (!mediaUrl) throw new Error('mediaUrl is required for document sends');
            result = await active.socket.sendMessage(waChatJid, { document: { url: mediaUrl }, mimetype: mediaMimeType, fileName: filename }, sendOptions);
          } else {
            throw new Error(`Unsupported outbound type: ${type}`);
          }
        } catch (err) {
          // Message was NOT delivered to WhatsApp — safe for BullMQ to retry.
          logger.error('Outbound worker send failed (job will retry)', {
            jobId: job.id,
            sessionId,
            waChatJid,
            type,
            mediaUrl,
            error: (err as Error).message,
            stack: (err as Error).stack,
          });
          throw err;
        }

        // From here on, the message HAS been delivered to WhatsApp. Any failure
        // below must NOT rethrow: a BullMQ retry would re-run sendMessage and
        // deliver a duplicate message (ban-risk + user-facing bug).
        try {
          if (!result?.key?.id) throw new Error('No message ID returned from Baileys');

          // Resolve saved type (especially for forwards)
          let savedType = type;
          if (type === 'forward' && result.message) {
            const keys = Object.keys(result.message);
            if (keys.includes('conversation') || keys.includes('extendedTextMessage')) savedType = 'text';
            else if (keys.includes('imageMessage')) savedType = 'image';
            else if (keys.includes('videoMessage')) savedType = 'video';
            else if (keys.includes('audioMessage')) savedType = 'audio';
            else if (keys.includes('documentMessage')) savedType = 'document';
          }

          const isForwarded = type === 'forward' || !!result.message?.extendedTextMessage?.contextInfo?.isForwarded;
          const forwardScore = isForwarded ? 1 : 0;

          // Save to database
          const { messageService } = await import('../messages/message.service.js');
          const timestamp = result.messageTimestamp ? new Date(Number(result.messageTimestamp) * 1000) : new Date();
          const dbMessage = await messageService.upsertMessage({
            orgId,
            sessionId,
            chatId,
            waMessageId: result.key.id,
            senderJid: 'me',
            fromMe: true,
            messageType: savedType,
            content: content || null,
            mediaUrl: mediaUrl || null,
            mediaMimeType: mediaMimeType || null,
            mediaSize: mediaSize || null,
            quotedContent: quotedContent || null,
            status: 'sent',
            isForwarded,
            forwardScore,
            metadata: { 
              ...(quotedWaMessageId ? { quotedWaMessageId } : {}),
              fileName: filename || undefined,
              waMessage: result,
            },
            sentByUserId: sentByUserId ?? null,
            createdAt: timestamp,
          });
          
          // Broadcast new message
          const { eventBus, STREAMS } = await import('../../events/event-bus.js');
          await eventBus.publishToStream(STREAMS.MESSAGES, 'message:new', {
            sessionId,
            orgId,
            chatId,
            message: dbMessage,
          });

          // Mark chat as read after reply (DB + audit + blue ticks)
          const { chatService } = await import('../chats/chat.service.js');
          await chatService.markChatAsRead(orgId, chatId, {
            userId: sentByUserId ?? null,
            trigger: 'reply',
            reason: 'Auto: reply sent from dashboard',
          });
        } catch (err) {
          // Swallow (do not rethrow): message was already sent to WhatsApp,
          // retrying the job would send it again.
          logger.error('Outbound post-send processing failed; message WAS sent to WhatsApp but may not be saved/broadcast locally', {
            jobId: job.id,
            sessionId,
            waChatJid,
            type,
            waMessageId: result?.key?.id ?? null,
            error: (err as Error).message,
            stack: (err as Error).stack,
          });
        }
      },
      { connection: workerRedis.duplicate() as any }
    );
    
    // 2. Media download worker
    const mediaQueue = `queue-session-${sessionId}-media`;
    const mediaWorker = new Worker(
      mediaQueue,
      async (job: any) => {
        const { messageId, messageData } = job.data;
        logger.info('Dynamic media worker processing job', { jobId: job.id, sessionId, messageId });
        
        const active = this.activeSessions.get(sessionId);
        if (!active || !active.socket) throw new Error(`Socket not active locally for session ${sessionId}`);

        await this.paceWhatsAppGap(sessionId, `wa:media:last:${sessionId}`);
        
        const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
        const buffer = await downloadMediaMessage(
          messageData,
          'buffer',
          {},
          { logger: undefined as any, reuploadRequest: active.socket.updateMediaMessage }
        );
        
        if (!buffer || buffer.length === 0) return { messageId, status: 'empty' };
        
        const mediaMsg = messageData.message?.imageMessage ?? messageData.message?.videoMessage ?? messageData.message?.audioMessage ?? messageData.message?.documentMessage ?? messageData.message?.stickerMessage;
        const mimeType = mediaMsg?.mimetype ?? 'application/octet-stream';
        const filename = mediaMsg?.fileName ?? `media-${messageId}`;
        
        const { mediaService } = await import('../media/media.service.js');
        const result = await mediaService.upload({
          orgId,
          sessionId,
          messageId,
          buffer: Buffer.from(buffer),
          filename,
          mimeType,
        });
        
        const { messageService } = await import('../messages/message.service.js');
        const dbMessage = await messageService.getMessageById(orgId, messageId);
        if (dbMessage) {
          const updatedMessage = await messageService.upsertMessage({
            ...dbMessage,
            mediaUrl: result.objectKey,
            mediaMimeType: mimeType,
            mediaSize: result.sizeBytes,
            metadata: {
              ...dbMessage.metadata,
              mediaFileId: result.fileId,
              thumbnailKey: result.thumbnailUrl ? result.objectKey.replace(/(\.[^.]+)$/, '_thumb.jpg') : undefined,
              checksum: result.checksumSha256,
              mediaStatus: 'downloaded',
            },
          });
          
          const { eventBus, STREAMS } = await import('../../events/event-bus.js');
          await eventBus.publishToStream(STREAMS.MESSAGES, 'message:media_update', {
            sessionId,
            orgId,
            chatId: dbMessage.chatId,
            message: updatedMessage,
          });
        }
      },
      { connection: workerRedis.duplicate() as any }
    );
    
    // 3. Control commands worker
    const controlQueue = `queue-session-${sessionId}-control`;
    const controlWorker = new Worker(
      controlQueue,
      async (job: any) => {
        const { action, payload } = job.data;
        logger.info('Dynamic control worker processing job', { jobId: job.id, sessionId, action });
        
        if (action === 'restart') {
          await this.prepareSessionForManualRestart(sessionId);
          await this.forceTerminateSocket(sessionId);
          await this.initializeSocket(sessionId, orgId);
        } else if (action === 'destroy') {
          return await this.destroySession(sessionId, { unlinkFromWhatsApp: true });
        } else if (action === 'reset-contact-session') {
          const active = this.activeSessions.get(sessionId);
          if (active && active.socket) {
            const { contactJid } = payload;
            const resolvedJid = await resolveLidJid(sessionId, contactJid);
            const jidsToDelete = Array.from(new Set([contactJid, resolvedJid]));
            await active.socket.signalRepository.deleteSession(jidsToDelete);
            logger.info('Reset encryption session for contact via control worker', { sessionId, contactJid, jidsToDelete });
          }
        } else if (action === 'fetch-history') {
          const active = this.activeSessions.get(sessionId);
          if (active && active.socket) {
            const { waChatId, count, oldestMsgKey, oldestMsgTimestamp } = payload;
            logger.info('Requesting on-demand history sync from phone via control worker', { sessionId, waChatId, count });
            await active.socket.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp);
          }
        } else if (action === 'mark-read') {
          const active = this.activeSessions.get(sessionId);
          if (!active?.socket) {
            throw new Error(`Socket not active locally for session ${sessionId}`);
          }

          const { waChatId, lastInboundMsg } = payload;
          if (!lastInboundMsg?.waMessageId) {
            logger.warn('mark-read skipped: no inbound message key', { sessionId, waChatId });
            return;
          }

          const key: {
            remoteJid: string;
            id: string;
            fromMe: boolean;
            participant?: string;
          } = {
            remoteJid: waChatId,
            id: lastInboundMsg.waMessageId,
            fromMe: false,
          };

          if (waChatId.endsWith('@g.us') && lastInboundMsg.senderJid) {
            key.participant = lastInboundMsg.senderJid;
          }

          const shouldSend = await this.paceMarkReadReceipt(sessionId, waChatId);
          if (!shouldSend) {
            return;
          }

          await active.socket.readMessages([key]);

          const cooldownKey = `wa:mark-read:cooldown:${sessionId}:${waChatId}`;
          await redis.set(cooldownKey, '1', 'EX', MARK_READ_COOLDOWN_SEC);

          logger.info('Baileys readMessages sent', {
            sessionId,
            waChatId,
            msgId: lastInboundMsg.waMessageId,
          });
        } else if (action === 'presence-subscribe') {
          const active = this.activeSessions.get(sessionId);
          if (!active?.socket) {
            throw new Error(`Socket not active locally for session ${sessionId}`);
          }

          const { waChatId } = payload;
          if (!waChatId || waChatId.endsWith('@g.us')) {
            logger.info('presence-subscribe skipped for group or missing JID', { sessionId, waChatId });
            return;
          }

          const resolvedJid = await resolveLidJid(sessionId, waChatId);

          // WhatsApp routes presence updates only after a brief available window.
          // Subscribe, then restore unavailable so mobile push notifications keep working.
          logger.debug('[DEBUG PRESENCE] presence subscribe sequence starting', {
            sessionId,
            waChatId,
            resolvedJid,
          });

          await active.socket.sendPresenceUpdate('available');
          await active.socket.presenceSubscribe(resolvedJid);

          logger.debug('[DEBUG PRESENCE] presenceSubscribe sent', {
            sessionId,
            waChatId,
            resolvedJid,
          });

          setTimeout(() => {
            active.socket
              .sendPresenceUpdate('unavailable')
              .then(() => {
                logger.debug('[DEBUG PRESENCE] restored unavailable after presence subscribe', {
                  sessionId,
                  waChatId,
                  resolvedJid,
                });
              })
              .catch((err) => {
                logger.warn('Failed to restore unavailable after presence subscribe', {
                  sessionId,
                  waChatId,
                  resolvedJid,
                  error: (err as Error).message,
                });
              });
          }, 2500);
        }
      },
      { connection: workerRedis.duplicate() as any }
    );

    outboundWorker.on('error', (err: any) => logger.error('Outbound dynamic worker error', { sessionId, error: err.message }));
    mediaWorker.on('error', (err: any) => logger.error('Media dynamic worker error', { sessionId, error: err.message }));
    controlWorker.on('error', (err: any) => logger.error('Control dynamic worker error', { sessionId, error: err.message }));

    this.dynamicWorkers.set(sessionId, [outboundWorker, mediaWorker, controlWorker]);
  }

  private stopDynamicWorkers(sessionId: string): void {
    const workers = this.dynamicWorkers.get(sessionId);
    if (workers) {
      logger.info('Stopping dynamic workers for session', { sessionId });
      for (const worker of workers) {
        worker.close().catch((err: any) => {
          logger.warn('Error closing dynamic worker', { sessionId, error: err.message });
        });
      }
      this.dynamicWorkers.delete(sessionId);
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

