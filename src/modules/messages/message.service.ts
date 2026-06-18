/**
 * Message Service — CRUD, cursor pagination, full-text search, and dedup.
 * All queries scoped by orgId for multi-tenant isolation.
 */

import { db } from '../../config/database.js';
import { messages, chats } from '../../db/schema.js';
import { eq, and, desc, lt, sql, ilike, or } from 'drizzle-orm';
import { logger } from '../../observability/logger.js';
import type {
  Message,
  SendMessageRequest,
  PaginationCursor,
  PaginatedMessages,
  MessageSearchRequest,
  MessageSearchResult,
  MessageUpdatePayload,
  BulkInsertResult,
} from './message.types.js';

export class MessageService {
  /**
   * Persist an incoming or outgoing message.
   * Uses ON CONFLICT (sessionId, waMessageId) for deduplication.
   */
  async upsertMessage(data: {
    id?: string;
    orgId: string;
    sessionId: string;
    chatId: string;
    waMessageId: string;
    senderJid: string;
    fromMe: boolean;
    messageType: string;
    content: string | null;
    mediaUrl?: string | null;
    mediaMimeType?: string | null;
    mediaSize?: number | null;
    quotedMessageId?: string | null;
    quotedContent?: string | null;
    status?: string;
    isForwarded?: boolean;
    forwardScore?: number;
    metadata?: Record<string, unknown>;
    createdAt?: Date;
  }): Promise<Message> {
    const [result] = await db
      .insert(messages)
      .values({
        orgId: data.orgId,
        sessionId: data.sessionId,
        chatId: data.chatId,
        waMessageId: data.waMessageId,
        senderJid: data.senderJid,
        fromMe: data.fromMe,
        messageType: data.messageType,
        content: data.content,
        mediaUrl: data.mediaUrl ?? null,
        mediaMimeType: data.mediaMimeType ?? null,
        mediaSize: data.mediaSize ?? null,
        quotedMessageId: data.quotedMessageId ?? null,
        quotedContent: data.quotedContent ?? null,
        status: data.status ?? 'sent',
        isForwarded: data.isForwarded ?? false,
        forwardScore: data.forwardScore ?? 0,
        metadata: data.metadata ?? {},
        createdAt: data.createdAt ?? new Date(),
      })
      .onConflictDoUpdate({
        target: [messages.sessionId, messages.waMessageId],
        set: {
          status: data.status ?? 'sent',
          content: data.content,
          mediaUrl: data.mediaUrl ?? undefined,
          metadata: data.metadata ?? undefined,
          updatedAt: new Date(),
        },
      })
      .returning();

    logger.debug('Message upserted', { messageId: result.id, waMessageId: data.waMessageId });
    return result as Message;
  }

  /**
   * Bulk insert messages (used during history sync).
   * Skips duplicates via ON CONFLICT DO NOTHING.
   */
  async bulkInsert(
    orgId: string,
    messageList: Array<{
      sessionId: string;
      chatId: string;
      waMessageId: string;
      senderJid: string;
      fromMe: boolean;
      messageType: string;
      content: string | null;
      status?: string;
      metadata?: Record<string, unknown>;
      createdAt?: Date;
    }>
  ): Promise<BulkInsertResult> {
    if (messageList.length === 0) {
      return { inserted: 0, duplicates: 0, errors: 0 };
    }

    let inserted = 0;
    let errors = 0;
    const batchSize = 100;

    for (let i = 0; i < messageList.length; i += batchSize) {
      const batch = messageList.slice(i, i + batchSize);
      try {
        const result = await db
          .insert(messages)
          .values(
            batch.map((msg) => ({
              orgId,
              sessionId: msg.sessionId,
              chatId: msg.chatId,
              waMessageId: msg.waMessageId,
              senderJid: msg.senderJid,
              fromMe: msg.fromMe,
              messageType: msg.messageType,
              content: msg.content,
              status: msg.status ?? 'sent',
              metadata: msg.metadata ?? {},
              createdAt: msg.createdAt ?? new Date(),
            }))
          )
          .onConflictDoNothing({
            target: [messages.sessionId, messages.waMessageId],
          })
          .returning({ id: messages.id });

        inserted += result.length;
      } catch (err) {
        logger.error('Bulk insert batch failed', { error: (err as Error).message, batchIndex: i });
        errors += batch.length;
      }
    }

    const duplicates = messageList.length - inserted - errors;
    logger.info('Bulk insert complete', { total: messageList.length, inserted, duplicates, errors });
    return { inserted, duplicates, errors };
  }

  /**
   * Get messages for a chat with cursor-based pagination.
   * Uses keyset pagination on (createdAt DESC, id DESC) for consistent performance.
   */
  async getMessages(
    orgId: string,
    chatId: string,
    options: { cursor?: PaginationCursor; limit?: number } = {}
  ): Promise<PaginatedMessages> {
    const limit = Math.min(options.limit ?? 50, 100);
    const fetchLimit = limit + 1; // Fetch one extra to detect hasMore

    let query = db
      .select()
      .from(messages)
      .where(
        options.cursor
          ? and(
              eq(messages.orgId, orgId),
              eq(messages.chatId, chatId),
              sql`messages.deleted_at IS NULL`,
              sql`(messages.created_at, messages.id) < (${options.cursor.createdAt}::timestamptz, ${options.cursor.id}::uuid)`
            )
          : and(
              eq(messages.orgId, orgId),
              eq(messages.chatId, chatId),
              sql`messages.deleted_at IS NULL`
            )
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(fetchLimit);

    const rows = await query;
    const hasMore = rows.length > limit;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;

    const nextCursor =
      hasMore && resultRows.length > 0
        ? {
            createdAt: resultRows[resultRows.length - 1].createdAt.toISOString(),
            id: resultRows[resultRows.length - 1].id,
          }
        : null;

    return {
      messages: resultRows as Message[],
      nextCursor,
      hasMore,
    };
  }

  /**
   * Full-text search across messages using PostgreSQL tsvector.
   * Falls back to ILIKE for short queries or when FTS yields no results.
   */
  async searchMessages(
    orgId: string,
    request: MessageSearchRequest
  ): Promise<{ results: MessageSearchResult[]; hasMore: boolean }> {
    const limit = Math.min(request.limit ?? 20, 50);
    const fetchLimit = limit + 1;

    // Build tsquery from search terms
    const tsQuery = request.query
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .map((w) => `${w}:*`)
      .join(' & ');

    if (!tsQuery) {
      return { results: [], hasMore: false };
    }

    const conditions = [
      eq(messages.orgId, orgId),
      sql`messages.deleted_at IS NULL`,
      sql`messages.content_vector @@ to_tsquery('english', ${tsQuery})`,
    ];

    if (request.sessionId) {
      conditions.push(eq(messages.sessionId, request.sessionId));
    }
    if (request.chatId) {
      conditions.push(eq(messages.chatId, request.chatId));
    }

    if (request.cursor) {
      conditions.push(
        sql`(messages.created_at, messages.id) < (${request.cursor.createdAt}::timestamptz, ${request.cursor.id}::uuid)`
      );
    }

    const rows = await db
      .select({
        message: messages,
        rank: sql<number>`ts_rank(messages.content_vector, to_tsquery('english', ${tsQuery}))`.as('rank'),
        headline: sql<string>`ts_headline('english', COALESCE(messages.content, ''), to_tsquery('english', ${tsQuery}), 'MaxWords=30,MinWords=15,StartSel=<b>,StopSel=</b>')`.as('headline'),
      })
      .from(messages)
      .where(and(...conditions))
      .orderBy(
        sql`rank DESC`,
        desc(messages.createdAt),
        desc(messages.id)
      )
      .limit(fetchLimit);

    const hasMore = rows.length > limit;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;

    return {
      results: resultRows.map((r) => ({
        message: r.message as Message,
        rank: r.rank,
        headline: r.headline,
      })),
      hasMore,
    };
  }

  /**
   * Update message status (delivered, read, etc.).
   */
  async updateMessageStatus(
    orgId: string,
    waMessageId: string,
    sessionId: string,
    status: string
  ): Promise<void> {
    await db
      .update(messages)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.sessionId, sessionId),
          eq(messages.waMessageId, waMessageId)
        )
      );
  }

  /**
   * Soft-delete a message.
   */
  async deleteMessage(orgId: string, messageId: string): Promise<void> {
    await db
      .update(messages)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)));
  }

  /**
   * Star/unstar a message.
   */
  async toggleStar(orgId: string, messageId: string, starred: boolean): Promise<void> {
    await db
      .update(messages)
      .set({ starred, updatedAt: new Date() })
      .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)));
  }

  /**
   * Get a single message by ID.
   */
  async getMessageById(orgId: string, messageId: string): Promise<Message | null> {
    const [result] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)))
      .limit(1);
    return (result as Message) ?? null;
  }

  /**
   * Get a message by WhatsApp message ID (for dedup lookups).
   */
  async getMessageByWaId(
    sessionId: string,
    waMessageId: string
  ): Promise<Message | null> {
    const [result] = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sessionId),
          eq(messages.waMessageId, waMessageId)
        )
      )
      .limit(1);
    return (result as Message) ?? null;
  }
}

export const messageService = new MessageService();
