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
        lid?: string;
        phoneNumber?: string;
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
      chunkOrder?: number;
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

    // Track progress in Redis and DB atomically to prevent race conditions from concurrent workers
    const progressKey = `sync:progress:${sessionId}`;
    const totalKey = `sync:chunks:total:${sessionId}`;
    const processedKey = `sync:chunks:processed:${sessionId}`;
    const chunkKey = `${data.syncType ?? 0}_${data.chunkOrder ?? 0}_${data.messages?.[0]?.key?.id || 'empty'}`;

    // Set chunk total messages atomically and fetch global totals (idempotent, retries don't double count)
    await redis.hset(totalKey, chunkKey, data.messages.length.toString());
    const totals = await redis.hvals(totalKey);
    const totalMessages = totals.reduce((sum, val) => sum + (parseInt(val) || 0), 0);

    const processeds = await redis.hvals(processedKey);
    const processedMessages = processeds.reduce((sum, val) => sum + (parseInt(val) || 0), 0);

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

    // Also extract mappings from contacts list (since Baileys often includes lid/phoneNumber mappings there)
    if (data.contacts && Array.isArray(data.contacts)) {
      let contactMappingsCount = 0;
      for (const contact of data.contacts) {
        try {
          const waId = contact.id;
          const lid = contact.lid;
          if (waId && lid) {
            await saveLidMapping(sessionId, lid, waId);
            contactMappingsCount++;
          } else if (waId) {
            const phoneJid = contact.phoneNumber;
            if (phoneJid) {
              await saveLidMapping(sessionId, waId, phoneJid);
              contactMappingsCount++;
            }
          }
        } catch (err) {
          // Ignore errors for individual contacts
        }
      }
      if (contactMappingsCount > 0) {
        logger.info('Extracted LID mappings from history sync contacts', { sessionId, count: contactMappingsCount });
      }
    }

    // 1. Sync chats first (messages reference them)
    let chatsSynced = 0;
    for (const chat of data.chats) {
      try {
        const resolvedChatJid = await resolveLidJid(sessionId, chat.id);
        const normalizedChatJid = normalizeJid(resolvedChatJid);

        // EXCLUDE: Skip status, broadcast, and newsletter chats
        if (
          normalizedChatJid.endsWith('@broadcast') ||
          normalizedChatJid.endsWith('@newsletter') ||
          normalizedChatJid === 'status'
        ) {
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
          isHistorySync: true,
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

        // EXCLUDE: Skip newsletter contacts
        if (normalizedWaId.endsWith('@newsletter')) {
          continue;
        }

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

      // EXCLUDE: Skip status, broadcast, and newsletter messages
      if (
        normalizedRemoteJid.endsWith('@broadcast') ||
        normalizedRemoteJid.endsWith('@newsletter') ||
        normalizedRemoteJid === 'status'
      ) continue;

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

      // EXCLUDE: Skip status, broadcast, and newsletter messages
      if (
        normalizedRemoteJid.endsWith('@broadcast') ||
        normalizedRemoteJid.endsWith('@newsletter') ||
        normalizedRemoteJid === 'status'
      ) {
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

    // Update last message preview and last message at for the chats in this sync chunk
    if (messagesToInsert.length > 0) {
      const latestMessagesMap = new Map<string, { content: string | null; messageType: string; metadata?: any; createdAt: Date }>();
      for (const msg of messagesToInsert) {
        const existing = latestMessagesMap.get(msg.chatId);
        if (!existing || msg.createdAt > existing.createdAt) {
          latestMessagesMap.set(msg.chatId, {
            content: msg.content,
            messageType: msg.messageType,
            metadata: msg.metadata,
            createdAt: msg.createdAt,
          });
        }
      }

      for (const [chatId, lastMsg] of latestMessagesMap.entries()) {
        try {
          const [chatRecord] = await db
            .select({ lastMessageAt: chats.lastMessageAt })
            .from(chats)
            .where(eq(chats.id, chatId))
            .limit(1);
          
          if (chatRecord && (!chatRecord.lastMessageAt || lastMsg.createdAt > chatRecord.lastMessageAt)) {
            // Generate type-aware preview (matches DB trigger and frontend logic)
            let preview: string | null = null;
            const ct = lastMsg.content;
            switch (lastMsg.messageType) {
              case 'image':    preview = ct ? `📷 ${ct.substring(0, 190)}` : '📷 Photo'; break;
              case 'video':    preview = ct ? `🎬 ${ct.substring(0, 190)}` : '🎬 Video'; break;
              case 'audio':    preview = '🎤 Voice message'; break;
              case 'document': {
                const fn = (lastMsg.metadata as any)?.waMessage?.message?.documentMessage?.fileName || ct || 'Document';
                preview = `📄 ${fn.substring(0, 190)}`;
                break;
              }
              case 'sticker':  preview = '🎭 Sticker'; break;
              case 'location': preview = '📍 Location'; break;
              case 'contact':  preview = '👤 Contact'; break;
              case 'call':     preview = ct ? `📞 ${ct.substring(0, 190)}` : '📞 Call'; break;
              case 'poll':     preview = ct ? `📊 ${ct.substring(0, 190)}` : '📊 Poll'; break;
              case 'reaction': preview = ct ? `${ct.substring(0, 10)} Reaction` : '👍 Reaction'; break;
              case 'system':   preview = null; break;
              default:         preview = ct ? ct.substring(0, 200) : null; break;
            }
            await db
              .update(chats)
              .set({
                lastMessagePreview: preview,
                lastMessageAt: lastMsg.createdAt,
                updatedAt: new Date(),
              })
              .where(eq(chats.id, chatId));
          }
        } catch (err) {
          logger.warn('Failed to update chat last message preview after bulk insert', { chatId, error: (err as Error).message });
        }
      }
    }

    // Update progress atomically to avoid concurrent write race conditions (lost updates)
    // Include duplicates, errors, and skipped messages in processed count to align progress bar with totalMessages
    const processedDelta = messageResult.inserted + messageResult.duplicates + messageResult.errors + skippedMessagesCount;
    await redis.hset(processedKey, chunkKey, processedDelta.toString());

    // Fetch the updated global processed and total counts (idempotent across chunk updates)
    const finalTotals = await redis.hvals(totalKey);
    const finalTotalMessages = finalTotals.reduce((sum, val) => sum + (parseInt(val) || 0), 0);

    const finalProcesseds = await redis.hvals(processedKey);
    const finalProcessedMessages = finalProcesseds.reduce((sum, val) => sum + (parseInt(val) || 0), 0);

    const isCompleted = data.isLatest !== false && (data.syncType === undefined || data.syncType === null || data.syncType === 2 || data.syncType === 3);
    if (isCompleted) {
      await updateSyncProgress(sessionId, 'completed', finalTotalMessages, finalTotalMessages);
      sessionManager.clearSyncTimeout(sessionId);
      
      // Mark history sync as completed in session metadata atomically using JSONB merge with GREATEST expression
      try {
        const completionPayload = {
          historySyncCompleted: true,
          historySyncCompletedAt: new Date().toISOString(),
          syncStatus: 'completed',
        };
        await db
          .update(sessions)
          .set({
            metadata: sql`
              COALESCE(sessions.metadata, '{}'::jsonb) || 
              ${JSON.stringify(completionPayload)}::jsonb || 
              jsonb_build_object(
                'syncTotalMessages', GREATEST(COALESCE((sessions.metadata->>'syncTotalMessages')::int, 0), ${finalTotalMessages}::int),
                'syncProcessedMessages', GREATEST(COALESCE((sessions.metadata->>'syncProcessedMessages')::int, 0), ${finalTotalMessages}::int)
              )
            `,
            updatedAt: new Date(),
          })
          .where(eq(sessions.id, sessionId));
        logger.info('Marked history sync as completed atomically in session metadata', { sessionId });
      } catch (err) {
        logger.error('Failed to update session metadata atomically for history sync completion', { sessionId, error: (err as Error).message });
      }
    } else {
      // Just update the processed messages count
      await updateSyncProgress(sessionId, 'syncing', finalProcessedMessages, finalTotalMessages);
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

      // EXCLUDE: Skip status, broadcast, and newsletter messages
      if (
        normalizedRemoteJid.endsWith('@broadcast') ||
        normalizedRemoteJid.endsWith('@newsletter') ||
        normalizedRemoteJid === 'status'
      ) continue;

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

      // EXCLUDE: Skip status, broadcast, and newsletter messages
      if (
        normalizedRemoteJid.endsWith('@broadcast') ||
        normalizedRemoteJid.endsWith('@newsletter') ||
        normalizedRemoteJid === 'status'
      ) continue;

      const chatId = await chatService.ensureChatExists(orgId, sessionId, normalizedRemoteJid);
      if (!chatId) continue;

      const { type, content } = extractSyncMessageContent(msg);
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
function extractSyncMessageContent(msg: any): { type: string; content: string | null } {
  if (!msg) return { type: 'system', content: null };

  // Check for call stub types (missed calls)
  const stubType = msg.messageStubType;
  if (stubType) {
    if (stubType === 40 || stubType === 'CALL_MISSED_VOICE') {
      return { type: 'call', content: 'Missed voice call' };
    }
    if (stubType === 41 || stubType === 'CALL_MISSED_VIDEO') {
      return { type: 'call', content: 'Missed video call' };
    }
    if (stubType === 45 || stubType === 'CALL_MISSED_GROUP_VOICE') {
      return { type: 'call', content: 'Missed group voice call' };
    }
    if (stubType === 46 || stubType === 'CALL_MISSED_GROUP_VIDEO') {
      return { type: 'call', content: 'Missed group video call' };
    }
  }

  const message = msg.message;
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

  // Call Log message (completed call outcomes)
  if (message.callLogMesssage) {
    const isVideo = message.callLogMesssage.isVideo ?? false;
    const typeStr = isVideo ? 'video' : 'voice';
    let content = `${isVideo ? 'Video' : 'Voice'} call`;

    const outcome = message.callLogMesssage.callOutcome;
    if (outcome === 1 || outcome === 'MISSED') {
      content = `Missed ${typeStr} call`;
    } else if (outcome === 2 || outcome === 'FAILED') {
      content = `Failed ${typeStr} call`;
    } else if (outcome === 3 || outcome === 'REJECTED') {
      content = `Declined ${typeStr} call`;
    } else if (outcome === 4 || outcome === 'ACCEPTED_ELSEWHERE') {
      content = `${isVideo ? 'Video' : 'Voice'} call — Accepted on another device`;
    }

    return { type: 'call', content };
  }

  return { type: 'system', content: null };
}

/**
 * Map WhatsApp numeric status to our string status.
 */
function mapWAStatus(status?: number): string {
  switch (status) {
    case 0: return 'failed';
    case 1: return 'pending';
    case 2: return 'sent';
    case 3: return 'delivered';
    case 4: return 'read';
    case 5: return 'read';
    default: return 'sent';
  }
}

export const messageSyncService = new MessageSyncService();
