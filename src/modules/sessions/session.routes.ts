/**
 * Session management REST API routes.
 *
 * All routes require JWT authentication and are scoped to the
 * authenticated user's organization (multi-tenancy enforcement).
 *
 * Routes:
 * - POST   /           Create a new WhatsApp session
 * - GET    /           List all sessions for the organization
 * - GET    /:id        Get session details (status, QR, metadata)
 * - GET    /:id/qr     Get QR code for client-side pairing display
 * - POST   /:id/restart  Restart a disconnected session
 * - DELETE /:id        Permanently destroy a session
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';

import { db } from '../../config/database.js';
import { sessions, chats } from '../../db/schema.js';
import { authenticate } from '../auth/auth.middleware.js';
import { sessionManager, updateSyncProgress, isValidUuid } from './session.manager.js';
import { logger } from '../../observability/logger.js';
import { redis } from '../../config/redis.js';
import { resolveLidJid } from './lid-mapping.js';
import { eventBus } from '../../events/event-bus.js';
import type { SessionStatus } from './session.types.js';

/** Request body schema for session creation */
const createSessionSchema = z.object({
  sessionName: z
    .string()
    .min(1, 'Session name is required')
    .max(100, 'Session name must be 100 characters or less')
    .trim(),
});

const resetContactSessionSchema = z.object({
  contactJid: z.string().min(1, 'Contact JID is required'),
});

/**
 * Express Router for session management endpoints.
 * All routes are protected by JWT authentication middleware.
 */
const router = Router();

// Apply authentication to all session routes
router.use(authenticate);

// Parameter guard to validate session UUID format, verify ownership, and enforce level-1 permission checks
router.param('id', async (req, res, next, id) => {
  if (!isValidUuid(id)) {
    logger.warn('Invalid UUID parameter detected in session routes', {
      param: 'id',
      value: id,
      path: req.path,
      stack: new Error().stack,
    });
    res.status(400).json({ error: 'Invalid ID format' });
    return;
  }

  try {
    const { orgId, role, userId, hasAllSessionsAccess } = req.user!;
    const { userSessionAccess } = await import('../../db/schema.js');

    // Admins and agents with 'hasAllSessionsAccess' bypass session-level restrictions
    if (role === 'admin' || hasAllSessionsAccess) {
      const [sessionRecord] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, id), eq(sessions.orgId, orgId)))
        .limit(1);

      if (!sessionRecord) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      return next();
    }

    // Regular agents: check userSessionAccess table
    const [accessRecord] = await db
      .select({ id: sessions.id })
      .from(userSessionAccess)
      .innerJoin(sessions, eq(userSessionAccess.sessionId, sessions.id))
      .where(
        and(
          eq(userSessionAccess.userId, userId),
          eq(userSessionAccess.sessionId, id),
          eq(sessions.orgId, orgId)
        )
      )
      .limit(1);

    if (!accessRecord) {
      res.status(403).json({ error: 'Access denied: you do not have permission for this WhatsApp session' });
      return;
    }

    next();
  } catch (error) {
    logger.error('Error during session parameter access check', {
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionId: id,
      userId: req.user?.userId,
    });
    res.status(500).json({ error: 'Internal server error during access check' });
  }
});

// ─── POST / — Create a new session ────────────────────────────────────────

router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { sessionName } = parsed.data;
    const { orgId, userId } = req.user!;

    const session = await sessionManager.createSession(orgId, userId, sessionName);

    logger.info('Session created via API', {
      sessionId: session.id,
      orgId,
    });

    res.status(201).json({
      success: true,
      data: {
        id: session.id,
        sessionName: session.sessionName,
        status: session.status,
        phoneNumber: session.phoneNumber,
        qrCode: session.qrCode,
        lastConnectedAt: session.lastConnectedAt,
        createdAt: session.createdAt,
      },
    });
  } catch (error) {
    logger.error('Failed to create session', {
      error: error instanceof Error ? error.message : 'Unknown error',
      orgId: req.user?.orgId,
    });
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// ─── GET / — List all sessions for the organization ───────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orgId, role, userId, hasAllSessionsAccess } = req.user!;
    const { userSessionAccess } = await import('../../db/schema.js');

    let orgSessions;
    if (role === 'admin' || hasAllSessionsAccess) {
      orgSessions = await db
        .select({
          id: sessions.id,
          sessionName: sessions.sessionName,
          phoneNumber: sessions.phoneNumber,
          status: sessions.status,
          lastConnectedAt: sessions.lastConnectedAt,
          createdAt: sessions.createdAt,
        })
        .from(sessions)
        .where(eq(sessions.orgId, orgId))
        .orderBy(sessions.createdAt);
    } else {
      const rows = await db
        .select({
          id: sessions.id,
          sessionName: sessions.sessionName,
          phoneNumber: sessions.phoneNumber,
          status: sessions.status,
          lastConnectedAt: sessions.lastConnectedAt,
          createdAt: sessions.createdAt,
        })
        .from(sessions)
        .innerJoin(userSessionAccess, eq(sessions.id, userSessionAccess.sessionId))
        .where(
          and(
            eq(sessions.orgId, orgId),
            eq(userSessionAccess.userId, userId)
          )
        )
        .orderBy(sessions.createdAt);
      orgSessions = rows;
    }

    // Enrich with live status from Redis and DB status fallback
    const sessionIds = orgSessions.map((s) => s.id);
    let owners: Array<[Error | null, string | null]> | null = null;
    if (sessionIds.length > 0) {
      try {
        const pipeline = redis.pipeline();
        sessionIds.forEach((id) => pipeline.get(`session:${id}:owner`));
        owners = (await pipeline.exec()) as Array<[Error | null, string | null]>;
      } catch (err) {
        logger.error('Failed to pipeline fetch session owners from Redis', { error: (err as Error).message });
      }
    }

    const enriched = orgSessions.map((session, index) => {
      const owner = owners ? owners[index]?.[1] : null;
      const liveStatus: SessionStatus = owner ? (session.status as SessionStatus) : 'disconnected';
      return {
        ...session,
        liveStatus,
      };
    });

    res.status(200).json({
      success: true,
      data: enriched,
    });
  } catch (error) {
    logger.error('Failed to list sessions', {
      error: error instanceof Error ? error.message : 'Unknown error',
      orgId: req.user?.orgId,
    });
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// ─── GET /:id — Get session details ───────────────────────────────────────

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orgId } = req.user!;
    const sessionId = req.params.id as string;

    const session = await db
      .select({
        id: sessions.id,
        sessionName: sessions.sessionName,
        phoneNumber: sessions.phoneNumber,
        status: sessions.status,
        qrCode: sessions.qrCode,
        lastConnectedAt: sessions.lastConnectedAt,
        createdAt: sessions.createdAt,
      })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.orgId, orgId)))
      .limit(1);

    if (session.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const sessionData = session[0];
    const owner = await redis.get(`session:${sessionId}:owner`).catch(() => null);
    const liveStatus: SessionStatus = owner ? (sessionData.status as SessionStatus) : 'disconnected';

    res.status(200).json({
      success: true,
      data: {
        ...sessionData,
        liveStatus,
      },
    });
  } catch (error) {
    logger.error('Failed to get session', {
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionId: req.params.id,
      orgId: req.user?.orgId,
    });
    res.status(500).json({ error: 'Failed to get session details' });
  }
});

// ─── GET /:id/qr — Get QR code for pairing ───────────────────────────────

router.get('/:id/qr', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orgId } = req.user!;
    const sessionId = req.params.id as string;

    const session = await db
      .select({
        id: sessions.id,
        status: sessions.status,
        qrCode: sessions.qrCode,
      })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.orgId, orgId)))
      .limit(1);

    if (session.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const { status, qrCode } = session[0];

    // If already connected or no QR available, return 204
    if (status === 'connected' || !qrCode) {
      res.status(204).json({
        success: true,
        data: {
          sessionId,
          qr: null,
          status,
        },
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        sessionId,
        qr: qrCode,
        status,
      },
    });
  } catch (error) {
    logger.error('Failed to get QR code', {
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionId: req.params.id,
      orgId: req.user?.orgId,
    });
    res.status(500).json({ error: 'Failed to get QR code' });
  }
});

// ─── GET /:id/groups — Fetch all participating groups ────────────────────

router.get('/:id/groups', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orgId } = req.user!;
    const sessionId = req.params.id as string;

    // Validate session ownership
    const session = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.orgId, orgId)))
      .limit(1);

    if (session.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Fetch groups from chats database table (synced from Baileys)
    const groups = await db
      .select({
        id: chats.waChatId,
        subject: chats.name,
        metadata: chats.metadata,
      })
      .from(chats)
      .where(
        and(
          eq(chats.sessionId, sessionId),
          eq(chats.orgId, orgId),
          eq(chats.chatType, 'group')
        )
      );

    const data = groups.map((g) => ({
      id: g.id,
      subject: g.subject || 'Unnamed Group',
      owner: null,
      creation: null,
      desc: null,
      participantsCount: (g.metadata as any)?.participantsCount ?? 0,
    }));

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    logger.error('Failed to fetch groups', {
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionId: req.params.id,
      orgId: req.user?.orgId,
    });
    res.status(500).json({ error: 'Failed to fetch groups from WhatsApp' });
  }
});

// ─── POST /:id/restart — Restart a session ────────────────────────────────

router.post('/:id/restart', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orgId } = req.user!;
    const sessionId = req.params.id as string;

    // Verify session belongs to the organization
    const session = await db
      .select({ id: sessions.id, orgId: sessions.orgId })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.orgId, orgId)))
      .limit(1);

    if (session.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    logger.info('Restarting session via API', { sessionId, orgId });

    // Publish restart command to the session control queue
    await eventBus.publishSessionControl(sessionId, 'restart');

    res.status(200).json({
      success: true,
      message: 'Session restart initiated',
      data: {
        sessionId,
        status: 'initializing',
      },
    });
  } catch (error) {
    logger.error('Failed to restart session', {
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionId: req.params.id,
      orgId: req.user?.orgId,
    });
    res.status(500).json({ error: 'Failed to restart session' });
  }
});

// ─── DELETE /:id — Permanently destroy a session ──────────────────────────

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orgId } = req.user!;
    const sessionId = req.params.id as string;

    // Verify session belongs to the organization
    const session = await db
      .select({ id: sessions.id, orgId: sessions.orgId })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.orgId, orgId)))
      .limit(1);

    if (session.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Enqueue destroy command so runner cleans up if online
    await eventBus.publishSessionControl(sessionId, 'destroy').catch(() => {});

    // Delete ownership lock immediately to force self-termination if runner missed command
    await redis.del(`session:${sessionId}:owner`).catch(() => {});

    // Delete the session record itself (cascades to signal keys, chats, messages)
    await db
      .delete(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.orgId, orgId)));

    res.status(200).json({
      success: true,
      message: 'Session deleted permanently',
    });
  } catch (error) {
    logger.error('Failed to delete session', {
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionId: req.params.id,
      orgId: req.user?.orgId,
    });
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// ─── GET /:id/sync-status — Get history sync status ───────────────────────

router.get('/:id/sync-status', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orgId } = req.user!;
    const sessionId = req.params.id as string;

    // Verify session ownership
    const [sessionRecord] = await db
      .select({ id: sessions.id, metadata: sessions.metadata })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.orgId, orgId)))
      .limit(1);

    if (!sessionRecord) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Try fetching from Redis first
    const progressKey = `sync:progress:${sessionId}`;
    const redisProgress = await redis.hgetall(progressKey);
    const metadata = (sessionRecord.metadata || {}) as Record<string, any>;

    const syncStatus = redisProgress.syncStatus || metadata.syncStatus || 'pending';
    const syncProcessedMessages = parseInt(redisProgress.syncProcessedMessages || '0') || metadata.syncProcessedMessages || 0;
    const syncTotalMessages = parseInt(redisProgress.syncTotalMessages || '0') || metadata.syncTotalMessages || 0;
    const historySyncCompleted = !!metadata.historySyncCompleted;

    res.status(200).json({
      success: true,
      data: {
        syncStatus,
        syncProcessedMessages,
        syncTotalMessages,
        historySyncCompleted,
      },
    });
  } catch (error) {
    logger.error('Failed to get sync status', {
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionId: req.params.id,
      orgId: req.user?.orgId,
    });
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

// ─── POST /:id/sync-retry — Force/retry initial history sync ──────────────

router.post('/:id/sync-retry', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orgId } = req.user!;
    const sessionId = req.params.id as string;

    // Verify session ownership
    const [sessionRecord] = await db
      .select({ id: sessions.id, metadata: sessions.metadata })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.orgId, orgId)))
      .limit(1);

    if (!sessionRecord) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    logger.info('Retrying sync for session', { sessionId, orgId });

    // Clean up Redis sync progress and rate limits
    const progressKey = `sync:progress:${sessionId}`;
    const rateLimitKey = `sync:limit:${sessionId}`;
    await redis.del(progressKey);
    await redis.del(rateLimitKey);

    // Reset Postgres metadata sync status
    const currentMetadata = (sessionRecord.metadata || {}) as Record<string, any>;
    const updatedMetadata = {
      ...currentMetadata,
      syncStatus: 'pending',
      syncProcessedMessages: 0,
      syncTotalMessages: 0,
    } as Record<string, any>;
    delete updatedMetadata.historySyncCompleted;
    delete updatedMetadata.historySyncCompletedAt;
    delete updatedMetadata.syncErrorReason;

    await db
      .update(sessions)
      .set({
        metadata: updatedMetadata,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, sessionId));

    // Publish restart command to control queue so the runner recreates socket to trigger full sync
    await eventBus.publishSessionControl(sessionId, 'restart');

    // Update progress state
    await updateSyncProgress(sessionId, 'pending', 0, 0);

    res.status(200).json({
      success: true,
      message: 'Sync retry initiated',
      data: {
        syncStatus: 'pending',
        syncProcessedMessages: 0,
        syncTotalMessages: 0,
        historySyncCompleted: false,
      },
    });
  } catch (error) {
    logger.error('Failed to retry sync', {
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionId: req.params.id,
      orgId: req.user?.orgId,
    });
    res.status(500).json({ error: 'Failed to retry sync' });
  }
});

// ─── POST /:id/reset-contact-session — Reset Signal encryption session for a contact ──────

router.post('/:id/reset-contact-session', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orgId } = req.user!;
    const sessionId = req.params.id as string;

    const parsed = resetContactSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { contactJid } = parsed.data;

    // Verify session ownership
    const [sessionRecord] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.orgId, orgId)))
      .limit(1);

    if (!sessionRecord) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Publish reset Signal session control command to session runner
    await eventBus.publishSessionControl(sessionId, 'reset-contact-session', { contactJid });

    logger.info('Enqueued manually resetting Signal session for contact', { sessionId, orgId, contactJid });

    res.status(200).json({
      success: true,
      message: 'Successfully enqueued reset encryption session request. A new secure session will establish on the next message.',
    });
  } catch (error) {
    logger.error('Failed to reset contact session', {
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionId: req.params.id,
      orgId: req.user?.orgId,
      contactJid: req.body?.contactJid,
    });
    res.status(500).json({ error: 'Failed to reset contact session' });
  }
});

// ─── GET /:id/lid-mappings — Get all LID-to-Phone JID mappings for a session ────────

router.get('/:id/lid-mappings', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orgId } = req.user!;
    const sessionId = req.params.id as string;

    // Verify session ownership
    const [sessionRecord] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.orgId, orgId)))
      .limit(1);

    if (!sessionRecord) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Fetch mappings from Redis
    const mappingsKey = `lid:mapping:${sessionId}`;
    const mappings = await redis.hgetall(mappingsKey);

    res.status(200).json({
      success: true,
      data: mappings || {},
    });
  } catch (error) {
    logger.error('Failed to fetch LID mappings', {
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionId: req.params.id,
      orgId: req.user?.orgId,
    });
    res.status(500).json({ error: 'Failed to fetch LID mappings' });
  }
});

export default router;
