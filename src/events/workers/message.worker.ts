/**
 * Message Worker — processes inbound messages from BullMQ queue.
 * Transforms Baileys WAMessage → DB record, persists, triggers side effects.
 */

import { Worker, Job } from 'bullmq';
import { workerRedis } from '../../config/redis.js';
import { messageService } from '../../modules/messages/message.service.js';
import { chatService } from '../../modules/chats/chat.service.js';
import { contactService } from '../../modules/contacts/contact.service.js';
import { eventBus, QUEUES, STREAMS } from '../event-bus.js';
import { extractMessageContent, getJidType, normalizeJid } from '../../modules/sessions/session.events.js';
import { resolveLidJid } from '../../modules/sessions/lid-mapping.js';
import { logger } from '../../observability/logger.js';

interface InboundMessageJob {
  sessionId: string;
  orgId: string;
  message: any;
  type: 'notify' | 'append';
  receivedAt: string;
}

export function createMessageWorker(): Worker {
  const worker = new Worker<InboundMessageJob>(
    QUEUES.MESSAGE_INBOUND,
    async (job: Job<InboundMessageJob>) => {
      const { sessionId, orgId, message: waMessage, type } = job.data;

      if (!waMessage?.key?.remoteJid || !waMessage?.key?.id) {
        logger.warn('Skipping message without key', { jobId: job.id });
        return;
      }

      logger.info('[DEBUG UNREAD] MessageWorker starting processing', {
        jobId: job.id,
        sessionId,
        waMessageId: waMessage.key.id,
        remoteJid: waMessage.key.remoteJid,
        fromMe: waMessage.key.fromMe,
        type
      });

      const resolvedRemoteJid = await resolveLidJid(sessionId, waMessage.key.remoteJid);
      const remoteJid = normalizeJid(resolvedRemoteJid);

      // Skip status and broadcast messages
      if (remoteJid.endsWith('@broadcast') || remoteJid === 'status') {
        logger.debug('Skipping status/broadcast message inbound job', { remoteJid, waMessageId: waMessage.key.id });
        return;
      }

      const waMessageId = waMessage.key.id;

      // Ensure the chat exists (create if needed)
      const chatId = await chatService.ensureChatExists(orgId, sessionId, remoteJid);
      if (!chatId) {
        throw new Error(`Failed to resolve chat for JID: ${remoteJid}`);
      }

      // Extract message content
      const { type: messageType, content, mediaInfo } = extractMessageContent(waMessage);

      // Extract quoted message info
      const contextInfo = waMessage.message?.extendedTextMessage?.contextInfo
        ?? waMessage.message?.imageMessage?.contextInfo
        ?? waMessage.message?.videoMessage?.contextInfo;

      const quotedWaMessageId = contextInfo?.stanzaId ?? null;
      const quotedContent = contextInfo?.quotedMessage?.conversation
        ?? contextInfo?.quotedMessage?.extendedTextMessage?.text
        ?? null;

      // Parse timestamp
      const timestamp = waMessage.messageTimestamp
        ? new Date(Number(waMessage.messageTimestamp) * 1000)
        : new Date();

      // Determine sender
      const rawSender = waMessage.key.participant || waMessage.key.remoteJid;
      const resolvedSender = await resolveLidJid(sessionId, rawSender);
      const senderJid = waMessage.key.fromMe
        ? 'me'
        : normalizeJid(resolvedSender);

      // Ensure sender contact is updated in database (saved name/pushname resolution)
      if (!waMessage.key.fromMe && senderJid !== 'me') {
        try {
          await contactService.upsertContact({
            orgId,
            sessionId,
            waId: senderJid,
            pushName: waMessage.pushName ?? null,
          });
        } catch (err) {
          logger.warn('Failed to upsert sender contact in message worker', { senderJid, error: (err as Error).message });
        }
      }

      // BUG 1: Upsert mentioned JIDs to ensure they exist in contacts table for name resolution
      const mentionedJids = contextInfo?.mentionedJid || [];
      for (const jid of mentionedJids) {
        if (jid) {
          const resolvedJid = await resolveLidJid(sessionId, jid);
          const normalized = normalizeJid(resolvedJid);
          try {
            await contactService.upsertContact({
              orgId,
              sessionId,
              waId: normalized,
            });
          } catch (err) {
            logger.warn('Failed to upsert mentioned contact in message worker', { jid: normalized, error: (err as Error).message });
          }
        }
      }

      // Check if forwarded
      const isForwarded = !!(
        waMessage.message?.extendedTextMessage?.contextInfo?.isForwarded
        ?? contextInfo?.isForwarded
      );
      const forwardScore = contextInfo?.forwardingScore ?? 0;

      // Upsert message (dedup via ON CONFLICT)
      const dbMessage = await messageService.upsertMessage({
        orgId,
        sessionId,
        chatId,
        waMessageId,
        senderJid,
        fromMe: waMessage.key.fromMe ?? false,
        messageType,
        content,
        mediaMimeType: mediaInfo?.mimeType ?? null,
        mediaSize: mediaInfo?.size ?? null,
        quotedContent,
        status: waMessage.key.fromMe ? 'sent' : 'delivered',
        isForwarded,
        forwardScore,
        metadata: {
          pushName: waMessage.pushName ?? null,
          broadcast: waMessage.broadcast ?? false,
          ...(quotedWaMessageId ? { quotedWaMessageId } : {}),
          waMessage, // Store raw message for retry
        },
        createdAt: timestamp,
      });

      // If media message, enqueue media download
      if (mediaInfo && ['image', 'video', 'audio', 'document', 'sticker'].includes(messageType)) {
        await eventBus.publishMediaDownload(sessionId, orgId, dbMessage.id, waMessage);
      }

      // Publish to Redis Stream for WebSocket broadcast
      if (type === 'notify') {
        logger.info('[DEBUG UNREAD] MessageWorker publishing message:new to Redis Stream', {
          sessionId,
          waMessageId,
          chatId,
          fromMe: waMessage.key.fromMe
        });
        await eventBus.publishToStream(STREAMS.MESSAGES, 'message:new', {
          sessionId,
          orgId,
          chatId,
          message: dbMessage,
        });

        // Publish webhook
        await eventBus.publishWebhookDelivery(orgId, waMessage.key.fromMe ? 'message.sent' : 'message.received', {
          sessionId,
          chatId,
          message: dbMessage,
        });
      }

      logger.debug('Message processed', {
        messageId: dbMessage.id,
        waMessageId,
        type: messageType,
        fromMe: waMessage.key.fromMe,
      });

      return { messageId: dbMessage.id };
    },
    {
      connection: workerRedis.duplicate() as any,
      concurrency: 20,
      limiter: undefined,
    }
  );

  worker.on('completed', (job) => {
    logger.debug(`Message job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Message job ${job?.id} failed`, { error: err.message });
  });

  return worker;
}
