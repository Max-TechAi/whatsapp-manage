/**
 * Sync Worker — processes history sync events in the background.
 */

import { Worker, Job } from 'bullmq';
import { workerRedis } from '../../config/redis.js';
import { messageSyncService } from '../../modules/messages/message.sync.js';
import { contactService } from '../../modules/contacts/contact.service.js';
import { chatService } from '../../modules/chats/chat.service.js';
import { QUEUES, eventBus, STREAMS } from '../event-bus.js';
import { logger } from '../../observability/logger.js';

import { saveLidMapping, resolveLidJid } from '../../modules/sessions/lid-mapping.js';
import type { Contact } from '../../modules/contacts/contact.types.js';

interface HistorySyncJob {
  sessionId: string;
  orgId: string;
  data: any;
}

interface ContactSyncJob {
  sessionId: string;
  orgId: string;
  contacts: any[];
}

interface ChatSyncJob {
  sessionId: string;
  orgId: string;
  chats: any[];
  action: 'upsert' | 'update' | 'delete';
}

export function createSyncWorker(): Worker {
  const worker = new Worker<HistorySyncJob>(
    QUEUES.HISTORY_SYNC,
    async (job: Job<HistorySyncJob>) => {
      const { sessionId, orgId, data } = job.data;

      logger.info('Processing history sync job', {
        sessionId,
        jobId: job.id,
        messageCount: data?.messages?.length ?? 0,
      });

      const result = await messageSyncService.processHistorySync(sessionId, orgId, data);

      logger.info('History sync job completed', {
        sessionId,
        jobId: job.id,
        ...result,
      });

      return result;
    },
    {
      connection: workerRedis.duplicate() as any,
      concurrency: 2,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(`Sync job ${job?.id} failed`, { error: err.message });
  });

  return worker;
}

export function createContactSyncWorker(): Worker {
  const worker = new Worker<ContactSyncJob>(
    QUEUES.CONTACT_SYNC,
    async (job: Job<ContactSyncJob>) => {
      const { sessionId, orgId, contacts: contactList } = job.data;

      let synced = 0;
      for (const contact of contactList) {
        try {
          const waId = contact.id ?? contact.waId;
          const lid = contact.lid;
          
          if (waId && lid) {
            await saveLidMapping(sessionId, lid, waId);
          } else if (waId) {
            const phoneJid = contact.phoneNumber ?? contact.phone;
            if (phoneJid) {
              await saveLidMapping(sessionId, waId, phoneJid);
            }
          }

          const resolvedWaId = await resolveLidJid(sessionId, waId);

          await contactService.upsertContact({
            orgId,
            sessionId,
            waId: resolvedWaId,
            pushName: contact.notify ?? contact.pushName ?? null,
            displayName: contact.name ?? contact.displayName ?? null,
            avatarUrl: contact.imgUrl ?? contact.avatarUrl ?? null,
          });
          synced++;
        } catch (err) {
          logger.warn('Contact sync failed', {
            waId: contact.id,
            error: (err as Error).message,
          });
        }
      }

      logger.info('Contact sync completed', { sessionId, total: contactList.length, synced });
      return { synced };
    },
    {
      connection: workerRedis.duplicate() as any,
      concurrency: 5,
    }
  );

  return worker;
}

export function createChatSyncWorker(): Worker {
  const worker = new Worker<ChatSyncJob>(
    QUEUES.CHAT_SYNC,
    async (job: Job<ChatSyncJob>) => {
      const { sessionId, orgId, chats: chatList, action } = job.data;

      let processed = 0;
      for (const chat of chatList) {
        const waChatId = chat.id ?? chat.waChatId ?? '';
        // BUG 2: Exclude WhatsApp Status broadcast threads
        if (waChatId.endsWith('@broadcast') || waChatId === 'status' || chat.type === 'status') {
          continue;
        }

        try {
          if (action === 'delete') {
            // Find and soft-handle deletion
            logger.info('Chat deletion event', { sessionId, chatId: chat.id });
          } else {
            logger.info('[DEBUG UNREAD] ChatSyncWorker: upsertChat starting', {
              sessionId,
              waChatId: chat.id ?? chat.waChatId,
              incomingUnreadCount: chat.unreadCount,
            });
            const dbChat = await chatService.upsertChat({
              orgId,
              sessionId,
              waChatId: chat.id ?? chat.waChatId,
              chatType: (chat.id ?? chat.waChatId ?? '').endsWith('@g.us') ? 'group' : 'private',
              name: chat.name ?? chat.subject ?? null,
              unreadCount: chat.unreadCount ?? undefined,
              isArchived: chat.archived ?? chat.archive ?? undefined,
              isPinned: chat.pinned === undefined ? undefined : (chat.pinned ? true : false),
              mutedUntil: chat.muteEndTime === undefined ? undefined : (chat.muteEndTime ? new Date(chat.muteEndTime * 1000) : null),
              lastMessageAt: chat.conversationTimestamp
                ? new Date(Number(chat.conversationTimestamp) * 1000)
                : undefined,
            });

            /* BUG 3: Broadcast chat update event via Redis stream / WebSockets */
            if (dbChat) {
              const resolvedChat = await chatService.getChatById(orgId, dbChat.id);
              logger.info('[DEBUG UNREAD] ChatSyncWorker: dbChat upserted and fetched', {
                sessionId,
                waChatId: chat.id ?? chat.waChatId,
                dbChatId: dbChat.id,
                dbUnreadCount: dbChat.unreadCount,
                resolvedUnreadCount: resolvedChat?.unreadCount,
              });
              if (resolvedChat) {
                await eventBus.publishToStream(STREAMS.CHATS, 'chat:update', {
                  sessionId,
                  orgId,
                  chat: resolvedChat,
                }).catch(err => {
                  logger.error('Failed to publish chat update to stream', { sessionId, error: err.message });
                });
              }
            }
            processed++;
          }
        } catch (err) {
          logger.warn('Chat sync failed', {
            chatId: chat.id,
            error: (err as Error).message,
          });
        }
      }

      logger.info('Chat sync completed', { sessionId, action, total: chatList.length, processed });
      return { processed };
    },
    {
      connection: workerRedis.duplicate() as any,
      concurrency: 5,
    }
  );

  return worker;
}
