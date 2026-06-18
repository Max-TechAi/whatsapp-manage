import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth/auth.middleware.js';
import * as orgService from './org.service.js';
import { logger } from '../../observability/logger.js';

/* ------------------------------------------------------------------ */
/*  Validation Schemas                                                 */
/* ------------------------------------------------------------------ */

const updateOrgSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  settings: z.record(z.unknown()).optional(),
}).refine(
  (data) => data.name !== undefined || data.settings !== undefined,
  { message: 'At least one field (name or settings) must be provided' },
);

const inviteMemberSchema = z.object({
  email: z.string().email('Invalid email address'),
  role: z.enum(['admin', 'agent']).default('agent'),
});

/* ------------------------------------------------------------------ */
/*  Router                                                             */
/* ------------------------------------------------------------------ */

export const orgRouter = Router();

// All org routes require authentication and admin role
orgRouter.use(authenticate, requireRole('admin'));

/**
 * GET /
 * Get the current user's organization details.
 */
orgRouter.get('/', async (req: Request, res: Response) => {
  try {
    const org = await orgService.getOrganization(req.user!.orgId);

    if (!org) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }

    res.status(200).json({ organization: org });
  } catch (error) {
    logger.error('Failed to fetch organization', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /
 * Update the current user's organization.
 */
orgRouter.patch('/', async (req: Request, res: Response) => {
  try {
    const parsed = updateOrgSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const org = await orgService.updateOrganization(req.user!.orgId, parsed.data);

    if (!org) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }

    res.status(200).json({ organization: org });
  } catch (error) {
    logger.error('Failed to update organization', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /members
 * List all members of the current user's organization.
 */
orgRouter.get('/members', async (req: Request, res: Response) => {
  try {
    const members = await orgService.getMembers(req.user!.orgId);
    res.status(200).json({ members });
  } catch (error) {
    logger.error('Failed to fetch members', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /members
 * Invite a new member to the organization.
 */
orgRouter.post('/members', async (req: Request, res: Response) => {
  try {
    const parsed = inviteMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const member = await orgService.inviteMember(
      req.user!.orgId,
      parsed.data.email,
      parsed.data.role,
    );

    res.status(201).json({ member });
  } catch (error) {
    if (error instanceof Error && error.message === 'EMAIL_EXISTS') {
      res.status(400).json({ error: 'Email is already registered' });
      return;
    }
    logger.error('Failed to invite member', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /members/:userId
 * Remove (soft-delete) a member from the organization.
 */
orgRouter.delete('/members/:userId', async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId as string;

    // Prevent self-removal
    if (userId === req.user!.userId) {
      res.status(400).json({ error: 'Cannot remove yourself' });
      return;
    }

    await orgService.removeMember(req.user!.orgId, userId);
    res.status(200).json({ message: 'Member removed successfully' });
  } catch (error) {
    if (error instanceof Error && error.message === 'USER_NOT_FOUND') {
      res.status(404).json({ error: 'User not found in this organization' });
      return;
    }
    logger.error('Failed to remove member', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});
