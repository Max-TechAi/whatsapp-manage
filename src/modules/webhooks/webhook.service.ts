/**
 * Webhook Service — CRUD for webhook registrations.
 */

import crypto from 'node:crypto';
import { db } from '../../config/database.js';
import { webhooks, webhookDeliveries } from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { logger } from '../../observability/logger.js';
import type { Webhook, WebhookCreateRequest, WebhookDelivery } from './webhook.types.js';

export class WebhookService {
  /**
   * Create a new webhook.
   */
  async createWebhook(orgId: string, data: WebhookCreateRequest): Promise<Webhook> {
    const secret = data.secret ?? crypto.randomBytes(32).toString('hex');

    const [result] = await db
      .insert(webhooks)
      .values({
        orgId,
        url: data.url,
        secret,
        events: data.events as any,
      })
      .returning();

    logger.info('Webhook created', { webhookId: result.id, url: data.url });
    return result as unknown as Webhook;
  }

  /**
   * List all webhooks for an org.
   */
  async getWebhooks(orgId: string): Promise<Webhook[]> {
    const rows = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.orgId, orgId))
      .orderBy(desc(webhooks.createdAt));

    return rows as unknown as Webhook[];
  }

  /**
   * Get a single webhook.
   */
  async getWebhookById(orgId: string, webhookId: string): Promise<Webhook | null> {
    const [result] = await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.orgId, orgId), eq(webhooks.id, webhookId)))
      .limit(1);

    return (result as unknown as Webhook) ?? null;
  }

  /**
   * Update a webhook.
   */
  async updateWebhook(
    orgId: string,
    webhookId: string,
    data: Partial<WebhookCreateRequest & { isActive: boolean }>
  ): Promise<Webhook | null> {
    const updateData: Record<string, any> = { updatedAt: new Date() };

    if (data.url !== undefined) updateData.url = data.url;
    if (data.events !== undefined) updateData.events = data.events;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.isActive === true) updateData.failureCount = 0; // Reset on re-enable

    const [result] = await db
      .update(webhooks)
      .set(updateData)
      .where(and(eq(webhooks.orgId, orgId), eq(webhooks.id, webhookId)))
      .returning();

    return (result as unknown as Webhook) ?? null;
  }

  /**
   * Delete a webhook.
   */
  async deleteWebhook(orgId: string, webhookId: string): Promise<void> {
    await db
      .delete(webhooks)
      .where(and(eq(webhooks.orgId, orgId), eq(webhooks.id, webhookId)));
  }

  /**
   * Get recent delivery logs for a webhook.
   */
  async getDeliveryLogs(webhookId: string, limit = 20): Promise<WebhookDelivery[]> {
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(limit);

    return rows as unknown as WebhookDelivery[];
  }

  /**
   * Test a webhook by sending a test payload.
   */
  async testWebhook(orgId: string, webhookId: string): Promise<{ statusCode: number; response: string }> {
    const webhook = await this.getWebhookById(orgId, webhookId);
    if (!webhook) throw new Error('Webhook not found');

    const testPayload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      orgId,
      data: { message: 'This is a test webhook delivery' },
    };

    const body = JSON.stringify(testPayload);
    const signature = crypto
      .createHmac('sha256', webhook.secret)
      .update(body)
      .digest('hex');

    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${signature}`,
        'X-Webhook-Event': 'test',
      },
      body,
      signal: AbortSignal.timeout(10000),
    });

    const responseText = await response.text();
    return { statusCode: response.status, response: responseText.substring(0, 500) };
  }
}

export const webhookService = new WebhookService();
