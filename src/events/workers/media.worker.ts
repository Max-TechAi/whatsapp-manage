/**
 * Media Worker — downloads media from WhatsApp and stores in MinIO.
 */

import { Worker, Job } from 'bullmq';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { workerRedis } from '../../config/redis.js';
import { mediaService } from '../../modules/media/media.service.js';
import { messageService } from '../../modules/messages/message.service.js';
import { sessionManager } from '../../modules/sessions/session.manager.js';
import { QUEUES, STREAMS, eventBus } from '../event-bus.js';
import { logger } from '../../observability/logger.js';

interface MediaDownloadJob {
  sessionId: string;
  orgId: string;
  messageId: string;
  messageData: any;
}

export function createMediaWorker(): Worker {
  const worker = new Worker<MediaDownloadJob>(
    QUEUES.MEDIA_DOWNLOAD,
    async (job: Job<MediaDownloadJob>) => {
      const { sessionId, orgId, messageId, messageData } = job.data;

      try {
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          logger.warn('Session not active for media download', { sessionId, messageId });
          throw new Error(`Session ${sessionId} not active`);
        }

        // Download media from WhatsApp
        const buffer = await downloadMediaMessage(
          messageData,
          'buffer',
          {},
          {
            logger: undefined as any,
            reuploadRequest: session.socket.updateMediaMessage,
          }
        );

        if (!buffer || buffer.length === 0) {
          logger.warn('Empty media download', { messageId });
          return { messageId, status: 'empty' };
        }

        // Determine filename and mime type
        const mediaMsg =
          messageData.message?.imageMessage
          ?? messageData.message?.videoMessage
          ?? messageData.message?.audioMessage
          ?? messageData.message?.documentMessage
          ?? messageData.message?.stickerMessage;

        const mimeType = mediaMsg?.mimetype ?? 'application/octet-stream';
        const filename = mediaMsg?.fileName ?? `media-${messageId}`;

        // Upload to MinIO
        const result = await mediaService.upload({
          orgId,
          sessionId,
          messageId,
          buffer: Buffer.from(buffer),
          filename,
          mimeType,
        });

        // Update message with media URL
        const dbMessage = await messageService.getMessageById(orgId, messageId);
        if (dbMessage) {
          const updatedMessage = await messageService.upsertMessage({
            ...dbMessage,
            mediaUrl: result.objectKey,
            mediaMimeType: mimeType,
            mediaSize: result.sizeBytes,
            metadata: {
              ...dbMessage.metadata,
              mediaFileId: result.fileId,
              thumbnailKey: result.thumbnailUrl ? result.objectKey.replace(/(\.[^.]+)$/, '_thumb.jpg') : undefined,
              checksum: result.checksumSha256,
              mediaStatus: 'downloaded',
            },
          });

          // Broadcast to Redis Stream for WebSocket update (changed to media_update to avoid duplicate counters)
          await eventBus.publishToStream(STREAMS.MESSAGES, 'message:media_update', {
            sessionId,
            orgId,
            chatId: dbMessage.chatId,
            message: updatedMessage,
          });
        }

        logger.info('Media downloaded and stored', {
          messageId,
          fileId: result.fileId,
          mimeType,
          sizeBytes: result.sizeBytes,
        });

        return { messageId, fileId: result.fileId, sizeBytes: result.sizeBytes };
      } catch (err) {
        // If it is the last attempt, mark the message media status as failed
        const maxAttempts = job.opts.attempts ?? 1;
        if (job.attemptsMade >= maxAttempts - 1) {
          logger.error('Media download failed permanently after all retries', { messageId, error: (err as Error).message });
          try {
            const dbMessage = await messageService.getMessageById(orgId, messageId);
            if (dbMessage) {
              const updatedMessage = await messageService.upsertMessage({
                ...dbMessage,
                metadata: {
                  ...dbMessage.metadata,
                  mediaStatus: 'failed',
                },
              });

              // Broadcast update (changed to media_update to avoid duplicate counters)
              await eventBus.publishToStream(STREAMS.MESSAGES, 'message:media_update', {
                sessionId,
                orgId,
                chatId: dbMessage.chatId,
                message: updatedMessage,
              });
            }
          } catch (updateErr) {
            logger.error('Failed to update message mediaStatus to failed', { error: (updateErr as Error).message });
          }
        }
        throw err; // Rethrow to let BullMQ handle retry state
      }
    },
    {
      connection: workerRedis.duplicate() as any,
      concurrency: 10,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(`Media job ${job?.id} failed`, { error: err.message });
  });

  return worker;
}
