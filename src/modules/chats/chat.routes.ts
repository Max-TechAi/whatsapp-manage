/**
 * Chat Routes — REST API for chat/conversation operations.
 */

import { Router } from 'express';
import { z } from 'zod';
import { chatService } from './chat.service.js';
import { authenticate, requireRole } from '../auth/auth.middleware.js';
import { logger } from '../../observability/logger.js';
import { db } from '../../config/database.js';
import { users, userSessionAccess, sessions, chats, contacts } from '../../db/schema.js';
import { desc, eq, and, or, sql, inArray } from 'drizzle-orm';
import { wsServer } from '../../websocket/ws-server.js';

export const chatRouter = Router();

chatRouter.use(authenticate);

/**
 * GET /api/chats/unified?sessionId=...&limit=50
 * List all chats across allowed sessions, sorted by unreadCount > 0 then recency.
 */
chatRouter.get('/unified', async (req, res) => {
  try {
    const schema = z.object({
      sessionId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    });

    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.flatten() });
    }

    const { sessionId, limit } = parsed.data;

    // 1. Fetch allowed WhatsApp sessions for this user/organization
    let allowedSessionRecords: { id: string; sessionName: string; phoneNumber: string | null }[] = [];

    if (req.user!.role === 'admin' || req.user!.hasAllSessionsAccess) {
      allowedSessionRecords = await db
        .select({
          id: sessions.id,
          sessionName: sessions.sessionName,
          phoneNumber: sessions.phoneNumber,
        })
        .from(sessions)
        .where(eq(sessions.orgId, req.user!.orgId));
    } else {
      allowedSessionRecords = await db
        .select({
          id: sessions.id,
          sessionName: sessions.sessionName,
          phoneNumber: sessions.phoneNumber,
        })
        .from(sessions)
        .innerJoin(userSessionAccess, eq(sessions.id, userSessionAccess.sessionId))
        .where(
          and(
            eq(sessions.orgId, req.user!.orgId),
            eq(userSessionAccess.userId, req.user!.userId)
          )
        );
    }

    if (allowedSessionRecords.length === 0) {
      return res.status(200).json({
        chats: [],
        summary: { unreadChatsCount: 0, totalUnreadMessages: 0 }
      });
    }

    const allowedSessionIds = allowedSessionRecords.map(s => s.id);

    // If a specific sessionId is requested, verify the user has access to it
    if (sessionId) {
      if (!allowedSessionIds.includes(sessionId)) {
        return res.status(403).json({ error: 'Access denied: you do not have permission for this WhatsApp session' });
      }
    }

    const targetSessionIds = sessionId ? [sessionId] : allowedSessionIds;

    // 2. Fetch the unread summary counts (total unread chats & total unread messages sum)
    const [summaryResult] = await db
      .select({
        unreadChatsCount: sql<number>`count(case when ${chats.unreadCount} > 0 then 1 end)`,
        totalUnreadMessages: sql<number>`coalesce(sum(${chats.unreadCount}), 0)`
      })
      .from(chats)
      .where(
        and(
          eq(chats.orgId, req.user!.orgId),
          inArray(chats.sessionId, targetSessionIds),
          eq(chats.isArchived, false)
        )
      );

    // 3. Fetch the sorted chats joined with session metadata
    const chatsList = await db
      .select({
        id: chats.id,
        sessionId: chats.sessionId,
        waChatId: chats.waChatId,
        name: chats.name,
        avatarUrl: chats.avatarUrl,
        unreadCount: chats.unreadCount,
        lastMessagePreview: chats.lastMessagePreview,
        lastMessageAt: chats.lastMessageAt,
        chatType: chats.chatType,
        sessionName: sessions.sessionName,
        phoneNumber: sessions.phoneNumber,
        contactName: sql<string | null>`(
          SELECT ${contacts.displayName} FROM ${contacts}
          WHERE ${contacts.sessionId} = ${chats.sessionId}
            AND (${contacts.waId} = ${chats.waChatId} OR ${contacts.metadata}->>'lid' = ${chats.waChatId})
          ORDER BY CASE WHEN ${contacts.displayName} IS NOT NULL OR ${contacts.pushName} IS NOT NULL THEN 0 ELSE 1 END ASC
          LIMIT 1
        )`,
        contactPushName: sql<string | null>`(
          SELECT ${contacts.pushName} FROM ${contacts}
          WHERE ${contacts.sessionId} = ${chats.sessionId}
            AND (${contacts.waId} = ${chats.waChatId} OR ${contacts.metadata}->>'lid' = ${chats.waChatId})
          ORDER BY CASE WHEN ${contacts.displayName} IS NOT NULL OR ${contacts.pushName} IS NOT NULL THEN 0 ELSE 1 END ASC
          LIMIT 1
        )`,
      })
      .from(chats)
      .innerJoin(sessions, eq(chats.sessionId, sessions.id))
      .where(
        and(
          eq(chats.orgId, req.user!.orgId),
          inArray(chats.sessionId, targetSessionIds),
          eq(chats.isArchived, false)
        )
      )
      .orderBy(
        sql`CASE WHEN ${chats.unreadCount} > 0 THEN 1 ELSE 0 END DESC`,
        desc(chats.unreadCount),
        desc(chats.lastMessageAt),
        desc(chats.id)
      )
      .limit(limit);

    const mappedChats = chatsList.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      waChatId: r.waChatId,
      name: r.contactName ?? r.contactPushName ?? r.name ?? null,
      avatarUrl: r.avatarUrl,
      unreadCount: r.unreadCount,
      lastMessagePreview: r.lastMessagePreview,
      lastMessageAt: r.lastMessageAt,
      chatType: r.chatType,
      sessionName: r.sessionName,
      phoneNumber: r.phoneNumber,
    }));

    return res.status(200).json({
      chats: mappedChats,
      summary: {
        unreadChatsCount: Number(summaryResult?.unreadChatsCount || 0),
        totalUnreadMessages: Number(summaryResult?.totalUnreadMessages || 0),
      }
    });
  } catch (err) {
    logger.error('Failed to retrieve unified inbox chats', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to retrieve unified inbox chats' });
  }
});

/**
 * GET /api/chats/read-events
 * Admin-only audit log of manual and reply-triggered mark-as-read events.
 */
chatRouter.get('/read-events', requireRole('admin'), async (req, res) => {
  try {
    const schema = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().datetime().optional(),
      sessionId: z.string().uuid().optional(),
      userId: z.string().uuid().optional(),
      chatId: z.string().uuid().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    });

    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.flatten() });
    }

    const { limit, cursor, sessionId, userId, chatId, from, to } = parsed.data;

    const result = await chatService.listReadEvents(req.user!.orgId, {
      limit,
      cursor,
      sessionId,
      userId,
      chatId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });

    return res.json({ success: true, ...result });
  } catch (err) {
    logger.error('Failed to list read events', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to list read events' });
  }
});

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
 * GET /api/chats/:id/presence
 * Return cached presence snapshot for a private chat from Redis.
 */
chatRouter.get('/:id/presence', async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const chatId = req.params.id;

    const hasAccess = await chatService.hasChatAccess(orgId, chatId, req.user!);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied: you do not have permission to access this chat' });
    }

    const chat = await chatService.getChatById(orgId, chatId);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    if (chatService.isGroupChat(chat)) {
      return res.status(400).json({ error: 'Presence is not available for group chats' });
    }

    const presence = await chatService.getCachedPresence(chat.sessionId, chat.waChatId);

    return res.json({
      success: true,
      chatJid: chat.waChatId,
      presence,
    });
  } catch (err) {
    logger.error('Failed to get chat presence', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to get chat presence' });
  }
});

/**
 * POST /api/chats/:id/presence/subscribe
 * Subscribe to live presence updates for a private chat (on-demand).
 */
chatRouter.post('/:id/presence/subscribe', async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const chatId = req.params.id;

    const hasAccess = await chatService.hasChatAccess(orgId, chatId, req.user!);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied: you do not have permission to access this chat' });
    }

    const chat = await chatService.getChatById(orgId, chatId);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    if (chatService.isGroupChat(chat)) {
      return res.status(400).json({ error: 'Presence is not available for group chats' });
    }

    const result = await chatService.subscribeChatPresence(orgId, chatId);

    return res.json({
      success: true,
      chatJid: result.chatJid,
      presence: result.presence,
    });
  } catch (err) {
    logger.error('Failed to subscribe to chat presence', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to subscribe to chat presence' });
  }
});

/**
 * POST /api/chats/:id/read
 * Manually mark all messages in a chat as read (requires a reason).
 */
chatRouter.post('/:id/read', async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const chatId = req.params.id;

    const bodySchema = z.object({
      reason: z.string().min(3).max(500),
    });
    const parsedBody = bodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({ error: 'A reason is required (3–500 characters)', details: parsedBody.error.flatten() });
    }

    const hasAccess = await chatService.hasChatAccess(orgId, chatId, req.user!);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied: you do not have permission to access this chat' });
    }

    const chat = await chatService.getChatById(orgId, chatId);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    await chatService.markChatAsRead(orgId, chatId, {
      userId: req.user!.userId,
      trigger: 'manual',
      reason: parsedBody.data.reason,
    });

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
