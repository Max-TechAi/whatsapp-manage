/**
 * Outbound Worker — processes outgoing message requests from BullMQ queue.
 * Sends the message via Baileys and saves it to the database.
 */

import { Worker, Job } from 'bullmq';
import { workerRedis } from '../../config/redis.js';
import { messageService } from '../../modules/messages/message.service.js';
import { sessionManager } from '../../modules/sessions/session.manager.js';
import { QUEUES } from '../event-bus.js';
import { logger } from '../../observability/logger.js';

interface OutboundMessageJob {
  sessionId: string;
  orgId: string;
  chatId: string;
  waChatJid: string;
  type: string;
  content?: string;
  mediaUrl?: string;
  caption?: string;
  quotedWaMessageId?: string;
  enqueuedAt: string;
}

export function createOutboundWorker(): Worker {
  const worker = new Worker<OutboundMessageJob>(
    QUEUES.MESSAGE_OUTBOUND,
    async (job: Job<OutboundMessageJob>) => {
      const { sessionId, orgId, chatId, waChatJid, type, content, mediaUrl, caption, quotedWaMessageId } = job.data;

      logger.info('Processing outbound message job', { jobId: job.id, sessionId, waChatJid });

      const activeSession = sessionManager.getSession(sessionId);
      if (!activeSession) {
        throw new Error(`Session ${sessionId} is not active or connected in memory`);
      }

      // Send message via Baileys
      let result;
      if (type === 'text') {
        if (!content) {
          throw new Error('Message content is required for text message');
        }
        
        const sendOptions: any = {};
        if (quotedWaMessageId) {
          sendOptions.quoted = {
            key: {
              remoteJid: waChatJid,
              fromMe: false,
              id: quotedWaMessageId,
            },
            message: {
              conversation: '', // dummy content
            }
          };
        }

        result = await activeSession.socket.sendMessage(waChatJid, { text: content }, sendOptions);
      } else {
        throw new Error(`Unsupported outbound message type: ${type}`);
      }

      if (!result?.key?.id) {
        throw new Error('Failed to send message via Baileys: no message ID returned');
      }

      // Save the message to the database
      const waMessageId = result.key.id;
      const timestamp = result.messageTimestamp
        ? new Date(Number(result.messageTimestamp) * 1000)
        : new Date();

      const dbMessage = await messageService.upsertMessage({
        orgId,
        sessionId,
        chatId,
        waMessageId,
        senderJid: 'me',
        fromMe: true,
        messageType: type,
        content: content || null,
        status: 'sent',
        metadata: {
          ...(quotedWaMessageId ? { quotedWaMessageId } : {}),
        },
        createdAt: timestamp,
      });

      logger.info('Outbound message sent and stored successfully', {
        messageId: dbMessage.id,
        waMessageId,
      });

      return { messageId: dbMessage.id, waMessageId };
    },
    {
      connection: workerRedis.duplicate() as any,
      concurrency: 5, // Rate limit concurrency to avoid ban triggers
    }
  );

  worker.on('completed', (job) => {
    logger.debug(`Outbound message job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Outbound message job ${job?.id} failed`, { error: err.message });
  });

  return worker;
}
