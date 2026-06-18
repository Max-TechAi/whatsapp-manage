/**
 * Contact Routes — REST API for contact operations.
 */

import { Router } from 'express';
import { z } from 'zod';
import { contactService } from './contact.service.js';
import { authenticate } from '../auth/auth.middleware.js';
import { logger } from '../../observability/logger.js';

export const contactRouter = Router();

contactRouter.use(authenticate);

/**
 * GET /api/contacts?sessionId=...&search=...&limit=50&offset=0
 * List contacts with optional search.
 */
contactRouter.get('/', async (req, res) => {
  try {
    const schema = z.object({
      sessionId: z.string().uuid(),
      search: z.string().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    });

    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.flatten() });
    }

    const result = await contactService.getContacts(req.user!.orgId, parsed.data);
    return res.json(result);
  } catch (err) {
    logger.error('Failed to list contacts', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to list contacts' });
  }
});

/**
 * GET /api/contacts/:id
 * Get a single contact.
 */
contactRouter.get('/:id', async (req, res) => {
  try {
    const contact = await contactService.getContactById(req.user!.orgId, req.params.id);
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    return res.json(contact);
  } catch (err) {
    logger.error('Failed to get contact', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to get contact' });
  }
});

/**
 * PATCH /api/contacts/:id
 * Update contact display name or metadata.
 */
contactRouter.patch('/:id', async (req, res) => {
  try {
    const schema = z.object({
      displayName: z.string().max(100).optional(),
      metadata: z.record(z.unknown()).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const contact = await contactService.updateContact(req.user!.orgId, req.params.id, parsed.data);
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    return res.json(contact);
  } catch (err) {
    logger.error('Failed to update contact', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to update contact' });
  }
});

/**
 * DELETE /api/contacts/:id
 * Delete a contact.
 */
contactRouter.delete('/:id', async (req, res) => {
  try {
    await contactService.deleteContact(req.user!.orgId, req.params.id);
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete contact', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to delete contact' });
  }
});
