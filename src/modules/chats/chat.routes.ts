/**
 * Chat Routes — REST API for chat/conversation operations.
 */

import { Router } from 'express';
import { z } from 'zod';
import { chatService } from './chat.service.js';
import { authenticate } from '../auth/auth.middleware.js';
import { logger } from '../../observability/logger.js';
import { db } from '../../config/database.js';
import { messages, users, userSessionAccess, sessions } from '../../db/schema.js';
import { desc, eq, and, or, sql } from 'drizzle-orm';
import { wsServer } from '../../websocket/ws-server.js';
import { eventBus } from '../../events/event-bus.js';

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

    // Verify that the session belongs to the user's organization
    const [sessionRecord] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, parsed.data.sessionId), eq(sessions.orgId, req.user!.orgId)))
      .limit(1);

    if (!sessionRecord) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (req.user!.role !== 'admin' && !req.user!.hasAllSessionsAccess) {
      const [access] = await db
        .select()
        .from(userSessionAccess)
        .where(
          and(
            eq(userSessionAccess.userId, req.user!.userId),
            eq(userSessionAccess.sessionId, parsed.data.sessionId)
          )
        )
        .limit(1);

      if (!access) {
        return res.status(403).json({ error: 'Access denied: you do not have permission for this WhatsApp session' });
      }
    }

    const result = await chatService.getChatList(req.user!.orgId, parsed.data, req.user!);
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
    const hasAccess = await chatService.hasChatAccess(req.user!.orgId, req.params.id, req.user!);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied: you do not have permission to access this chat' });
    }

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
    const hasAccess = await chatService.hasChatAccess(req.user!.orgId, req.params.id, req.user!);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied: you do not have permission to modify this chat' });
    }

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
    const orgId = req.user!.orgId;
    const chatId = req.params.id;

    const hasAccess = await chatService.hasChatAccess(orgId, chatId, req.user!);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied: you do not have permission to access this chat' });
    }

    // 1. Get the chat details
    const chat = await chatService.getChatById(orgId, chatId);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    // 2. Mark as read in local DB
    await chatService.markAsRead(orgId, chatId);

    // 3. Queue marking as read on WhatsApp via the session control queue
    try {
      // Fetch the last inbound message to pass to chatModify/readMessages
      const [lastInboundMsg] = await db
        .select({
          waMessageId: messages.waMessageId,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.chatId, chatId),
            eq(messages.fromMe, false)
          )
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(1);

      if (lastInboundMsg) {
        await eventBus.publishSessionControl(chat.sessionId, 'mark-read', {
          waChatId: chat.waChatId,
          lastInboundMsg: {
            waMessageId: lastInboundMsg.waMessageId,
            createdAt: lastInboundMsg.createdAt.toISOString(),
          },
        });
        logger.info('Enqueued mark-read command to session runner', { sessionId: chat.sessionId, waChatId: chat.waChatId });
      }
    } catch (err) {
      logger.warn('Failed to enqueue mark-read command', {
        chatId,
        error: (err as Error).message,
      });
    }

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
    const hasAccess = await chatService.hasChatAccess(req.user!.orgId, req.params.id, req.user!);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied: you do not have permission to delete this chat' });
    }

    await chatService.deleteChat(req.user!.orgId, req.params.id);
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete chat', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to delete chat' });
  }
});

/**
 * POST /api/chats/:id/assign
 * Assign/reassign/unassign a chat (Admin only).
 */
chatRouter.post('/:id/assign', async (req, res) => {
  try {
    if (req.user!.role !== 'admin') {
      return res.status(403).json({ error: 'Only administrators can assign chats' });
    }

    const schema = z.object({
      userId: z.string().uuid().nullable(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const chatId = req.params.id;
    const orgId = req.user!.orgId;

    // Verify the chat exists
    const chat = await chatService.getChatById(orgId, chatId);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const updatedChat = await chatService.updateChat(orgId, chatId, {
      chatId,
      assignedToUserId: parsed.data.userId,
    });

    // Invalidate WS server assignee cache immediately
    wsServer.invalidateChatAssignee(chatId);

    return res.json({ success: true, chat: updatedChat });
  } catch (err) {
    logger.error('Failed to assign chat', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to assign chat' });
  }
});

/**
 * GET /api/chats/:id/eligible-assignees
 * Get active members who are eligible to be assigned to this chat.
 */
chatRouter.get('/:id/eligible-assignees', async (req, res) => {
  try {
    const chatId = req.params.id;
    const orgId = req.user!.orgId;

    const chat = await chatService.getChatById(orgId, chatId);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const eligibleUsers = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        role: users.role,
      })
      .from(users)
      .leftJoin(
        userSessionAccess,
        and(
          eq(users.id, userSessionAccess.userId),
          eq(userSessionAccess.sessionId, chat.sessionId)
        )
      )
      .where(
        and(
          eq(users.orgId, orgId),
          eq(users.isActive, true),
          or(
            eq(users.role, 'admin'),
            eq(users.hasAllSessionsAccess, true),
            sql`${userSessionAccess.id} IS NOT NULL`
          )
        )
      );

    return res.json({ success: true, data: eligibleUsers });
  } catch (err) {
    logger.error('Failed to get eligible assignees', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to get eligible assignees' });
  }
});
