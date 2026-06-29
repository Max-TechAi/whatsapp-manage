import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth/auth.middleware.js';
import * as orgService from './org.service.js';
import { logger } from '../../observability/logger.js';
import { wsServer } from '../../websocket/ws-server.js';
import { generateInvitationToken } from '../auth/auth.service.js';
import { emailService } from '../email/email.service.js';
import { redis } from '../../config/redis.js';

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

async function invalidateUserCache(userId: string): Promise<void> {
  try {
    await redis.del(`user_auth:${userId}`);
  } catch (err) {
    logger.warn('Failed to invalidate user auth cache', { userId, error: (err as Error).message });
  }
}

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

    // Fetch organization details for email template
    const org = await orgService.getOrganization(req.user!.orgId);
    const orgName = org?.name || 'our organization';
    const inviterName = req.user!.email;

    // Generate stateless invitation token
    const inviteToken = generateInvitationToken(member.id, req.user!.orgId);
    const inviteLink = `${req.protocol}://${req.get('host')}/set-password.html?token=${inviteToken}`;

    // Attempt to send email
    let emailSent = false;
    try {
      await emailService.sendInviteEmail(member.email, inviteLink, orgName, inviterName);
      emailSent = true;
    } catch (emailErr: any) {
      logger.error('Failed to send member invitation email', {
        userId: member.id,
        email: member.email,
        error: emailErr.message,
      });
    }

    res.status(201).json({
      success: true,
      member,
      inviteLink,
      emailSent,
    });
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
    wsServer.invalidateSessionAccess(userId);
    await invalidateUserCache(userId);
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

const updateMemberSchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  role: z.enum(['admin', 'agent']).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8, 'Password must be at least 8 characters').optional(),
});

const updatePermissionsSchema = z.object({
  hasAllSessionsAccess: z.boolean(),
  sessionIds: z.array(z.string().uuid()),
});

/**
 * PATCH /members/:userId
 * Update member details.
 */
orgRouter.patch('/members/:userId', async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId as string;
    const parsed = updateMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const member = await orgService.updateMember(req.user!.orgId, userId, parsed.data);
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    wsServer.invalidateSessionAccess(userId);
    await invalidateUserCache(userId);
    res.status(200).json({ member });
  } catch (error) {
    logger.error('Failed to update member', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /members/:userId/permissions
 * Retrieve member session permissions.
 */
orgRouter.get('/members/:userId/permissions', async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId as string;
    const permissions = await orgService.getMemberPermissions(req.user!.orgId, userId);
    res.status(200).json(permissions);
  } catch (error) {
    if (error instanceof Error && error.message === 'USER_NOT_FOUND') {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    logger.error('Failed to retrieve permissions', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /members/:userId/permissions
 * Update member session permissions.
 */
orgRouter.put('/members/:userId/permissions', async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId as string;
    const parsed = updatePermissionsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    await orgService.updateMemberPermissions(req.user!.orgId, userId, parsed.data);
    wsServer.invalidateSessionAccess(userId);
    await invalidateUserCache(userId);
    res.status(200).json({ success: true, message: 'Permissions updated successfully' });
  } catch (error) {
    if (error instanceof Error && error.message === 'USER_NOT_FOUND') {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    logger.error('Failed to update permissions', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /statistics
 * Fetch performance statistics for all employees in the organization.
 */
orgRouter.get('/statistics', async (req: Request, res: Response) => {
  try {
    const sessionId = req.query.sessionId as string | undefined;
    const dateRange = req.query.dateRange as string | undefined;

    let startDate: Date | undefined;
    let endDate: Date | undefined;

    if (dateRange && dateRange !== 'all_time') {
      const now = new Date();
      endDate = now;
      startDate = new Date();

      if (dateRange === 'today') {
        startDate.setHours(0, 0, 0, 0);
      } else if (dateRange === 'this_week') {
        const day = startDate.getDay();
        const diff = startDate.getDate() - day;
        startDate = new Date(startDate.setDate(diff));
        startDate.setHours(0, 0, 0, 0);
      } else if (dateRange === 'this_month') {
        startDate.setDate(1);
        startDate.setHours(0, 0, 0, 0);
      }
    }

    const statistics = await orgService.getEmployeeStatistics(req.user!.orgId, {
      sessionId,
      startDate,
      endDate,
    });

    res.status(200).json({ statistics });
  } catch (error) {
    logger.error('Failed to retrieve employee statistics', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});
