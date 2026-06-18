/**
 * Webhook Routes — REST API for webhook management.
 */

import { Router } from 'express';
import { z } from 'zod';
import { webhookService } from './webhook.service.js';
import { authenticate, requireRole } from '../auth/auth.middleware.js';
import { logger } from '../../observability/logger.js';

const VALID_EVENTS = [
  'message.received', 'message.sent', 'message.delivered', 'message.read', 'message.deleted',
  'session.connected', 'session.disconnected',
  'chat.created', 'chat.updated',
  'contact.created', 'contact.updated',
] as const;

export const webhookRouter = Router();

webhookRouter.use(authenticate);
webhookRouter.use(requireRole('admin'));

/**
 * POST /api/webhooks
 * Create a new webhook.
 */
webhookRouter.post('/', async (req, res) => {
  try {
    const schema = z.object({
      url: z.string().url(),
      events: z.array(z.enum(VALID_EVENTS)).min(1),
      secret: z.string().min(16).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const webhook = await webhookService.createWebhook(req.user!.orgId, parsed.data);
    return res.status(201).json(webhook);
  } catch (err) {
    logger.error('Failed to create webhook', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to create webhook' });
  }
});

/**
 * GET /api/webhooks
 * List all webhooks.
 */
webhookRouter.get('/', async (req, res) => {
  try {
    const webhooks = await webhookService.getWebhooks(req.user!.orgId);
    return res.json(webhooks);
  } catch (err) {
    logger.error('Failed to list webhooks', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to list webhooks' });
  }
});

/**
 * GET /api/webhooks/:id
 * Get a webhook with recent delivery logs.
 */
webhookRouter.get('/:id', async (req, res) => {
  try {
    const webhook = await webhookService.getWebhookById(req.user!.orgId, req.params.id);
    if (!webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    const deliveries = await webhookService.getDeliveryLogs(req.params.id, 10);
    return res.json({ ...webhook, recentDeliveries: deliveries });
  } catch (err) {
    logger.error('Failed to get webhook', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to get webhook' });
  }
});

/**
 * PATCH /api/webhooks/:id
 * Update a webhook.
 */
webhookRouter.patch('/:id', async (req, res) => {
  try {
    const schema = z.object({
      url: z.string().url().optional(),
      events: z.array(z.enum(VALID_EVENTS)).min(1).optional(),
      isActive: z.boolean().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const webhook = await webhookService.updateWebhook(req.user!.orgId, req.params.id, parsed.data);
    if (!webhook) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    return res.json(webhook);
  } catch (err) {
    logger.error('Failed to update webhook', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to update webhook' });
  }
});

/**
 * POST /api/webhooks/:id/test
 * Send a test payload.
 */
webhookRouter.post('/:id/test', async (req, res) => {
  try {
    const result = await webhookService.testWebhook(req.user!.orgId, req.params.id);
    return res.json(result);
  } catch (err) {
    logger.error('Webhook test failed', { error: (err as Error).message });
    return res.status(500).json({ error: 'Webhook test failed' });
  }
});

/**
 * DELETE /api/webhooks/:id
 * Delete a webhook.
 */
webhookRouter.delete('/:id', async (req, res) => {
  try {
    await webhookService.deleteWebhook(req.user!.orgId, req.params.id);
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete webhook', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to delete webhook' });
  }
});
