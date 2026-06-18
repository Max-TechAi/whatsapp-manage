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
import { sessions } from '../../db/schema.js';
import { authenticate } from '../auth/auth.middleware.js';
import { sessionManager } from './session.manager.js';
import { logger } from '../../observability/logger.js';

/** Request body schema for session creation */
const createSessionSchema = z.object({
  sessionName: z
    .string()
    .min(1, 'Session name is required')
    .max(100, 'Session name must be 100 characters or less')
    .trim(),
});

/**
 * Express Router for session management endpoints.
 * All routes are protected by JWT authentication middleware.
 */
const router = Router();

// Apply authentication to all session routes
router.use(authenticate);

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
    const { orgId } = req.user!;

    const orgSessions = await db
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

    // Enrich with live status from the session manager
    const enriched = orgSessions.map((session) => ({
      ...session,
      liveStatus: sessionManager.getSessionStatus(session.id),
    }));

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

    res.status(200).json({
      success: true,
      data: {
        ...sessionData,
        liveStatus: sessionManager.getSessionStatus(sessionId),
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

    // Destroy existing socket connection (keeps DB record)
    const activeSession = sessionManager.getSession(sessionId);
    if (activeSession) {
      try {
        activeSession.socket.end(undefined);
      } catch {
        // Socket may already be closed
      }
    }

    // Reinitialize the socket (will generate new QR if needed)
    await sessionManager.initializeSocket(sessionId, orgId);

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

    logger.info('Deleting session via API', { sessionId, orgId });

    // Destroy socket, keys, and clean up
    await sessionManager.destroySession(sessionId);

    // Delete the session record itself
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

export default router;
