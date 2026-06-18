/**
 * Chat Service — CRUD, upsert from WhatsApp sync, chat list with pagination.
 * All queries scoped by orgId for multi-tenant isolation.
 */

import { db } from '../../config/database.js';
import { chats, contacts } from '../../db/schema.js';
import { eq, and, desc, lt, sql } from 'drizzle-orm';
import { logger } from '../../observability/logger.js';
import type { Chat, ChatListQuery, ChatListResponse, ChatUpdatePayload } from './chat.types.js';

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
  }): Promise<Chat> {
    const [result] = await db
      .insert(chats)
      .values({
        orgId: data.orgId,
        sessionId: data.sessionId,
        waChatId: data.waChatId,
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
          name: data.name,
          avatarUrl: data.avatarUrl ?? undefined,
          unreadCount: data.unreadCount ?? undefined,
          isArchived: data.isArchived ?? undefined,
          isPinned: data.isPinned ?? undefined,
          mutedUntil: data.mutedUntil ?? undefined,
          lastMessageAt: data.lastMessageAt ?? undefined,
          updatedAt: new Date(),
        },
      })
      .returning();

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
    try {
      // Try to find existing chat
      const [existing] = await db
        .select({ id: chats.id })
        .from(chats)
        .where(and(eq(chats.sessionId, sessionId), eq(chats.waChatId, waChatJid)))
        .limit(1);

      if (existing) return existing.id;

      // Create new chat
      const chatType = waChatJid.endsWith('@g.us') ? 'group' : 'private';
      const [created] = await db
        .insert(chats)
        .values({
          orgId,
          sessionId,
          waChatId: waChatJid,
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
        .where(and(eq(chats.sessionId, sessionId), eq(chats.waChatId, waChatJid)))
        .limit(1);

      return raceResult?.id ?? null;
    } catch (err) {
      logger.error('Failed to ensure chat exists', {
        sessionId,
        waChatJid,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * Get chat list for a session, sorted by last message time.
   * Uses cursor-based pagination on lastMessageAt.
   */
  async getChatList(orgId: string, query: ChatListQuery): Promise<ChatListResponse> {
    const limit = Math.min(query.limit ?? 50, 100);
    const fetchLimit = limit + 1;

    const conditions = [
      eq(chats.orgId, orgId),
      eq(chats.sessionId, query.sessionId),
    ];

    if (query.archived !== undefined) {
      conditions.push(eq(chats.isArchived, query.archived));
    }

    if (query.cursor) {
      conditions.push(
        sql`chats.last_message_at < ${query.cursor}::timestamptz`
      );
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
        desc(chats.lastMessageAt)
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
      name: r.name ?? r.contactName ?? r.contactPushName ?? null,
      avatarUrl: r.avatarUrl,
      unreadCount: r.unreadCount,
      isArchived: r.isArchived,
      isPinned: r.isPinned,
      mutedUntil: r.mutedUntil,
      lastMessagePreview: r.lastMessagePreview,
      lastMessageAt: r.lastMessageAt,
      metadata: r.metadata,
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
      name: result.name ?? result.contactName ?? result.contactPushName ?? null,
      avatarUrl: result.avatarUrl,
      unreadCount: result.unreadCount,
      isArchived: result.isArchived,
      isPinned: result.isPinned,
      mutedUntil: result.mutedUntil,
      lastMessagePreview: result.lastMessagePreview,
      lastMessageAt: result.lastMessageAt,
      metadata: result.metadata,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    } as Chat;
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

    const [result] = await db
      .update(chats)
      .set(updateData)
      .where(and(eq(chats.orgId, orgId), eq(chats.id, chatId)))
      .returning();

    return (result as Chat) ?? null;
  }

  /**
   * Mark all messages in a chat as read (reset unread count).
   */
  async markAsRead(orgId: string, chatId: string): Promise<void> {
    await db
      .update(chats)
      .set({ unreadCount: 0, updatedAt: new Date() })
      .where(and(eq(chats.orgId, orgId), eq(chats.id, chatId)));
  }

  /**
   * Delete a chat and associated data.
   */
  async deleteChat(orgId: string, chatId: string): Promise<void> {
    await db
      .delete(chats)
      .where(and(eq(chats.orgId, orgId), eq(chats.id, chatId)));
  }
}

export const chatService = new ChatService();
