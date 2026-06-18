/**
 * Message Worker — processes inbound messages from BullMQ queue.
 * Transforms Baileys WAMessage → DB record, persists, triggers side effects.
 */

import { Worker, Job } from 'bullmq';
import { workerRedis } from '../../config/redis.js';
import { messageService } from '../../modules/messages/message.service.js';
import { chatService } from '../../modules/chats/chat.service.js';
import { eventBus, QUEUES, STREAMS } from '../event-bus.js';
import { extractMessageContent, getJidType, normalizeJid } from '../../modules/sessions/session.events.js';
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

      const remoteJid = normalizeJid(waMessage.key.remoteJid);
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
      const senderJid = waMessage.key.fromMe
        ? 'me'
        : normalizeJid(waMessage.key.participant || waMessage.key.remoteJid);

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
        },
        createdAt: timestamp,
      });

      // If media message, enqueue media download
      if (mediaInfo && ['image', 'video', 'audio', 'document', 'sticker'].includes(messageType)) {
        await eventBus.publishMediaDownload(sessionId, orgId, dbMessage.id, waMessage);
      }

      // Publish to Redis Stream for WebSocket broadcast
      if (type === 'notify') {
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
