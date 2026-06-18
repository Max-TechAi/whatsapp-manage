/**
 * Chat Routes — REST API for chat/conversation operations.
 */

import { Router } from 'express';
import { z } from 'zod';
import { chatService } from './chat.service.js';
import { authenticate } from '../auth/auth.middleware.js';
import { logger } from '../../observability/logger.js';

export const chatRouter = Router();

chatRouter.use(authenticate);

/**
 * GET /api/chats?sessionId=...&archived=false&limit=50&cursor=...
 * List chats for a session, sorted by last message time.
 */
chatRouter.get('/', async (req, res) => {
  try {
    const schema = z.object({
      sessionId: z.string().uuid(),
      archived: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
    });

    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.flatten() });
    }

    const result = await chatService.getChatList(req.user!.orgId, parsed.data);
    return res.json(result);
  } catch (err) {
    logger.error('Failed to list chats', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to list chats' });
  }
});

/**
 * GET /api/chats/:id
 * Get a single chat.
 */
chatRouter.get('/:id', async (req, res) => {
  try {
    const chat = await chatService.getChatById(req.user!.orgId, req.params.id);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }
    return res.json(chat);
  } catch (err) {
    logger.error('Failed to get chat', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to get chat' });
  }
});

/**
 * PATCH /api/chats/:id
 * Update chat properties (archive, pin, mute).
 */
chatRouter.patch('/:id', async (req, res) => {
  try {
    const schema = z.object({
      isArchived: z.boolean().optional(),
      isPinned: z.boolean().optional(),
      mutedUntil: z.string().datetime().nullable().optional(),
      name: z.string().max(255).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const chat = await chatService.updateChat(req.user!.orgId, req.params.id, {
      ...parsed.data,
      mutedUntil: parsed.data.mutedUntil ? new Date(parsed.data.mutedUntil) : parsed.data.mutedUntil === null ? null : undefined,
    });

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    return res.json(chat);
  } catch (err) {
    logger.error('Failed to update chat', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to update chat' });
  }
});

/**
 * POST /api/chats/:id/read
 * Mark all messages in a chat as read.
 */
chatRouter.post('/:id/read', async (req, res) => {
  try {
    await chatService.markAsRead(req.user!.orgId, req.params.id);
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to mark chat as read', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to mark as read' });
  }
});

/**
 * DELETE /api/chats/:id
 * Delete a chat.
 */
chatRouter.delete('/:id', async (req, res) => {
  try {
    await chatService.deleteChat(req.user!.orgId, req.params.id);
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete chat', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to delete chat' });
  }
});
