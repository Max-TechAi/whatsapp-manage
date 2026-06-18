import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import * as authService from './auth.service.js';
import { authenticate } from './auth.middleware.js';
import { db } from '../../config/database.js';
import { users } from '../../db/schema.js';
import { logger } from '../../observability/logger.js';

/* ------------------------------------------------------------------ */
/*  Validation Schemas                                                 */
/* ------------------------------------------------------------------ */

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().min(1, 'Display name is required').max(100),
  orgName: z.string().min(1, 'Organization name is required').max(200),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

/* ------------------------------------------------------------------ */
/*  Router                                                             */
/* ------------------------------------------------------------------ */

export const authRouter = Router();

/**
 * POST /register
 * Create a new organization and admin user.
 */
authRouter.post('/register', async (req: Request, res: Response) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const result = await authService.register(parsed.data);
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'EMAIL_EXISTS') {
      res.status(400).json({ error: 'Email is already registered' });
      return;
    }
    logger.error('Registration failed', { error: error instanceof Error ? error.message : 'Unknown' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /login
 * Authenticate with email and password.
 */
authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const result = await authService.login(parsed.data);
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_CREDENTIALS') {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    if (error instanceof Error && error.message === 'ACCOUNT_DISABLED') {
      res.status(401).json({ error: 'Account is disabled' });
      return;
    }
    logger.error('Login failed', { error: error instanceof Error ? error.message : 'Unknown' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /refresh
 * Exchange a valid refresh token for a new token pair.
 */
authRouter.post('/refresh', async (req: Request, res: Response) => {
  try {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const tokens = authService.refreshTokens(parsed.data.refreshToken);
    res.status(200).json(tokens);
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_REFRESH_TOKEN') {
      res.status(401).json({ error: 'Invalid refresh token' });
      return;
    }
    logger.error('Token refresh failed', { error: error instanceof Error ? error.message : 'Unknown' });
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

/**
 * GET /me
 * Return the current authenticated user's profile from the database.
 */
authRouter.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const rows = await db.select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      orgId: users.orgId,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
      .from(users)
      .where(eq(users.id, req.user.userId))
      .limit(1);

    const user = rows[0];
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.status(200).json({ user });
  } catch (error) {
    logger.error('Failed to fetch user profile', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});
