/**
 * Event Bus — BullMQ queues + Redis Streams for reliable message processing.
 * Central hub connecting Baileys events to workers and WebSocket broadcast.
 */

import { Queue, QueueEvents } from 'bullmq';
import { queueRedis, redis } from '../config/redis.js';
import { logger } from '../observability/logger.js';

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

  constructor() {
    // Initialize all queues
    for (const [, name] of Object.entries(QUEUES)) {
      const queue = new Queue(name, {
        connection: queueRedis.duplicate() as any,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 5000 },
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
          jobId: `${sessionId}:${msg.key?.id ?? Date.now()}`,
          priority: type === 'notify' ? 1 : 10, // Real-time messages get priority
        }
      );
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
    }
  ): Promise<string> {
    const queue = this.getQueue(QUEUES.MESSAGE_OUTBOUND);

    const job = await queue.add(
      'send-message',
      { sessionId, orgId, ...data, enqueuedAt: new Date().toISOString() },
      {
        // Rate limit: 1 message every 2 seconds per session
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
    const queue = this.getQueue(QUEUES.MEDIA_DOWNLOAD);
    await queue.add('download', {
      sessionId,
      orgId,
      messageId,
      messageData,
    });
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
    await queue.add(
      'sync',
      { sessionId, orgId, data },
      {
        attempts: 3,
        backoff: { type: 'fixed', delay: 5000 },
        priority: 5,
      }
    );
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
    await queue.add('deliver', {
      orgId,
      event,
      payload,
      timestamp: new Date().toISOString(),
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
    await queue.add('sync', { sessionId, orgId, contacts });
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
    await queue.add(action, { sessionId, orgId, chats: chatsData, action });
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
    for (const [, events] of this.queueEvents) {
      await events.close();
    }
    logger.info('Event bus shut down');
  }
}

export const eventBus = new EventBus();
