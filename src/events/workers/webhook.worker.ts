/**
 * Webhook Worker — delivers events to registered webhook endpoints.
 * Uses HMAC-SHA256 signing, exponential backoff, and circuit breaker.
 */

import { Worker, Job } from 'bullmq';
import crypto from 'node:crypto';
import { workerRedis } from '../../config/redis.js';
import { db } from '../../config/database.js';
import { webhooks, webhookDeliveries } from '../../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { QUEUES, eventBus } from '../event-bus.js';
import { logger } from '../../observability/logger.js';

interface WebhookDeliveryJob {
  orgId: string;
  event: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

const MAX_FAILURE_COUNT = 10; // Disable webhook after 10 consecutive failures

export function createWebhookWorker(): Worker {
  const worker = new Worker<WebhookDeliveryJob>(
    QUEUES.WEBHOOK_DELIVERY,
    async (job: Job<WebhookDeliveryJob>) => {
      const { orgId, event, payload, timestamp } = job.data;

      // Find all active webhooks for this org that subscribe to this event
      const activeWebhooks = await db
        .select()
        .from(webhooks)
        .where(
          and(
            eq(webhooks.orgId, orgId),
            eq(webhooks.isActive, true),
            sql`webhooks.failure_count < ${MAX_FAILURE_COUNT}`,
            sql`webhooks.events @> ${JSON.stringify([event])}::jsonb`
          )
        );

      if (activeWebhooks.length === 0) return { delivered: 0 };

      let delivered = 0;

      for (const webhook of activeWebhooks) {
        const webhookPayload = {
          event,
          timestamp,
          orgId,
          data: payload,
        };

        const body = JSON.stringify(webhookPayload);

        // HMAC-SHA256 signature
        const signature = crypto
          .createHmac('sha256', webhook.secret)
          .update(body)
          .digest('hex');

        let statusCode: number | null = null;
        let responseText: string | null = null;

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

          const response = await fetch(webhook.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Signature': `sha256=${signature}`,
              'X-Webhook-Event': event,
              'X-Webhook-Timestamp': timestamp,
              'User-Agent': 'WhatsApp-Business-API/1.0',
            },
            body,
            signal: controller.signal,
          });

          clearTimeout(timeout);
          statusCode = response.status;
          responseText = await response.text().catch(() => null);

          if (response.ok) {
            // Success — reset failure count
            await db
              .update(webhooks)
              .set({
                failureCount: 0,
                lastTriggeredAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(webhooks.id, webhook.id));
            delivered++;
          } else {
            // HTTP error — increment failure count
            await db
              .update(webhooks)
              .set({
                failureCount: sql`webhooks.failure_count + 1`,
                lastTriggeredAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(webhooks.id, webhook.id));

            logger.warn('Webhook delivery failed', {
              webhookId: webhook.id,
              url: webhook.url,
              statusCode,
              event,
            });
          }
        } catch (err) {
          // Network error
          await db
            .update(webhooks)
            .set({
              failureCount: sql`webhooks.failure_count + 1`,
              updatedAt: new Date(),
            })
            .where(eq(webhooks.id, webhook.id));

          logger.error('Webhook delivery error', {
            webhookId: webhook.id,
            url: webhook.url,
            error: (err as Error).message,
          });
        }

        // Log delivery attempt
        await db.insert(webhookDeliveries).values({
          webhookId: webhook.id,
          event,
          payload: webhookPayload,
          statusCode,
          response: responseText?.substring(0, 1000) ?? null,
          attempts: job.attemptsMade + 1,
          deliveredAt: statusCode && statusCode >= 200 && statusCode < 300 ? new Date() : null,
        });
      }

      return { delivered, total: activeWebhooks.length };
    },
    {
      connection: workerRedis.duplicate() as any,
      concurrency: 10,
    }
  );

  worker.on('completed', (job) => {
    if (job?.data?.orgId) {
      eventBus.decrementActiveJobs(job.data.orgId, QUEUES.WEBHOOK_DELIVERY).catch((err) => {
        logger.warn('Failed to decrement active jobs on completion', { error: err.message });
      });
    }
  });

  worker.on('failed', (job, err) => {
    logger.error(`Webhook job ${job?.id} failed`, { error: err.message });
    if (job?.data?.orgId) {
      const attempts = job.opts?.attempts ?? 1;
      if (job.attemptsMade >= attempts) {
        eventBus.decrementActiveJobs(job.data.orgId, QUEUES.WEBHOOK_DELIVERY).catch((err) => {
          logger.warn('Failed to decrement active jobs on failure', { error: err.message });
        });
      }
    }
  });

  return worker;
}
