import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import * as authService from './auth.service.js';
import { authenticate } from './auth.middleware.js';
import { db } from '../../config/database.js';
import { users } from '../../db/schema.js';
import { logger } from '../../observability/logger.js';
import { emailService } from '../email/email.service.js';
import { hashPassword } from '../../security/encryption.js';

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

    // Generate stateless email verification token
    const verifyToken = authService.generateVerificationToken(result.user.id);
    const verificationLink = `${req.protocol}://${req.get('host')}/api/auth/verify-email?token=${verifyToken}`;

    // Send email asynchronously so registration doesn't block on slow SMTP response
    emailService.sendVerificationEmail(result.user.email, verificationLink).catch((emailErr) => {
      logger.error('Failed to send verification email on registration', {
        userId: result.user.id,
        email: result.user.email,
        error: emailErr.message,
      });
    });

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

/**
 * GET /api/auth/verify-email?token=xxx
 * Verify user email from token.
 */
authRouter.get('/verify-email', async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string;
    if (!token) {
      res.status(400).json({ error: 'Verification token is required' });
      return;
    }

    const { userId } = authService.verifyVerificationToken(token);

    // Update user status
    const rows = await db
      .update(users)
      .set({ emailVerified: true, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id });

    if (rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Redirect to landing page with success parameter
    res.redirect('/?email_verified=true');
  } catch (error: any) {
    logger.error('Email verification error', { error: error.message });
    res.status(400).send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 50px; background-color: #0b0f19; color: #f3f4f6;">
          <h2 style="color: #ef4444;">Verification Failed</h2>
          <p>${error.message || 'The verification link is invalid or has expired.'}</p>
          <a href="/" style="color: #6366f1; text-decoration: none; font-weight: bold;">Go back to Login</a>
        </body>
      </html>
    `);
  }
});

/**
 * POST /api/auth/resend-verification
 * Resend verification email for an unverified account.
 */
authRouter.post('/resend-verification', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      email: z.string().email(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid email address' });
      return;
    }

    const email = parsed.data.email.toLowerCase();

    // Check if user exists and is not verified
    const [user] = await db
      .select({ id: users.id, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) {
      // Return 200 even if user doesn't exist for security reasons (don't expose email presence)
      res.status(200).json({ message: 'If the email exists and is unverified, a verification link has been sent.' });
      return;
    }

    if (user.emailVerified) {
      res.status(400).json({ error: 'Email is already verified' });
      return;
    }

    // Generate and send token
    const verifyToken = authService.generateVerificationToken(user.id);
    const verificationLink = `${req.protocol}://${req.get('host')}/api/auth/verify-email?token=${verifyToken}`;

    await emailService.sendVerificationEmail(email, verificationLink);

    res.status(200).json({ message: 'Verification email sent successfully' });
  } catch (error: any) {
    logger.error('Failed to resend verification email', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/set-password-from-invite
 * Set password for a newly invited team member using invitation token.
 */
authRouter.post('/set-password-from-invite', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      token: z.string().min(1, 'Token is required'),
      password: z.string().min(8, 'Password must be at least 8 characters'),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { userId } = authService.verifyInvitationToken(parsed.data.token);

    // Verify user exists
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Hash and update password, set emailVerified to true
    const passwordHash = await hashPassword(parsed.data.password);
    await db
      .update(users)
      .set({
        passwordHash,
        emailVerified: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    logger.info('Password set successfully from invitation', { userId });

    // Auto-login: generate auth tokens for the user
    const payload = {
      userId: user.id,
      orgId: user.orgId,
      email: user.email,
      role: user.role as 'admin' | 'agent',
      hasAllSessionsAccess: user.hasAllSessionsAccess,
      emailVerified: true,
    };

    const tokens = authService.generateTokens(payload);

    res.status(200).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        orgId: user.orgId,
      },
      tokens,
    });
  } catch (error: any) {
    logger.error('Set password from invitation failed', { error: error.message });
    res.status(400).json({ error: error.message || 'Invalid or expired invitation link' });
  }
});
