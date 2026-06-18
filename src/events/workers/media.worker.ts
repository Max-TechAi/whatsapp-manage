/**
 * Media Worker — downloads media from WhatsApp and stores in MinIO.
 */

import { Worker, Job } from 'bullmq';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { workerRedis } from '../../config/redis.js';
import { mediaService } from '../../modules/media/media.service.js';
import { messageService } from '../../modules/messages/message.service.js';
import { sessionManager } from '../../modules/sessions/session.manager.js';
import { QUEUES } from '../event-bus.js';
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
        await messageService.upsertMessage({
          ...dbMessage,
          mediaUrl: result.objectKey,
          mediaMimeType: mimeType,
          mediaSize: result.sizeBytes,
          metadata: {
            ...dbMessage.metadata,
            mediaFileId: result.fileId,
            thumbnailKey: result.thumbnailUrl ? result.objectKey.replace(/(\.[^.]+)$/, '_thumb.jpg') : undefined,
            checksum: result.checksumSha256,
          },
        });
      }

      logger.info('Media downloaded and stored', {
        messageId,
        fileId: result.fileId,
        mimeType,
        sizeBytes: result.sizeBytes,
      });

      return { messageId, fileId: result.fileId, sizeBytes: result.sizeBytes };
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
