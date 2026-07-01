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
import { db } from '../../config/database.js';
import { messages } from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { aesDecryptGCM, hmacSign, proto } from '@whiskeysockets/baileys';

// Helper to convert multiple secret formats into a unified Buffer
function getBufferFromSecret(secret: any): Buffer | null {
  if (!secret) return null;
  if (Buffer.isBuffer(secret)) return secret;
  if (secret instanceof Uint8Array) return Buffer.from(secret);
  if (typeof secret === 'string') {
    const isBase64 = /^[A-Za-z0-9+/]*={0,2}$/.test(secret);
    return Buffer.from(secret, isBase64 ? 'base64' : 'utf8');
  }
  if (typeof secret === 'object' && secret.type === 'Buffer' && Array.isArray(secret.data)) {
    return Buffer.from(secret.data);
  }
  if (Array.isArray(secret)) {
    return Buffer.from(secret);
  }
  return null;
}

// Decrypts the secretEncryptedMessage using the original message's secret key
function decryptEditedMessage(
  secEncMsg: any,
  messageSecret: Buffer,
  senderJid: string
): any {
  const encPayload = getBufferFromSecret(secEncMsg.encPayload);
  const encIv = getBufferFromSecret(secEncMsg.encIv);
  if (!encPayload || !encIv) {
    throw new Error('Payload or IV is missing or invalid');
  }

  const toBinary = (txt: string) => Buffer.from(txt);
  const senderBuf = toBinary(senderJid);
  
  // Construct the signature required for decryption
  const sign = Buffer.concat([
    toBinary(secEncMsg.targetMessageKey.id),
    senderBuf,
    senderBuf,
    toBinary('Message Edit'),
    new Uint8Array([1])
  ]);

  const key = hmacSign(messageSecret, new Uint8Array(32));
  const decKey = hmacSign(sign, key);

  const decrypted = aesDecryptGCM(encPayload, decKey, encIv, new Uint8Array(0));
  return proto.Message.decode(decrypted);
}

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

      logger.info('[DEBUG EDIT_DELETE UNCONDITIONAL] Message Worker starting processing', {
        jobId: job.id,
        sessionId,
        waMessageId: waMessage.key.id,
        remoteJid: waMessage.key.remoteJid,
        messageKeys: Object.keys(waMessage.message || {}),
        messageStubType: waMessage.messageStubType,
        messageStubParameters: waMessage.messageStubParameters,
        rawMessage: JSON.stringify(waMessage).substring(0, 1000),
        type,
      });

      const resolvedRemoteJid = await resolveLidJid(sessionId, waMessage.key.remoteJid);
      const remoteJid = normalizeJid(resolvedRemoteJid);

      // EXCLUDE: Skip status, broadcast, and newsletter messages
      if (
        remoteJid.endsWith('@broadcast') ||
        remoteJid.endsWith('@newsletter') ||
        remoteJid === 'status'
      ) {
        logger.debug('Skipping status/broadcast/newsletter message inbound job', { remoteJid, waMessageId: waMessage.key.id });
        return;
      }

      // Intercept message edits and deletes (revoke)
      const protocolMessage = waMessage.message?.protocolMessage;
      const secretEncryptedMessage = waMessage.message?.secretEncryptedMessage;

      const isProtocolEdit = protocolMessage && (protocolMessage.type === 14 || protocolMessage.type === 'MESSAGE_EDIT');
      const isProtocolRevoke = protocolMessage && (protocolMessage.type === 0 || protocolMessage.type === 'REVOKE');
      const isSecretEdit = secretEncryptedMessage && (secretEncryptedMessage.secretEncType === 'MESSAGE_EDIT' || secretEncryptedMessage.secretEncType === 1);

      if (isProtocolEdit || isProtocolRevoke || isSecretEdit) {
        const targetId = isProtocolEdit || isProtocolRevoke 
          ? protocolMessage.key?.id 
          : secretEncryptedMessage.targetMessageKey?.id;

        if (targetId) {
          logger.info('[DEBUG EDIT_DELETE] Intercepted message edit/revoke event', {
            sessionId,
            orgId,
            editMessageId: waMessage.key.id,
            targetId,
            isProtocolEdit,
            isProtocolRevoke,
            isSecretEdit,
          });

          // Fetch the original message from the database
          const [originalMsg] = await db
            .select({
              id: messages.id,
              chatId: messages.chatId,
              content: messages.content,
              metadata: messages.metadata,
            })
            .from(messages)
            .where(
              and(
                eq(messages.sessionId, sessionId),
                eq(messages.waMessageId, targetId)
              )
            )
            .limit(1);

          if (originalMsg) {
            logger.info('[DEBUG EDIT_DELETE] Original message FOUND in database', {
              targetId,
              dbMessageId: originalMsg.id,
              dbChatId: originalMsg.chatId,
            });

            let newContent: string | null = null;
            let success = false;

            if (isProtocolEdit) {
              const dummyWaMsg = {
                key: protocolMessage.key,
                message: protocolMessage.editedMessage,
                messageTimestamp: waMessage.messageTimestamp,
              };
              const { content } = extractMessageContent(dummyWaMsg as any);
              newContent = content;
              success = true;
            } else if (isSecretEdit) {
              try {
                // Fetch the original message's secret key from metadata
                const originalMsgRaw = (originalMsg.metadata as any)?.waMessage;
                const msgSecRaw = originalMsgRaw?.message?.messageContextInfo?.messageSecret
                  || originalMsgRaw?.message?.deviceSentMessage?.message?.messageContextInfo?.messageSecret
                  || originalMsgRaw?.messageSecret;

                if (!msgSecRaw) {
                  logger.warn('[DEBUG EDIT_DELETE] Edit decryption unavailable — messageSecret not present in stored metadata (expected for outgoing fromMe messages where companion device does not receive the secret from the phone)', {
                    targetId,
                    fromMe: waMessage.key.fromMe,
                  });
                  // Cannot decrypt without the secret; suppress the edit silently
                  // (success stays false, no DB update, early return at end prevents new bubble)
                  return { messageId: null };
                }

                const msgSec = getBufferFromSecret(msgSecRaw);
                if (!msgSec) {
                  throw new Error('Failed to parse message secret into binary buffer');
                }

                const senderJid = waMessage.key.participant || waMessage.key.remoteJid;
                if (!senderJid) {
                  throw new Error('Missing sender participant JID to build edit signature');
                }

                const decryptedMsg = decryptEditedMessage(secretEncryptedMessage, msgSec!, senderJid);
                logger.info('[DEBUG EDIT_DELETE] Successfully decrypted secretEncryptedMessage edit payload', {
                  decryptedKeys: Object.keys(decryptedMsg || {})
                });

                const actualMessage = decryptedMsg.protocolMessage?.editedMessage ?? decryptedMsg;
                const dummyWaMsg = {
                  key: secretEncryptedMessage.targetMessageKey,
                  message: actualMessage,
                  messageTimestamp: waMessage.messageTimestamp,
                };
                const { content } = extractMessageContent(dummyWaMsg as any);
                newContent = content;
                success = true;
              } catch (err) {
                logger.error('[DEBUG EDIT_DELETE] Failed to decrypt secretEncryptedMessage edit', {
                  targetId,
                  error: (err as Error).message,
                });
              }
            }

            if (success && (isProtocolEdit || isSecretEdit)) {
              // Update database record
              await db
                .update(messages)
                .set({
                  content: newContent,
                  isEdited: true,
                  editedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(eq(messages.id, originalMsg.id));

              logger.info('[DEBUG EDIT_DELETE] Updated message content successfully', {
                messageId: originalMsg.id,
                waMessageId: targetId,
                newContent,
              });

              // Broadcast update via message:status_update
              await eventBus.publishToStream(STREAMS.MESSAGES, 'message:status_update', {
                sessionId,
                orgId,
                chatId: originalMsg.chatId,
                messageId: targetId,
                isEdited: true,
                content: newContent,
              });
            } else if (isProtocolRevoke) {
              // Update database record (keep content in DB but set isDeleted flag)
              await db
                .update(messages)
                .set({
                  isDeleted: true,
                  updatedAt: new Date(),
                })
                .where(eq(messages.id, originalMsg.id));

              logger.info('[DEBUG EDIT_DELETE] Flagged message as deleted successfully', {
                messageId: originalMsg.id,
                waMessageId: targetId,
              });

              // Broadcast update via message:status_update
              await eventBus.publishToStream(STREAMS.MESSAGES, 'message:status_update', {
                sessionId,
                orgId,
                chatId: originalMsg.chatId,
                messageId: targetId,
                isDeleted: true,
              });
            }
          } else {
            logger.warn('[DEBUG EDIT_DELETE] Original message NOT FOUND in database for edit/revoke', {
              sessionId,
              targetId,
              isProtocolEdit,
              isProtocolRevoke,
              isSecretEdit,
            });

            // Perform diagnostic fallback scan to retrieve format of stored message IDs for comparison
            try {
              const recentMsgs = await db
                .select({
                  id: messages.id,
                  waMessageId: messages.waMessageId,
                  chatId: messages.chatId,
                  createdAt: messages.createdAt,
                })
                .from(messages)
                .where(eq(messages.sessionId, sessionId))
                .orderBy(desc(messages.createdAt))
                .limit(5);

              logger.info('[DEBUG EDIT_DELETE DIAGNOSTIC] Stored waMessageId format overview (5 most recent):', {
                recentMsgs: recentMsgs.map(m => ({
                  id: m.id,
                  waMessageId: m.waMessageId,
                  createdAt: m.createdAt,
                }))
              });
            } catch (diagErr) {
              logger.error('[DEBUG EDIT_DELETE DIAGNOSTIC] Failed to query recent messages format', { error: (diagErr as Error).message });
            }
          }

          // Return early to prevent inserting the protocol message wrapper as a new bubble
          return { messageId: null };
        }
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

      let quotedMessageId = null;
      if (quotedWaMessageId) {
        try {
          const [quotedMsg] = await db
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.sessionId, sessionId),
                eq(messages.waMessageId, quotedWaMessageId)
              )
            )
            .limit(1);
          if (quotedMsg) {
            quotedMessageId = quotedMsg.id;
          }
        } catch (err) {
          logger.warn('Failed to resolve quoted message UUID in message worker', { quotedWaMessageId, error: (err as Error).message });
        }
      }

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

      const isDecryptionFailure =
        waMessage.messageStubType === 2 ||
        waMessage.messageStubType === 'CIPHERTEXT';

      // Upsert message (dedup via ON CONFLICT)
      const dbMessage = await messageService.upsertMessage({
        orgId,
        sessionId,
        chatId,
        waMessageId,
        senderJid,
        fromMe: waMessage.key.fromMe ?? false,
        messageType: isDecryptionFailure ? 'text' : messageType,
        content: isDecryptionFailure ? 'Waiting for this message. This may take a while.' : content,
        mediaMimeType: mediaInfo?.mimeType ?? null,
        mediaSize: mediaInfo?.size ?? null,
        quotedMessageId,
        quotedContent,
        status: isDecryptionFailure ? 'failed' : (waMessage.key.fromMe ? 'sent' : 'delivered'),
        isForwarded,
        forwardScore,
        metadata: {
          pushName: waMessage.pushName ?? null,
          broadcast: waMessage.broadcast ?? false,
          ...(quotedWaMessageId ? { quotedWaMessageId } : {}),
          decryptionFailed: isDecryptionFailure ? true : undefined,
          fileName: mediaInfo?.fileName || undefined,
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
    if (job?.data?.orgId) {
      eventBus.decrementActiveJobs(job.data.orgId, QUEUES.MESSAGE_INBOUND).catch((err) => {
        logger.warn('Failed to decrement active jobs on completion', { error: err.message });
      });
    }
  });

  worker.on('failed', (job, err) => {
    logger.error(`Message job ${job?.id} failed`, { error: err.message });
    if (job?.data?.orgId) {
      const attempts = job.opts?.attempts ?? 1;
      if (job.attemptsMade >= attempts) {
        eventBus.decrementActiveJobs(job.data.orgId, QUEUES.MESSAGE_INBOUND).catch((err) => {
          logger.warn('Failed to decrement active jobs on failure', { error: err.message });
        });
      }
    }
  });

  return worker;
}
