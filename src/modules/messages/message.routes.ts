/**
 * Message Routes — REST API for message operations.
 */

import { Router } from 'express';
import { z } from 'zod';
import { messageService } from './message.service.js';
import { messageSyncService } from './message.sync.js';
import { authenticate } from '../auth/auth.middleware.js';
import { logger } from '../../observability/logger.js';
import { eventBus } from '../../events/event-bus.js';
import { chatService } from '../chats/chat.service.js';
import { sessionManager } from '../sessions/session.manager.js';

export const messageRouter = Router();

// All routes require authentication
messageRouter.use(authenticate);

/**
 * POST /api/messages
 * Send/queue a message to a WhatsApp JID or phone number.
 */
messageRouter.post('/', async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const schema = z.object({
      sessionId: z.string().uuid(),
      recipientJid: z.string().min(1),
      body: z.string().min(1),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid message request parameters', details: parsed.error.flatten() });
    }

    const { sessionId, recipientJid, body } = parsed.data;

    // Validate that session exists and belongs to the user's organization
    const activeSession = sessionManager.getSession(sessionId);
    if (!activeSession || activeSession.orgId !== orgId) {
      return res.status(404).json({ error: 'Active session not found or access denied' });
    }

    // Standardize recipient JID (e.g. 966500000000 -> 966500000000@s.whatsapp.net)
    let waChatJid = recipientJid.trim();
    if (!waChatJid.includes('@')) {
      waChatJid = `${waChatJid}@s.whatsapp.net`;
    }

    // Ensure the chat thread exists in the database
    const chatId = await chatService.ensureChatExists(orgId, sessionId, waChatJid);
    if (!chatId) {
      return res.status(500).json({ error: 'Failed to create or resolve chat thread' });
    }

    // Publish outbound job to the event bus
    const jobId = await eventBus.publishMessageOutbound(sessionId, orgId, {
      chatId,
      waChatJid,
      type: 'text',
      content: body,
    });

    return res.status(202).json({
      success: true,
      message: 'Message queued for sending',
      data: {
        jobId,
        chatId,
        waChatJid,
      }
    });
  } catch (err) {
    logger.error('Failed to queue outbound message', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to queue message' });
  }
});

/**
 * GET /api/chats/:chatId/messages
 * Cursor-paginated message list for a chat.
 */
messageRouter.get('/chats/:chatId/messages', async (req, res) => {
  try {
    const { chatId } = req.params;
    const orgId = req.user!.orgId;

    const cursorParam = req.query.cursor as string | undefined;
    let cursor;
    if (cursorParam) {
      try {
        cursor = JSON.parse(Buffer.from(cursorParam, 'base64url').toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'Invalid cursor format' });
      }
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

    const result = await messageService.getMessages(orgId, chatId, { cursor, limit });

    // Encode cursor for client
    const encodedCursor = result.nextCursor
      ? Buffer.from(JSON.stringify(result.nextCursor)).toString('base64url')
      : null;

    return res.json({
      messages: result.messages,
      cursor: encodedCursor,
      hasMore: result.hasMore,
    });
  } catch (err) {
    logger.error('Failed to get messages', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to retrieve messages' });
  }
});

/**
 * GET /api/messages/search
 * Full-text search across messages.
 */
messageRouter.get('/search', async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const schema = z.object({
      q: z.string().min(2).max(200),
      sessionId: z.string().uuid().optional(),
      chatId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
      cursor: z.string().optional(),
    });

    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.flatten() });
    }

    let cursor;
    if (parsed.data.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(parsed.data.cursor, 'base64url').toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'Invalid cursor format' });
      }
    }

    const result = await messageService.searchMessages(orgId, {
      query: parsed.data.q,
      sessionId: parsed.data.sessionId,
      chatId: parsed.data.chatId,
      limit: parsed.data.limit,
      cursor,
    });

    return res.json(result);
  } catch (err) {
    logger.error('Message search failed', { error: (err as Error).message });
    return res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /api/messages/:id
 * Get a single message by ID.
 */
messageRouter.get('/:id', async (req, res) => {
  try {
    const message = await messageService.getMessageById(req.user!.orgId, req.params.id);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    return res.json(message);
  } catch (err) {
    logger.error('Failed to get message', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to retrieve message' });
  }
});

/**
 * PATCH /api/messages/:id/star
 * Toggle message star.
 */
messageRouter.patch('/:id/star', async (req, res) => {
  try {
    const { starred } = z.object({ starred: z.boolean() }).parse(req.body);
    await messageService.toggleStar(req.user!.orgId, req.params.id, starred);
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to toggle star', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to update message' });
  }
});

/**
 * DELETE /api/messages/:id
 * Soft-delete a message.
 */
messageRouter.delete('/:id', async (req, res) => {
  try {
    await messageService.deleteMessage(req.user!.orgId, req.params.id);
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete message', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to delete message' });
  }
});

/**
 * GET /api/messages/sync/progress/:sessionId
 * Get history sync progress for a session.
 */
messageRouter.get('/sync/progress/:sessionId', async (req, res) => {
  try {
    const progress = await messageSyncService.getSyncProgress(req.params.sessionId);
    if (!progress) {
      return res.status(404).json({ error: 'No sync progress found' });
    }
    return res.json(progress);
  } catch (err) {
    logger.error('Failed to get sync progress', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to get sync progress' });
  }
});
