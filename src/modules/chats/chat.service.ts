/**
 * Chat Service — CRUD, upsert from WhatsApp sync, chat list with pagination.
 * All queries scoped by orgId for multi-tenant isolation.
 */

import {
  contactDisplayNameSubquery,
  contactPushNameSubquery,
  resolveChatDisplayName,
  lookupContactNamesForChat,
  CONTACT_DISPLAY_NAME_SUBQUERY_SQL,
} from './contact-name-sql.js';
import { db } from '../../config/database.js';
import { chats, contacts, messages, sessions, chatReadEvents, users } from '../../db/schema.js';
import { eq, and, desc, lt, sql, ne, notLike, or, isNull, gte, lte } from 'drizzle-orm';
import { logger } from '../../observability/logger.js';
import { resolveLidJid } from '../sessions/lid-mapping.js';
import { normalizeJid } from '../sessions/session.events.js';
import type { Chat, ChatListQuery, ChatListResponse, ChatUpdatePayload } from './chat.types.js';
import { eventBus, STREAMS } from '../../events/event-bus.js';
import { redis } from '../../config/redis.js';

export class ChatService {
  /**
   * Upsert a chat from WhatsApp sync data.
   * Uses ON CONFLICT (sessionId, waChatId) for idempotent sync.
   */
  async upsertChat(data: {
    orgId: string;
    sessionId: string;
    waChatId: string;
    chatType: 'private' | 'group';
    name: string | null;
    avatarUrl?: string | null;
    unreadCount?: number;
    isArchived?: boolean;
    isPinned?: boolean;
    mutedUntil?: Date | null;
    lastMessagePreview?: string | null;
    lastMessageAt?: Date | null;
    metadata?: Record<string, unknown>;
    isHistorySync?: boolean;
  }): Promise<Chat | null> {
    // BUG 2: Exclude WhatsApp Status broadcast threads
    const resolvedJid = await resolveLidJid(data.sessionId, data.waChatId);
    const normalizedChatJid = normalizeJid(resolvedJid);

    // EXCLUDE: Exclude WhatsApp Status broadcast & official Channel/Newsletter threads to prevent syncing them
    if (
      normalizedChatJid.endsWith('@broadcast') ||
      normalizedChatJid.endsWith('@newsletter') ||
      normalizedChatJid === 'status'
    ) {
      return null;
    }

    logger.info('[DEBUG UNREAD] chat.service.ts upsertChat starting', {
      sessionId: data.sessionId,
      waChatId: normalizedChatJid,
      inputUnreadCount: data.unreadCount,
      isHistorySync: data.isHistorySync,
    });

    const [result] = await db
      .insert(chats)
      .values({
        orgId: data.orgId,
        sessionId: data.sessionId,
        waChatId: normalizedChatJid,
        chatType: data.chatType,
        name: data.name,
        avatarUrl: data.avatarUrl ?? null,
        unreadCount: data.unreadCount ?? 0,
        isArchived: data.isArchived ?? false,
        isPinned: data.isPinned ?? false,
        mutedUntil: data.mutedUntil ?? null,
        lastMessagePreview: data.lastMessagePreview ?? null,
        lastMessageAt: data.lastMessageAt ?? null,
        metadata: data.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: [chats.sessionId, chats.waChatId],
        set: {
          name: data.name ?? sql`chats.name`,
          avatarUrl: data.avatarUrl ?? undefined,
          unreadCount: (data.isHistorySync || data.unreadCount === 0) ? (data.unreadCount ?? undefined) : undefined,
          isArchived: data.isArchived ?? undefined,
          isPinned: data.isPinned ?? undefined,
          mutedUntil: data.mutedUntil ?? undefined,
          lastMessageAt: data.lastMessageAt ?? undefined,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (result) {
      logger.info('[DEBUG UNREAD] chat.service.ts upsertChat completed', {
        sessionId: result.sessionId,
        waChatId: result.waChatId,
        dbUnreadCount: result.unreadCount,
      });
    }

    return result as Chat;
  }

  /**
   * Ensure a chat exists for a given WA JID, creating it if necessary.
   * Returns the chat UUID. Used during history sync and message processing.
   */
  async ensureChatExists(
    orgId: string,
    sessionId: string,
    waChatJid: string
  ): Promise<string | null> {
    const resolvedJid = await resolveLidJid(sessionId, waChatJid);
    const normalizedChatJid = normalizeJid(resolvedJid);

    // EXCLUDE: Exclude WhatsApp Status broadcast & official Channel/Newsletter threads to prevent syncing them
    if (
      normalizedChatJid.endsWith('@broadcast') ||
      normalizedChatJid.endsWith('@newsletter') ||
      normalizedChatJid === 'status'
    ) {
      return null;
    }

    try {
      // Try to find existing chat
      const [existing] = await db
        .select({ id: chats.id })
        .from(chats)
        .where(
          and(
            eq(chats.orgId, orgId),
            eq(chats.sessionId, sessionId),
            eq(chats.waChatId, normalizedChatJid)
          )
        )
        .limit(1);

      if (existing) return existing.id;

      // Create new chat
      const chatType = normalizedChatJid.endsWith('@g.us') ? 'group' : 'private';
      const [created] = await db
        .insert(chats)
        .values({
          orgId,
          sessionId,
          waChatId: normalizedChatJid,
          chatType,
          name: null,
        })
        .onConflictDoNothing({ target: [chats.sessionId, chats.waChatId] })
        .returning({ id: chats.id });

      if (created) return created.id;

      // Race condition: another request created it between our SELECT and INSERT
      const [raceResult] = await db
        .select({ id: chats.id })
        .from(chats)
        .where(
          and(
            eq(chats.orgId, orgId),
            eq(chats.sessionId, sessionId),
            eq(chats.waChatId, normalizedChatJid)
          )
        )
        .limit(1);

      return raceResult?.id ?? null;
    } catch (err) {
      logger.error('Failed to ensure chat exists', {
        sessionId,
        waChatJid: normalizedChatJid,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * Get chat list for a session, sorted by last message time.
   * Uses cursor-based pagination on lastMessageAt.
   */
  async getChatList(
    orgId: string,
    query: ChatListQuery,
    user: { userId: string; role: 'admin' | 'agent'; hasAllSessionsAccess: boolean }
  ): Promise<ChatListResponse> {
    const limit = Math.min(query.limit ?? 50, 100);
    const fetchLimit = limit + 1;

    const conditions = [
      eq(chats.orgId, orgId),
      eq(chats.sessionId, query.sessionId),
      // EXCLUDE: Filter out any chat ending with @broadcast, @newsletter, or named status
      notLike(chats.waChatId, '%@broadcast'),
      notLike(chats.waChatId, '%@newsletter'),
      ne(chats.waChatId, 'status'),
    ];

    if (query.archived !== undefined) {
      conditions.push(eq(chats.isArchived, query.archived));
    }

    if (query.cursor) {
      conditions.push(
        sql`chats.last_message_at < ${query.cursor}::timestamptz`
      );
    }

    if (user.role !== 'admin') {
      const orCond = or(
        eq(chats.assignedToUserId, user.userId),
        isNull(chats.assignedToUserId)
      );
      if (orCond) {
        conditions.push(orCond);
      }
    }

    const rows = await db
      .select({
        id: chats.id,
        orgId: chats.orgId,
        sessionId: chats.sessionId,
        waChatId: chats.waChatId,
        chatType: chats.chatType,
        name: chats.name,
        avatarUrl: chats.avatarUrl,
        unreadCount: chats.unreadCount,
        isArchived: chats.isArchived,
        isPinned: chats.isPinned,
        mutedUntil: chats.mutedUntil,
        lastMessagePreview: chats.lastMessagePreview,
        lastMessageAt: chats.lastMessageAt,
        metadata: chats.metadata,
        assignedToUserId: chats.assignedToUserId,
        createdAt: chats.createdAt,
        updatedAt: chats.updatedAt,
        contactName: contacts.displayName,
        contactPushName: contacts.pushName,
      })
      .from(chats)
      .leftJoin(
        contacts,
        and(
          eq(chats.sessionId, contacts.sessionId),
          eq(chats.waChatId, contacts.waId)
        )
      )
      .where(and(...conditions))
      .orderBy(
        desc(chats.isPinned),
        sql`COALESCE(${chats.lastMessageAt}, ${chats.createdAt}) DESC`
      )
      .limit(fetchLimit);

    const hasMore = rows.length > limit;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;

    const nextCursor =
      hasMore && resultRows.length > 0 && resultRows[resultRows.length - 1].lastMessageAt
        ? resultRows[resultRows.length - 1].lastMessageAt!.toISOString()
        : null;

    const mappedChats = resultRows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      sessionId: r.sessionId,
      waChatId: r.waChatId,
      chatType: r.chatType,
      name: r.contactName ?? r.contactPushName ?? r.name ?? null,
      avatarUrl: r.avatarUrl,
      unreadCount: r.unreadCount,
      isArchived: r.isArchived,
      isPinned: r.isPinned,
      mutedUntil: r.mutedUntil,
      lastMessagePreview: r.lastMessagePreview,
      lastMessageAt: r.lastMessageAt,
      metadata: r.metadata,
      assignedToUserId: r.assignedToUserId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })) as Chat[];

    return {
      chats: mappedChats,
      nextCursor,
      hasMore,
    };
  }

  /**
   * Get a single chat by ID.
   */
  async getChatById(orgId: string, chatId: string): Promise<Chat | null> {
    const [result] = await db
      .select({
        id: chats.id,
        orgId: chats.orgId,
        sessionId: chats.sessionId,
        waChatId: chats.waChatId,
        chatType: chats.chatType,
        name: chats.name,
        avatarUrl: chats.avatarUrl,
        unreadCount: chats.unreadCount,
        isArchived: chats.isArchived,
        isPinned: chats.isPinned,
        mutedUntil: chats.mutedUntil,
        lastMessagePreview: chats.lastMessagePreview,
        lastMessageAt: chats.lastMessageAt,
        metadata: chats.metadata,
        assignedToUserId: chats.assignedToUserId,
        createdAt: chats.createdAt,
        updatedAt: chats.updatedAt,
        contactName: contacts.displayName,
        contactPushName: contacts.pushName,
      })
      .from(chats)
      .leftJoin(
        contacts,
        and(
          eq(chats.sessionId, contacts.sessionId),
          eq(chats.waChatId, contacts.waId)
        )
      )
      .where(and(eq(chats.orgId, orgId), eq(chats.id, chatId)))
      .limit(1);

    if (!result) return null;

    return {
      id: result.id,
      orgId: result.orgId,
      sessionId: result.sessionId,
      waChatId: result.waChatId,
      chatType: result.chatType,
      name: result.contactName ?? result.contactPushName ?? result.name ?? null,
      avatarUrl: result.avatarUrl,
      unreadCount: result.unreadCount,
      isArchived: result.isArchived,
      isPinned: result.isPinned,
      mutedUntil: result.mutedUntil,
      lastMessagePreview: result.lastMessagePreview,
      lastMessageAt: result.lastMessageAt,
      metadata: result.metadata,
      assignedToUserId: result.assignedToUserId,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    } as Chat;
  }

  /**
   * Helper method to verify if a user has permission to access a chat.
   */
  async hasChatAccess(
    orgId: string,
    chatId: string,
    user: { userId: string; role: 'admin' | 'agent'; hasAllSessionsAccess: boolean }
  ): Promise<boolean> {
    if (user.role === 'admin') return true;

    // Fetch the chat to see its sessionId and assignedToUserId
    const [chatRecord] = await db
      .select({
        sessionId: chats.sessionId,
        assignedToUserId: chats.assignedToUserId,
      })
      .from(chats)
      .where(and(eq(chats.orgId, orgId), eq(chats.id, chatId)))
      .limit(1);

    if (!chatRecord) return false;

    // Check Level 1: Session access
    if (!user.hasAllSessionsAccess) {
      const { userSessionAccess } = await import('../../db/schema.js');
      const [access] = await db
        .select({ id: userSessionAccess.id })
        .from(userSessionAccess)
        .where(
          and(
            eq(userSessionAccess.userId, user.userId),
            eq(userSessionAccess.sessionId, chatRecord.sessionId)
          )
        )
        .limit(1);
      
      if (!access) return false;
    }

    // Check Level 2: Chat assignment
    if (chatRecord.assignedToUserId !== null && chatRecord.assignedToUserId !== user.userId) {
      return false;
    }

    return true;
  }

  /**
   * Update chat properties (archive, pin, mute, mark as read).
   */
  async updateChat(orgId: string, chatId: string, data: Partial<ChatUpdatePayload>): Promise<Chat | null> {
    const updateData: Record<string, any> = { updatedAt: new Date() };

    if (data.unreadCount !== undefined) updateData.unreadCount = data.unreadCount;
    if (data.isArchived !== undefined) updateData.isArchived = data.isArchived;
    if (data.isPinned !== undefined) updateData.isPinned = data.isPinned;
    if (data.mutedUntil !== undefined) updateData.mutedUntil = data.mutedUntil;
    if (data.name !== undefined) updateData.name = data.name;
    if (data.avatarUrl !== undefined) updateData.avatarUrl = data.avatarUrl;
    if (data.assignedToUserId !== undefined) updateData.assignedToUserId = data.assignedToUserId;

    const [result] = await db
      .update(chats)
      .set(updateData)
      .where(and(eq(chats.orgId, orgId), eq(chats.id, chatId)))
      .returning();

    return (result as Chat) ?? null;
  }

  /**
   * Mark all messages in a chat as read: DB update, audit log, WebSocket broadcast, and Baileys read receipt.
   */
  async markChatAsRead(
    orgId: string,
    chatId: string,
    options: {
      userId?: string | null;
      trigger: 'manual' | 'reply';
      reason?: string;
      skipBaileys?: boolean;
      skipAudit?: boolean;
    },
  ): Promise<Chat | null> {
    const chat = await this.getChatById(orgId, chatId);
    if (!chat) return null;

    logger.info('[DEBUG UNREAD] chat.service.ts markChatAsRead called', {
      orgId,
      chatId,
      trigger: options.trigger,
      userId: options.userId,
    });

    await db
      .update(chats)
      .set({ unreadCount: 0, updatedAt: new Date() })
      .where(and(eq(chats.orgId, orgId), eq(chats.id, chatId)));

    if (!options.skipAudit) {
      await db.insert(chatReadEvents).values({
        orgId,
        sessionId: chat.sessionId,
        chatId,
        userId: options.userId ?? null,
        trigger: options.trigger,
        reason: options.reason ?? null,
      });
    }

    const updatedChat = await this.getChatById(orgId, chatId);

    if (updatedChat) {
      await eventBus.publishToStream(STREAMS.CHATS, 'chat:update', {
        sessionId: chat.sessionId,
        orgId,
        chat: updatedChat,
      });
    }

    if (!options.skipBaileys) {
      await this.enqueueMarkReadOnWhatsApp(chat.sessionId, chat.waChatId, chatId);
    }

    return updatedChat;
  }

  /**
   * @deprecated Use markChatAsRead instead.
   */
  async markAsRead(orgId: string, chatId: string): Promise<void> {
    await this.markChatAsRead(orgId, chatId, {
      trigger: 'manual',
      reason: 'Legacy mark-as-read',
      skipAudit: true,
    });
  }

  /**
   * Enqueue a Baileys readMessages call on the session control worker.
   */
  private async enqueueMarkReadOnWhatsApp(
    sessionId: string,
    waChatId: string,
    chatId: string,
  ): Promise<void> {
    try {
      const [lastInboundMsg] = await db
        .select({
          waMessageId: messages.waMessageId,
          senderJid: messages.senderJid,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(and(eq(messages.chatId, chatId), eq(messages.fromMe, false)))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(1);

      if (!lastInboundMsg) {
        logger.info('No inbound messages to mark read on WhatsApp', { sessionId, chatId, waChatId });
        return;
      }

      await eventBus.publishSessionControl(sessionId, 'mark-read', {
        waChatId,
        lastInboundMsg: {
          waMessageId: lastInboundMsg.waMessageId,
          senderJid: lastInboundMsg.senderJid,
          createdAt: lastInboundMsg.createdAt.toISOString(),
        },
      });

      logger.info('Enqueued mark-read command to session runner', {
        sessionId,
        waChatId,
        waMessageId: lastInboundMsg.waMessageId,
      });
    } catch (err) {
      logger.warn('Failed to enqueue mark-read command', {
        chatId,
        sessionId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * List mark-as-read audit events for admin review.
   */
  async listReadEvents(
    orgId: string,
    options: {
      limit?: number;
      cursor?: string;
      sessionId?: string;
      userId?: string;
      chatId?: string;
      from?: Date;
      to?: Date;
    } = {},
  ): Promise<{
    events: Array<{
      id: string;
      createdAt: Date;
      trigger: 'manual' | 'reply';
      reason: string | null;
      user: { id: string; displayName: string | null; email: string } | null;
      chat: { id: string; name: string | null; chatName: string | null; waChatId: string };
      session: { id: string; sessionName: string };
    }>;
    nextCursor: string | null;
  }> {
    const limit = Math.min(options.limit ?? 50, 100);
    const conditions = [eq(chatReadEvents.orgId, orgId)];

    if (options.sessionId) {
      conditions.push(eq(chatReadEvents.sessionId, options.sessionId));
    }
    if (options.userId) {
      conditions.push(eq(chatReadEvents.userId, options.userId));
    }
    if (options.chatId) {
      conditions.push(eq(chatReadEvents.chatId, options.chatId));
    }
    if (options.from) {
      conditions.push(gte(chatReadEvents.createdAt, options.from));
    }
    if (options.to) {
      conditions.push(lte(chatReadEvents.createdAt, options.to));
    }
    if (options.cursor) {
      conditions.push(lt(chatReadEvents.createdAt, new Date(options.cursor)));
    }

    const rows = await db
      .select({
        id: chatReadEvents.id,
        createdAt: chatReadEvents.createdAt,
        trigger: chatReadEvents.trigger,
        reason: chatReadEvents.reason,
        userId: users.id,
        userDisplayName: users.displayName,
        userEmail: users.email,
        chatId: chats.id,
        chatOrgId: chats.orgId,
        chatName: chats.name,
        chatWaChatId: chats.waChatId,
        contactName: contactDisplayNameSubquery,
        contactPushName: contactPushNameSubquery,
        sessionId: sessions.id,
        sessionName: sessions.sessionName,
      })
      .from(chatReadEvents)
      .innerJoin(chats, eq(chatReadEvents.chatId, chats.id))
      .innerJoin(sessions, eq(chatReadEvents.sessionId, sessions.id))
      .leftJoin(users, eq(chatReadEvents.userId, users.id))
      .where(and(...conditions))
      .orderBy(desc(chatReadEvents.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const resolvedRows = await Promise.all(
      page.map(async (row) => {
        const subqueryDisplayName = row.contactName;
        const subqueryPushName = row.contactPushName;
        let contactName = subqueryDisplayName;
        let contactPushName = subqueryPushName;
        let lookupSource: 'subquery' | 'resolveLidJid+db' = 'subquery';

        if (!contactName && !contactPushName) {
          const lookedUp = await lookupContactNamesForChat(
            row.sessionId,
            row.chatOrgId,
            row.chatWaChatId,
          );
          contactName = lookedUp.displayName;
          contactPushName = lookedUp.pushName;
          lookupSource = 'resolveLidJid+db';
        }

        return {
          ...row,
          contactName,
          contactPushName,
          subqueryDisplayName,
          subqueryPushName,
          lookupSource,
        };
      }),
    );

    if (resolvedRows.length > 0) {
      logger.debug('listReadEvents contact name resolution sample', {
        subquerySql: CONTACT_DISPLAY_NAME_SUBQUERY_SQL,
        samples: resolvedRows.slice(0, 5).map((row) => ({
          eventId: row.id,
          chatId: row.chatId,
          waChatId: row.chatWaChatId,
          waChatIdType: row.chatWaChatId.endsWith('@lid')
            ? 'lid'
            : row.chatWaChatId.endsWith('@s.whatsapp.net')
              ? 'phone'
              : 'other',
          chatsName: row.chatName,
          subqueryDisplayName: row.subqueryDisplayName,
          subqueryPushName: row.subqueryPushName,
          lookupSource: row.lookupSource,
          resolvedChatName: resolveChatDisplayName(row.contactName, row.contactPushName, row.chatName),
        })),
      });
    }

    const events = resolvedRows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      trigger: row.trigger as 'manual' | 'reply',
      reason: row.reason,
      user: row.userId
        ? {
            id: row.userId,
            displayName: row.userDisplayName,
            email: row.userEmail!,
          }
        : null,
      chat: {
        id: row.chatId,
        name: resolveChatDisplayName(row.contactName, row.contactPushName, row.chatName),
        chatName: resolveChatDisplayName(row.contactName, row.contactPushName, row.chatName),
        waChatId: row.chatWaChatId,
      },
      session: {
        id: row.sessionId,
        sessionName: row.sessionName,
      },
    }));

    const nextCursor = hasMore
      ? page[page.length - 1]!.createdAt.toISOString()
      : null;

    return { events, nextCursor };
  }

  /**
   * Returns true if the chat is a group (excluded from presence features).
   */
  isGroupChat(chat: { chatType: string; waChatId: string }): boolean {
    return chat.chatType === 'group' || chat.waChatId.endsWith('@g.us');
  }

  /**
   * Read cached presence snapshot from Redis for a 1:1 chat contact.
   */
  async getCachedPresence(
    sessionId: string,
    waChatId: string,
  ): Promise<{
    lastKnownPresence: string;
    lastSeen: number | null;
    updatedAt: number;
  } | null> {
    const candidates = new Set<string>();
    candidates.add(normalizeJid(waChatId));
    try {
      const resolved = await resolveLidJid(sessionId, waChatId);
      candidates.add(normalizeJid(resolved));
    } catch {
      // ignore LID resolution errors
    }

    for (const jid of candidates) {
      const raw = await redis.get(`presence:lookup:${sessionId}:${jid}`);
      if (raw) {
        try {
          return JSON.parse(raw) as {
            lastKnownPresence: string;
            lastSeen: number | null;
            updatedAt: number;
          };
        } catch {
          return null;
        }
      }

      const compositeRaw = await redis.get(`presence:${sessionId}:${jid}:${jid}`);
      if (compositeRaw) {
        try {
          return JSON.parse(compositeRaw) as {
            lastKnownPresence: string;
            lastSeen: number | null;
            updatedAt: number;
          };
        } catch {
          return null;
        }
      }
    }

    return null;
  }

  /**
   * Request live presence updates for a private chat and return any cached snapshot.
   */
  async subscribeChatPresence(
    orgId: string,
    chatId: string,
  ): Promise<{
    chatJid: string;
    presence: {
      lastKnownPresence: string;
      lastSeen: number | null;
      updatedAt: number;
    } | null;
  }> {
    const chat = await this.getChatById(orgId, chatId);
    if (!chat) {
      throw new Error('Chat not found');
    }
    if (this.isGroupChat(chat)) {
      throw new Error('Presence is not available for group chats');
    }

    await eventBus.publishSessionControl(chat.sessionId, 'presence-subscribe', {
      waChatId: chat.waChatId,
    });

    const presence = await this.getCachedPresence(chat.sessionId, chat.waChatId);

    return {
      chatJid: chat.waChatId,
      presence,
    };
  }

  /**
   * Delete a chat and associated data.
   */
  async deleteChat(orgId: string, chatId: string): Promise<void> {
    await db
      .delete(chats)
      .where(and(eq(chats.orgId, orgId), eq(chats.id, chatId)));
  }

  /**
   * BUG 1: Merge a chat and contact that was created with a LID JID into its phone JID.
   * This is triggered asynchronously when a LID-to-phone mapping is discovered/saved.
   */
  async mergeLidChatAndContact(
    sessionId: string,
    lidJid: string,
    phoneJid: string
  ): Promise<void> {
    const normalizedLid = normalizeJid(lidJid.trim());
    const normalizedPhone = normalizeJid(phoneJid.trim());

    logger.info('Starting database merge for LID to Phone JID', { sessionId, lidJid: normalizedLid, phoneJid: normalizedPhone });

    try {
      // First resolve the orgId from the session
      const [sessionRecord] = await db
        .select({ orgId: sessions.orgId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);

      if (!sessionRecord) {
        logger.error('Failed to merge LID chat/contact: Session not found', { sessionId, lidJid, phoneJid });
        return;
      }
      const orgId = sessionRecord.orgId;

      let publishDeleteChatId: string | null = null;
      let publishUpdateChatId: string | null = null;

      await db.transaction(async (tx) => {
        // 1. Merge Contacts
        const [lidContact] = await tx
          .select()
          .from(contacts)
          .where(
            and(
              eq(contacts.orgId, orgId),
              eq(contacts.sessionId, sessionId),
              eq(contacts.waId, normalizedLid)
            )
          )
          .limit(1);

        const [phoneContact] = await tx
          .select()
          .from(contacts)
          .where(
            and(
              eq(contacts.orgId, orgId),
              eq(contacts.sessionId, sessionId),
              eq(contacts.waId, normalizedPhone)
            )
          )
          .limit(1);

        if (lidContact) {
          if (phoneContact) {
            // Update phone contact with lid contact info if phone contact lacks it
            const updateFields: Record<string, any> = {};
            if (!phoneContact.pushName && lidContact.pushName) updateFields.pushName = lidContact.pushName;
            if (!phoneContact.displayName && lidContact.displayName) updateFields.displayName = lidContact.displayName;
            if (!phoneContact.avatarUrl && lidContact.avatarUrl) updateFields.avatarUrl = lidContact.avatarUrl;

            if (Object.keys(updateFields).length > 0) {
              await tx
                .update(contacts)
                .set(updateFields)
                .where(and(eq(contacts.orgId, orgId), eq(contacts.id, phoneContact.id)));
            }

            // Delete lid contact
            await tx.delete(contacts).where(and(eq(contacts.orgId, orgId), eq(contacts.id, lidContact.id)));
            logger.info('Deleted duplicate LID contact and merged metadata', { lidContactId: lidContact.id, phoneContactId: phoneContact.id });
          } else {
            // Simply update lid contact to phone contact
            await tx
              .update(contacts)
              .set({ waId: normalizedPhone, updatedAt: new Date() })
              .where(and(eq(contacts.orgId, orgId), eq(contacts.id, lidContact.id)));
            logger.info('Renamed contact JID from LID to Phone JID', { contactId: lidContact.id, oldJid: normalizedLid, newJid: normalizedPhone });
          }
        }

        // 2. Merge Chats
        const [lidChat] = await tx
          .select()
          .from(chats)
          .where(
            and(
              eq(chats.orgId, orgId),
              eq(chats.sessionId, sessionId),
              eq(chats.waChatId, normalizedLid)
            )
          )
          .limit(1);

        const [phoneChat] = await tx
          .select()
          .from(chats)
          .where(
            and(
              eq(chats.orgId, orgId),
              eq(chats.sessionId, sessionId),
              eq(chats.waChatId, normalizedPhone)
            )
          )
          .limit(1);

        if (lidChat) {
          if (phoneChat) {
            // Move messages that do not conflict.
            // Delete messages from lidChat that have the same waMessageId in phoneChat to avoid unique constraint violations
            await tx.execute(sql`
              DELETE FROM messages 
              WHERE org_id = ${orgId}
                AND chat_id = ${lidChat.id} 
                AND wa_message_id IN (
                  SELECT wa_message_id FROM messages WHERE org_id = ${orgId} AND chat_id = ${phoneChat.id}
                )
            `);

            // Safely move remaining messages
            await tx
              .update(messages)
              .set({ chatId: phoneChat.id, updatedAt: new Date() })
              .where(and(eq(messages.orgId, orgId), eq(messages.chatId, lidChat.id)));

            // Merge unread count, lastMessageAt, lastMessagePreview
            const newUnreadCount = (phoneChat.unreadCount || 0) + (lidChat.unreadCount || 0);
            const newLastMessageAt =
              lidChat.lastMessageAt && (!phoneChat.lastMessageAt || lidChat.lastMessageAt > phoneChat.lastMessageAt)
                ? lidChat.lastMessageAt
                : phoneChat.lastMessageAt;
            const newLastMessagePreview =
              lidChat.lastMessageAt && (!phoneChat.lastMessageAt || lidChat.lastMessageAt > phoneChat.lastMessageAt)
                ? lidChat.lastMessagePreview
                : phoneChat.lastMessagePreview;

            await tx
              .update(chats)
              .set({
                unreadCount: newUnreadCount,
                lastMessageAt: newLastMessageAt,
                lastMessagePreview: newLastMessagePreview,
                updatedAt: new Date(),
              })
              .where(and(eq(chats.orgId, orgId), eq(chats.id, phoneChat.id)));

            // Delete lidChat
            await tx.delete(chats).where(and(eq(chats.orgId, orgId), eq(chats.id, lidChat.id)));
            logger.info('Merged LID chat messages and metadata, deleted LID chat', { lidChatId: lidChat.id, phoneChatId: phoneChat.id });

            publishDeleteChatId = lidChat.id;
            publishUpdateChatId = phoneChat.id;
          } else {
            // Simply update lidChat to phoneChat
            await tx
              .update(chats)
              .set({ waChatId: normalizedPhone, updatedAt: new Date() })
              .where(and(eq(chats.orgId, orgId), eq(chats.id, lidChat.id)));
            logger.info('Renamed chat JID from LID to Phone JID', { chatId: lidChat.id, oldJid: normalizedLid, newJid: normalizedPhone });

            publishUpdateChatId = lidChat.id;
          }
        }
      });

      // Broadcast changes after transaction successfully committed
      if (publishDeleteChatId) {
        await eventBus.publishToStream(STREAMS.CHATS, 'chat:delete', {
          sessionId,
          orgId,
          chatId: publishDeleteChatId,
          waChatId: normalizedLid,
          mergedIntoChatId: publishUpdateChatId,
        }).catch((err) => logger.error('Failed to publish chat delete after merge', { error: err.message }));
      }

      if (publishUpdateChatId) {
        const resolvedChat = await this.getChatById(orgId, publishUpdateChatId);
        if (resolvedChat) {
          await eventBus.publishToStream(STREAMS.CHATS, 'chat:update', {
            sessionId,
            orgId,
            chat: resolvedChat,
          }).catch((err) => logger.error('Failed to publish chat update after merge', { error: err.message }));
        }
      }

      logger.info('Successfully merged LID chat/contact and synchronized history', { sessionId, lidJid, phoneJid });
    } catch (err) {
      logger.error('Failed to merge LID chat/contact', { sessionId, lidJid, phoneJid, error: (err as Error).message });
    }
  }
}

export const chatService = new ChatService();
