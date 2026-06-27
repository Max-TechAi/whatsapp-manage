/**
 * Event Bus — BullMQ queues + Redis Streams for reliable message processing.
 * Central hub connecting Baileys events to workers and WebSocket broadcast.
 */

import { Queue, QueueEvents } from 'bullmq';
import { queueRedis, redis } from '../config/redis.js';
import { logger } from '../observability/logger.js';

/**
 * Helper to generate a safe inbound message jobId for BullMQ.
 * Removes colons and slashes which are unsafe or cause BullMQ/Redis errors.
 */
export function generateInboundJobId(sessionId: string, messageId: string): string {
  return `${sessionId}-${messageId}`.replace(/[:/]/g, '-');
}

/**
 * Helper to generate a safe history sync jobId for BullMQ.
 * Removes colons and slashes which are unsafe or cause BullMQ/Redis errors.
 */
export function generateHistorySyncJobId(
  sessionId: string,
  syncType: string | number,
  chunkOrder: string | number,
  messageSignature: string
): string {
  return `history-sync-${sessionId}-${syncType}-${chunkOrder}-${messageSignature}`.replace(/[:/]/g, '-');
}

/** Queue names as constants for type safety */
export const QUEUES = {
  MESSAGE_INBOUND: 'message-inbound',
  MESSAGE_OUTBOUND: 'message-outbound',
  MEDIA_DOWNLOAD: 'media-download',
  MEDIA_TRANSCODE: 'media-transcode',
  HISTORY_SYNC: 'history-sync',
  WEBHOOK_DELIVERY: 'webhook-delivery',
  CONTACT_SYNC: 'contact-sync',
  CHAT_SYNC: 'chat-sync',
  SESSIONS_ORCHESTRATION: 'sessions-orchestration',
} as const;

/** Redis Streams for fan-out event broadcasting */
export const STREAMS = {
  MESSAGES: 'events:messages',
  SESSIONS: 'events:sessions',
  PRESENCE: 'events:presence',
  CHATS: 'events:chats',
} as const;

type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export class EventBus {
  private queues: Map<string, Queue> = new Map();
  private queueEvents: Map<string, QueueEvents> = new Map();
  private dynamicQueues: Map<string, Queue> = new Map();

  constructor() {
    // Initialize all queues
    for (const [, name] of Object.entries(QUEUES)) {
      const queue = new Queue(name, {
        connection: queueRedis.duplicate() as any,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
          removeOnFail: { count: 100 },
        },
      });
      this.queues.set(name, queue);
    }

    logger.info('Event bus initialized', { queues: Object.values(QUEUES) });
  }

  /** Get a queue by name */
  getQueue(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Queue ${name} not found`);
    return queue;
  }

  /** Get or dynamically create a session-specific queue */
  getDynamicQueue(name: string): Queue {
    let queue = this.dynamicQueues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: queueRedis.duplicate() as any,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
          removeOnFail: { count: 100 },
        },
      });
      this.dynamicQueues.set(name, queue);
    }
    return queue;
  }

  /**
   * Publish incoming WA messages to the processing queue.
   * Called by session event handlers.
   */
  async publishMessageInbound(
    sessionId: string,
    orgId: string,
    messages: any[],
    type: 'notify' | 'append'
  ): Promise<void> {
    const queue = this.getQueue(QUEUES.MESSAGE_INBOUND);

    for (const msg of messages) {
      const rawJobId = generateInboundJobId(sessionId, msg.key?.id ?? String(Date.now()));
      const activeJobs = await this.incrementActiveJobs(orgId, QUEUES.MESSAGE_INBOUND);
      // Real-time notifications get higher base priority (lower values) than historical/append syncs
      const priority = type === 'notify' ? Math.min(activeJobs, 500) : Math.min(activeJobs + 100, 1000);
      try {
        await queue.add(
          `msg-${type}`,
          {
            sessionId,
            orgId,
            message: msg,
            type,
            receivedAt: new Date().toISOString(),
          },
          {
            jobId: rawJobId,
            priority,
          }
        );
      } catch (err) {
        // BUG 1 fallback: if the generated jobId still fails, retry with a safe SHA-256 hash to prevent message loss
        logger.error('Failed to publish inbound message, retrying with fallback sanitized hash ID', {
          sessionId,
          error: (err as Error).message,
        });
        const crypto = await import('node:crypto');
        const fallbackJobId = crypto.createHash('sha256').update(rawJobId).digest('hex');
        try {
          await queue.add(
            `msg-${type}`,
            {
              sessionId,
              orgId,
              message: msg,
              type,
              receivedAt: new Date().toISOString(),
            },
            {
              jobId: fallbackJobId,
              priority,
            }
          );
        } catch (retryErr) {
          logger.error('Critical: Failed to publish inbound message even with fallback hash ID', {
            sessionId,
            error: (retryErr as Error).message,
          });
        }
      }
    }

    logger.debug('Published inbound messages', {
      sessionId,
      count: messages.length,
      type,
    });
  }

  /**
   * Publish outgoing message request.
   * Rate-limited per session to avoid WhatsApp bans.
   */
  async publishMessageOutbound(
    sessionId: string,
    orgId: string,
    data: {
      chatId: string;
      waChatJid: string;
      type: string;
      content?: string;
      mediaUrl?: string;
      caption?: string;
      quotedWaMessageId?: string;
      sentByUserId?: string | null;
    }
  ): Promise<string> {
    const queueName = `queue-session-${sessionId}-outbound`;
    const queue = this.getDynamicQueue(queueName);

    const job = await queue.add(
      'send-message',
      { sessionId, orgId, ...data, enqueuedAt: new Date().toISOString() },
      {
        delay: 0,
        jobId: `out-${sessionId}-${Date.now()}`,
      }
    );

    return job.id!;
  }

  /**
   * Publish media download request.
   */
  async publishMediaDownload(
    sessionId: string,
    orgId: string,
    messageId: string,
    messageData: any
  ): Promise<void> {
    const queueName = `queue-session-${sessionId}-media`;
    const queue = this.getDynamicQueue(queueName);
    await queue.add(
      'download',
      {
        sessionId,
        orgId,
        messageId,
        messageData,
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      }
    );
  }

  /**
   * Publish session control command (restart, destroy, reset-contact-session, etc.).
   */
  async publishSessionControl(
    sessionId: string,
    action: 'restart' | 'destroy' | 'reset-contact-session' | 'mark-read' | 'fetch-history',
    payload: Record<string, any> = {}
  ): Promise<string> {
    const queueName = `queue-session-${sessionId}-control`;
    const queue = this.getDynamicQueue(queueName);
    
    const job = await queue.add(
      action,
      { sessionId, action, payload, enqueuedAt: new Date().toISOString() },
      {
        attempts: 3,
        backoff: { type: 'fixed', delay: 2000 }
      }
    );
    
    return job.id!;
  }

  /**
   * Publish session orchestration startup command.
   */
  async publishSessionOrchestration(
    sessionId: string,
    orgId: string,
    action: 'start'
  ): Promise<string> {
    const queue = this.getQueue(QUEUES.SESSIONS_ORCHESTRATION);
    const job = await queue.add(
      action,
      { sessionId, orgId, action },
      {
        jobId: `orchestrate-${action}-${sessionId}`, // Deduplication by job ID
        attempts: 3,
        backoff: { type: 'fixed', delay: 5000 }
      }
    );
    return job.id!;
  }

  /**
   * Publish history sync data for background processing.
   */
  async publishHistorySync(
    sessionId: string,
    orgId: string,
    data: any
  ): Promise<void> {
    const queue = this.getQueue(QUEUES.HISTORY_SYNC);

    // Construct a unique jobId to prevent duplicate history sync jobs in BullMQ
    const syncType = data.syncType ?? 'unknown';
    const chunkOrder = data.chunkOrder ?? 'single';
    let messageSignature = 'no_messages';
    if (data.messages && data.messages.length > 0) {
      const firstId = data.messages[0]?.key?.id || '';
      const lastId = data.messages[data.messages.length - 1]?.key?.id || '';
      messageSignature = `${data.messages.length}_${firstId}_${lastId}`;
    }
    const rawJobId = generateHistorySyncJobId(sessionId, syncType, chunkOrder, messageSignature);
    const activeJobs = await this.incrementActiveJobs(orgId, QUEUES.HISTORY_SYNC);
    const priority = Math.min(activeJobs, 1000);

    try {
      await queue.add(
        'sync',
        { sessionId, orgId, data },
        {
          jobId: rawJobId, // Unique job ID for BullMQ deduplication
          attempts: 3,
          backoff: { type: 'fixed', delay: 5000 },
          priority,
          removeOnComplete: true,
        }
      );
    } catch (err) {
      // BUG 1 fallback: if the generated jobId still fails, retry with a safe SHA-256 hash to prevent sync stall
      logger.error('Failed to publish history sync, retrying with fallback sanitized hash ID', {
        sessionId,
        error: (err as Error).message,
      });
      const crypto = await import('node:crypto');
      const fallbackJobId = crypto.createHash('sha256').update(rawJobId).digest('hex');
      try {
        await queue.add(
          'sync',
          { sessionId, orgId, data },
          {
            jobId: fallbackJobId,
            attempts: 3,
            backoff: { type: 'fixed', delay: 5000 },
            priority,
            removeOnComplete: true,
          }
        );
      } catch (retryErr) {
        logger.error('Critical: Failed to publish history sync even with fallback hash ID', {
          sessionId,
          error: (retryErr as Error).message,
        });
      }
    }
  }

  /**
   * Publish webhook delivery request.
   */
  async publishWebhookDelivery(
    orgId: string,
    event: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const queue = this.getQueue(QUEUES.WEBHOOK_DELIVERY);
    const activeJobs = await this.incrementActiveJobs(orgId, QUEUES.WEBHOOK_DELIVERY);
    const priority = Math.min(activeJobs, 1000);
    await queue.add('deliver', {
      orgId,
      event,
      payload,
      timestamp: new Date().toISOString(),
    }, {
      priority,
    });
  }

  /**
   * Publish contact sync data.
   */
  async publishContactSync(
    sessionId: string,
    orgId: string,
    contacts: any[]
  ): Promise<void> {
    const queue = this.getQueue(QUEUES.CONTACT_SYNC);
    const activeJobs = await this.incrementActiveJobs(orgId, QUEUES.CONTACT_SYNC);
    const priority = Math.min(activeJobs, 1000);
    await queue.add('sync', { sessionId, orgId, contacts }, { priority });
  }

  /**
   * Publish chat sync data.
   */
  async publishChatSync(
    sessionId: string,
    orgId: string,
    chatsData: any[],
    action: 'upsert' | 'update' | 'delete'
  ): Promise<void> {
    const queue = this.getQueue(QUEUES.CHAT_SYNC);
    const activeJobs = await this.incrementActiveJobs(orgId, QUEUES.CHAT_SYNC);
    const priority = Math.min(activeJobs, 1000);
    await queue.add(action, { sessionId, orgId, chats: chatsData, action }, { priority });
  }

  // ─── Redis Streams (Fan-out Broadcast) ─────────────────────

  /**
   * Publish an event to a Redis Stream for fan-out consumption.
   * Used by WebSocket server and other consumers.
   */
  async publishToStream(
    stream: string,
    event: string,
    data: Record<string, unknown>
  ): Promise<void> {
    try {
      await redis.xadd(
        stream,
        'MAXLEN',
        '~',
        '10000', // Keep last ~10000 entries
        '*',
        'event', event,
        'data', JSON.stringify(data),
        'timestamp', new Date().toISOString()
      );
    } catch (err) {
      logger.error('Failed to publish to stream', {
        stream,
        event,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Increment active job count for an organization on a specific queue.
   * Returns the new count to be used as the job priority.
   */
  async incrementActiveJobs(orgId: string, queueName: string): Promise<number> {
    const key = `queue_count:${orgId}:${queueName}`;
    try {
      const count = await redis.incr(key);
      // Set TTL to 1 hour so the key eventually expires if there is a crash/leak
      await redis.expire(key, 3600);
      return count;
    } catch (err) {
      logger.error('Failed to increment active jobs counter in Redis', { orgId, queueName, error: (err as Error).message });
      return 1;
    }
  }

  /**
   * Decrement active job count for an organization on a specific queue.
   */
  async decrementActiveJobs(orgId: string, queueName: string): Promise<void> {
    const key = `queue_count:${orgId}:${queueName}`;
    try {
      const count = await redis.decr(key);
      if (count <= 0) {
        await redis.del(key);
      }
    } catch (err) {
      logger.error('Failed to decrement active jobs counter in Redis', { orgId, queueName, error: (err as Error).message });
    }
  }

  /**
   * Get queue metrics for monitoring.
   */
  async getQueueMetrics(): Promise<Record<string, { waiting: number; active: number; delayed: number; failed: number }>> {
    const metrics: Record<string, any> = {};

    for (const [name, queue] of this.queues) {
      const [waiting, active, delayed, failed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getDelayedCount(),
        queue.getFailedCount(),
      ]);
      metrics[name] = { waiting, active, delayed, failed };
    }

    return metrics;
  }

  /**
   * Graceful shutdown — close all queues.
   */
  async close(): Promise<void> {
    for (const [name, queue] of this.queues) {
      await queue.close();
      logger.debug(`Queue ${name} closed`);
    }
    for (const [name, queue] of this.dynamicQueues) {
      await queue.close();
      logger.debug(`Dynamic queue ${name} closed`);
    }
    for (const [, events] of this.queueEvents) {
      await events.close();
    }
    logger.info('Event bus shut down');
  }
}

export const eventBus = new EventBus();
