/**
 * Message History Sync — processes Baileys history sync events and bulk-inserts to DB.
 * Handles deduplication, chat/contact creation, and progress tracking via Redis.
 */

import { db } from '../../config/database.js';
import { messages, chats, contacts, sessions } from '../../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { redis } from '../../config/redis.js';
import { messageService } from './message.service.js';
import { chatService } from '../chats/chat.service.js';
import { contactService } from '../contacts/contact.service.js';
import { logger } from '../../observability/logger.js';
import { normalizeJid } from '../sessions/session.events.js';
import { saveLidMapping, resolveLidJid } from '../sessions/lid-mapping.js';
import { updateSyncProgress, sessionManager } from '../sessions/session.manager.js';
import type { BulkInsertResult } from './message.types.js';

/** Redis key for tracking sync progress per session */
function syncProgressKey(sessionId: string): string {
  return `sync:progress:${sessionId}`;
}

export class MessageSyncService {
  /**
   * Process a full history sync event from Baileys.
   * Called when `messaging-history.set` fires during initial device linking.
   */
  async processHistorySync(
    sessionId: string,
    orgId: string,
    data: {
      chats: Array<{
        id: string;
        name?: string;
        unreadCount?: number;
        conversationTimestamp?: number;
        muteEndTime?: number;
        archived?: boolean;
        pinned?: number;
      }>;
      contacts: Array<{
        id: string;
        name?: string;
        notify?: string;
        imgUrl?: string;
      }>;
      messages: Array<{
        key: { remoteJid: string; fromMe: boolean; id: string; participant?: string };
        message?: any;
        messageTimestamp?: number | Long;
        pushName?: string;
        status?: number;
      }>;
      lidPnMappings?: Array<{
        pn: string;
        lid: string;
      }>;
      isLatest?: boolean;
      syncType: number;
    }
  ): Promise<{ chats: number; contacts: number; messages: BulkInsertResult }> {
    logger.info('Processing history sync', {
      sessionId,
      chatCount: data.chats.length,
      contactCount: data.contacts.length,
      messageCount: data.messages.length,
      syncType: data.syncType,
      isLatest: data.isLatest,
    });

    // Track progress in Redis and DB
    const progressKey = `sync:progress:${sessionId}`;
    const currentProgress = await redis.hgetall(progressKey);
    let totalMessages = data.messages.length;
    let processedMessages = 0;

    if (currentProgress && currentProgress.syncTotalMessages) {
      totalMessages = (parseInt(currentProgress.syncTotalMessages) || 0) + data.messages.length;
      processedMessages = parseInt(currentProgress.syncProcessedMessages) || 0;
    }

    await updateSyncProgress(sessionId, 'syncing', processedMessages, totalMessages);

    /* BUG 1: Save LID-to-Phone JID mappings first so they are available when processing chats/messages */
    if (data.lidPnMappings && Array.isArray(data.lidPnMappings)) {
      logger.info('Saving history sync LID mappings', { sessionId, count: data.lidPnMappings.length });
      for (const mapping of data.lidPnMappings) {
        if (mapping.lid && mapping.pn) {
          await saveLidMapping(sessionId, mapping.lid, mapping.pn);
        }
      }
    }

    // 1. Sync chats first (messages reference them)
    let chatsSynced = 0;
    for (const chat of data.chats) {
      try {
        const resolvedChatJid = await resolveLidJid(sessionId, chat.id);
        const normalizedChatJid = normalizeJid(resolvedChatJid);

        // Skip status and broadcast chats
        if (normalizedChatJid.endsWith('@broadcast') || normalizedChatJid === 'status') {
          continue;
        }

        const result = await chatService.upsertChat({
          orgId,
          sessionId,
          waChatId: normalizedChatJid,
          chatType: normalizedChatJid.endsWith('@g.us') ? 'group' : 'private',
          name: chat.name ?? null,
          unreadCount: chat.unreadCount ?? 0,
          isArchived: chat.archived ?? false,
          isPinned: (chat.pinned ?? 0) > 0,
          mutedUntil: chat.muteEndTime
            ? new Date(chat.muteEndTime * 1000)
            : null,
          lastMessageAt: chat.conversationTimestamp
            ? new Date(Number(chat.conversationTimestamp) * 1000)
            : null,
        });
        if (result) {
          chatsSynced++;
        }
      } catch (err) {
        logger.warn('Failed to sync chat', { chatId: chat.id, error: (err as Error).message });
      }
    }

    // 2. Sync contacts
    let contactsSynced = 0;
    for (const contact of data.contacts) {
      try {
        const resolvedWaId = await resolveLidJid(sessionId, contact.id);
        const normalizedWaId = normalizeJid(resolvedWaId);

        await contactService.upsertContact({
          orgId,
          sessionId,
          waId: normalizedWaId,
          pushName: contact.notify ?? null,
          displayName: contact.name ?? null,
          avatarUrl: contact.imgUrl ?? null,
        });
        contactsSynced++;
      } catch (err) {
        logger.warn('Failed to sync contact', { contactId: contact.id, error: (err as Error).message });
      }
    }

    // Extract additional contacts (senders and mentioned JIDs) from messages
    const jidToPushNameMap = new Map<string, string | null>();
    const mentionedJidsSet = new Set<string>();

    for (const msg of data.messages) {
      if (!msg.key?.remoteJid || !msg.key?.id) continue;

      const resolvedRemoteJid = await resolveLidJid(sessionId, msg.key.remoteJid);
      const normalizedRemoteJid = normalizeJid(resolvedRemoteJid);

      // Skip status and broadcast messages
      if (normalizedRemoteJid.endsWith('@broadcast') || normalizedRemoteJid === 'status') continue;

      const rawSender = msg.key.fromMe
        ? 'me'
        : msg.key.participant || msg.key.remoteJid;
      
      let senderJid = 'me';
      if (rawSender !== 'me') {
        const resolvedSender = await resolveLidJid(sessionId, rawSender);
        senderJid = normalizeJid(resolvedSender);
      }
      
      if (senderJid && senderJid !== 'me') {
        if (!jidToPushNameMap.has(senderJid)) {
          jidToPushNameMap.set(senderJid, msg.pushName ?? null);
        }
      }

      const contextInfo = msg.message?.extendedTextMessage?.contextInfo
        ?? msg.message?.imageMessage?.contextInfo
        ?? msg.message?.videoMessage?.contextInfo
        ?? msg.message?.audioMessage?.contextInfo
        ?? msg.message?.documentMessage?.contextInfo
        ?? msg.message?.stickerMessage?.contextInfo;
      
      const mentionedJids = contextInfo?.mentionedJid || [];
      for (const jid of mentionedJids) {
        if (jid) {
          const resolvedMention = await resolveLidJid(sessionId, jid);
          mentionedJidsSet.add(normalizeJid(resolvedMention));
        }
      }
    }

    // Upsert senders
    for (const [waId, pushName] of jidToPushNameMap.entries()) {
      try {
        await contactService.upsertContact({
          orgId,
          sessionId,
          waId,
          pushName,
        });
      } catch (err) {
        // Ignore
      }
    }

    // Upsert mentions
    for (const waId of mentionedJidsSet) {
      try {
        await contactService.upsertContact({
          orgId,
          sessionId,
          waId,
        });
      } catch (err) {
        // Ignore
      }
    }

    // 3. Bulk insert messages with dedup
    const messagesToInsert = [];
    let skippedMessagesCount = 0;
    for (const msg of data.messages) {
      if (!msg.key?.remoteJid || !msg.key?.id) {
        skippedMessagesCount++;
        continue;
      }

      const resolvedRemoteJid = await resolveLidJid(sessionId, msg.key.remoteJid);
      const normalizedRemoteJid = normalizeJid(resolvedRemoteJid);

      // Skip status and broadcast messages
      if (normalizedRemoteJid.endsWith('@broadcast') || normalizedRemoteJid === 'status') {
        skippedMessagesCount++;
        continue;
      }

      const chatId = await chatService.ensureChatExists(orgId, sessionId, normalizedRemoteJid);
      if (!chatId) {
        skippedMessagesCount++;
        continue;
      }

      const { type, content } = extractSyncMessageContent(msg.message);
      const timestamp = msg.messageTimestamp
        ? new Date(Number(msg.messageTimestamp) * 1000)
        : new Date();

      const rawSender = msg.key.fromMe
        ? 'me'
        : msg.key.participant || msg.key.remoteJid;
      
      let senderJid = 'me';
      if (rawSender !== 'me') {
        const resolvedSender = await resolveLidJid(sessionId, rawSender);
        senderJid = normalizeJid(resolvedSender);
      }

      messagesToInsert.push({
        sessionId,
        chatId,
        waMessageId: msg.key.id,
        senderJid,
        fromMe: msg.key.fromMe ?? false,
        messageType: type,
        content,
        status: mapWAStatus(msg.status),
        metadata: {
          pushName: msg.pushName ?? null,
          waMessage: msg, // Store raw message for retry
        },
        createdAt: timestamp,
      });
    }

    const messageResult = await messageService.bulkInsert(orgId, messagesToInsert);

    // Update progress
    // Include duplicates, errors, and skipped messages in processed count to align progress bar with totalMessages
    processedMessages += messageResult.inserted + messageResult.duplicates + messageResult.errors + skippedMessagesCount;
    
    const isCompleted = data.isLatest !== false && (data.syncType === undefined || data.syncType === null || data.syncType === 2 || data.syncType === 3);
    if (isCompleted) {
      await updateSyncProgress(sessionId, 'completed', totalMessages, totalMessages);
      sessionManager.clearSyncTimeout(sessionId);
      
      // Mark history sync as completed in session metadata atomically using JSONB merge
      try {
        const completionPayload = {
          historySyncCompleted: true,
          historySyncCompletedAt: new Date().toISOString(),
          syncStatus: 'completed',
        };
        await db
          .update(sessions)
          .set({
            metadata: sql`COALESCE(sessions.metadata, '{}'::jsonb) || ${JSON.stringify(completionPayload)}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(sessions.id, sessionId));
        logger.info('Marked history sync as completed atomically in session metadata', { sessionId });
      } catch (err) {
        logger.error('Failed to update session metadata atomically for history sync completion', { sessionId, error: (err as Error).message });
      }
    } else {
      // Just update the processed messages count
      await updateSyncProgress(sessionId, 'syncing', processedMessages, totalMessages);
      // Reset inactivity timeout since we got progress
      sessionManager.resetSyncTimeout(sessionId, orgId);
    }

    return {
      chats: chatsSynced,
      contacts: contactsSynced,
      messages: messageResult,
    };
  }

  /**
   * Process incremental message history chunks (messages.upsert type 'append').
   */
  async processIncrementalSync(
    sessionId: string,
    orgId: string,
    messageList: Array<any>
  ): Promise<BulkInsertResult> {
    const messagesToInsert = [];

    // Extract unique senders and mentioned JIDs
    const jidToPushNameMap = new Map<string, string | null>();
    const mentionedJidsSet = new Set<string>();

    for (const msg of messageList) {
      if (!msg.key?.remoteJid || !msg.key?.id) continue;

      const resolvedRemoteJid = await resolveLidJid(sessionId, msg.key.remoteJid);
      const normalizedRemoteJid = normalizeJid(resolvedRemoteJid);

      // Skip status and broadcast messages
      if (normalizedRemoteJid.endsWith('@broadcast') || normalizedRemoteJid === 'status') continue;

      const rawSender = msg.key.fromMe
        ? 'me'
        : msg.key.participant || msg.key.remoteJid;
      
      let senderJid = 'me';
      if (rawSender !== 'me') {
        const resolvedSender = await resolveLidJid(sessionId, rawSender);
        senderJid = normalizeJid(resolvedSender);
      }
      
      if (senderJid && senderJid !== 'me') {
        if (!jidToPushNameMap.has(senderJid)) {
          jidToPushNameMap.set(senderJid, msg.pushName ?? null);
        }
      }

      const contextInfo = msg.message?.extendedTextMessage?.contextInfo
        ?? msg.message?.imageMessage?.contextInfo
        ?? msg.message?.videoMessage?.contextInfo
        ?? msg.message?.audioMessage?.contextInfo
        ?? msg.message?.documentMessage?.contextInfo
        ?? msg.message?.stickerMessage?.contextInfo;
      
      const mentionedJids = contextInfo?.mentionedJid || [];
      for (const jid of mentionedJids) {
        if (jid) {
          const resolvedMention = await resolveLidJid(sessionId, jid);
          mentionedJidsSet.add(normalizeJid(resolvedMention));
        }
      }
    }

    // Upsert senders
    for (const [waId, pushName] of jidToPushNameMap.entries()) {
      try {
        await contactService.upsertContact({
          orgId,
          sessionId,
          waId,
          pushName,
        });
      } catch (err) {
        // Ignore
      }
    }

    // Upsert mentions
    for (const waId of mentionedJidsSet) {
      try {
        await contactService.upsertContact({
          orgId,
          sessionId,
          waId,
        });
      } catch (err) {
        // Ignore
      }
    }

    for (const msg of messageList) {
      if (!msg.key?.remoteJid || !msg.key?.id) continue;

      const resolvedRemoteJid = await resolveLidJid(sessionId, msg.key.remoteJid);
      const normalizedRemoteJid = normalizeJid(resolvedRemoteJid);

      // Skip status and broadcast messages
      if (normalizedRemoteJid.endsWith('@broadcast') || normalizedRemoteJid === 'status') continue;

      const chatId = await chatService.ensureChatExists(orgId, sessionId, normalizedRemoteJid);
      if (!chatId) continue;

      const { type, content } = extractSyncMessageContent(msg.message);
      const timestamp = msg.messageTimestamp
        ? new Date(Number(msg.messageTimestamp) * 1000)
        : new Date();

      const rawSender = msg.key.fromMe
        ? 'me'
        : msg.key.participant || msg.key.remoteJid;
      
      let senderJid = 'me';
      if (rawSender !== 'me') {
        const resolvedSender = await resolveLidJid(sessionId, rawSender);
        senderJid = normalizeJid(resolvedSender);
      }

      messagesToInsert.push({
        sessionId,
        chatId,
        waMessageId: msg.key.id,
        senderJid,
        fromMe: msg.key.fromMe ?? false,
        messageType: type,
        content,
        status: 'sent' as const,
        metadata: {
          pushName: msg.pushName ?? null,
          waMessage: msg, // Store raw message for retry
        },
        createdAt: timestamp,
      });
    }

    return messageService.bulkInsert(orgId, messagesToInsert);
  }

  /**
   * Get sync progress for a session.
   */
  async getSyncProgress(sessionId: string): Promise<Record<string, string> | null> {
    const progress = await redis.hgetall(syncProgressKey(sessionId));
    return Object.keys(progress).length > 0 ? progress : null;
  }
}

/**
 * Extract message type and text content from a Baileys WAMessage.
 */
function extractSyncMessageContent(message: any): { type: string; content: string | null } {
  if (!message) return { type: 'system', content: null };

  if (message.conversation) {
    return { type: 'text', content: message.conversation };
  }
  if (message.extendedTextMessage?.text) {
    return { type: 'text', content: message.extendedTextMessage.text };
  }
  if (message.imageMessage) {
    return { type: 'image', content: message.imageMessage.caption ?? null };
  }
  if (message.videoMessage) {
    return { type: 'video', content: message.videoMessage.caption ?? null };
  }
  if (message.audioMessage) {
    return { type: 'audio', content: null };
  }
  if (message.documentMessage) {
    return { type: 'document', content: message.documentMessage.fileName ?? null };
  }
  if (message.stickerMessage) {
    return { type: 'sticker', content: null };
  }
  if (message.locationMessage) {
    return {
      type: 'location',
      content: message.locationMessage.name ?? `${message.locationMessage.degreesLatitude},${message.locationMessage.degreesLongitude}`,
    };
  }
  if (message.contactMessage) {
    return { type: 'contact', content: message.contactMessage.displayName ?? null };
  }
  if (message.reactionMessage) {
    return { type: 'reaction', content: message.reactionMessage.text ?? null };
  }
  if (message.pollCreationMessage || message.pollCreationMessageV3) {
    const poll = message.pollCreationMessage || message.pollCreationMessageV3;
    return { type: 'poll', content: poll.name ?? null };
  }

  return { type: 'system', content: null };
}

/**
 * Map WhatsApp numeric status to our string status.
 */
function mapWAStatus(status?: number): string {
  switch (status) {
    case 0: return 'pending';
    case 1: return 'sent';
    case 2: return 'delivered';
    case 3: return 'read';
    case 4: return 'read';
    default: return 'sent';
  }
}

export const messageSyncService = new MessageSyncService();
