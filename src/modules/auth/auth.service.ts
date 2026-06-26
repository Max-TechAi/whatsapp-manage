import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { users, organizations } from '../../db/schema.js';
import { getEnv } from '../../config/env.js';
import { hashPassword, verifyPassword } from '../../security/encryption.js';
import { logger } from '../../observability/logger.js';
import type { JwtPayload, AuthTokens, RegisterRequest, LoginRequest, AuthResponse } from './auth.types.js';

/**
 * Create a URL-friendly slug from an organization name.
 * Lowercases, replaces non-alphanumeric chars with hyphens, trims, and appends a short random suffix.
 */
function createSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = uuidv4().slice(0, 8);
  return `${base}-${suffix}`;
}

/**
 * Register a new organization and its first admin user.
 * Both records are created inside a single database transaction
 * to guarantee atomicity — if either insert fails, everything rolls back.
 *
 * @param data - Registration payload (email, password, displayName, orgName)
 * @returns AuthResponse with user info and JWT tokens
 * @throws Error if the email is already registered
 */
export async function register(data: RegisterRequest): Promise<AuthResponse> {
  const env = getEnv();

  // Check for existing user with this email
  const existing = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.email, data.email.toLowerCase()))
    .limit(1);

  if (existing.length > 0) {
    throw new Error('EMAIL_EXISTS');
  }

  const orgId = uuidv4();
  const userId = uuidv4();
  const passwordHash = await hashPassword(data.password);
  const slug = createSlug(data.orgName);
  const now = new Date();

  // Transaction: create org + user atomically
  await db.transaction(async (tx) => {
    await tx.insert(organizations).values({
      id: orgId,
      name: data.orgName,
      slug,
      plan: 'free',
      settings: {},
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(users).values({
      id: userId,
      orgId,
      email: data.email.toLowerCase(),
      passwordHash,
      displayName: data.displayName,
      role: 'admin',
      isActive: true,
      hasAllSessionsAccess: true,
      createdAt: now,
      updatedAt: now,
    });
  });

  logger.info('New organization registered', { orgId, userId });

  const payload: JwtPayload = {
    userId,
    orgId,
    email: data.email.toLowerCase(),
    role: 'admin',
    hasAllSessionsAccess: true,
    emailVerified: false,
  };

  const tokens = generateTokens(payload);

  return {
    user: {
      id: userId,
      email: data.email.toLowerCase(),
      displayName: data.displayName,
      role: 'admin',
      orgId,
    },
    tokens,
  };
}

/**
 * Authenticate a user with email and password.
 *
 * @param data - Login payload (email, password)
 * @returns AuthResponse with user info and JWT tokens
 * @throws Error with code INVALID_CREDENTIALS or ACCOUNT_DISABLED
 */
export async function login(data: LoginRequest): Promise<AuthResponse> {
  const rows = await db.select()
    .from(users)
    .where(eq(users.email, data.email.toLowerCase()))
    .limit(1);

  const user = rows[0];

  if (!user) {
    throw new Error('INVALID_CREDENTIALS');
  }

  const passwordValid = await verifyPassword(data.password, user.passwordHash);
  if (!passwordValid) {
    throw new Error('INVALID_CREDENTIALS');
  }

  if (!user.isActive) {
    throw new Error('ACCOUNT_DISABLED');
  }

  // Update last login timestamp
  await db.update(users)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  logger.info('User logged in', { userId: user.id, orgId: user.orgId });

  const payload: JwtPayload = {
    userId: user.id,
    orgId: user.orgId,
    email: user.email,
    role: user.role as 'admin' | 'agent',
    hasAllSessionsAccess: user.hasAllSessionsAccess,
    emailVerified: user.emailVerified,
  };

  const tokens = generateTokens(payload);

  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      orgId: user.orgId,
    },
    tokens,
  };
}

/**
 * Generate an access + refresh token pair.
 * Access token has a short TTL for API calls; refresh token has a longer TTL
 * and is used only to obtain new access tokens.
 *
 * @param payload - Claims to embed in the token
 * @returns Token pair with expiration info
 */
export function generateTokens(payload: JwtPayload): AuthTokens {
  const env = getEnv();

  const accessToken = jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as any,
    issuer: 'whatsapp-api',
    subject: payload.userId,
  });

  const refreshToken = jwt.sign(
    { ...payload, type: 'refresh' },
    env.JWT_SECRET,
    {
      expiresIn: env.JWT_REFRESH_EXPIRES_IN as any,
      issuer: 'whatsapp-api',
      subject: payload.userId,
    },
  );

  return {
    accessToken,
    refreshToken,
    expiresIn: env.JWT_EXPIRES_IN,
  };
}

/**
 * Verify and decode a JWT access token.
 *
 * @param token - Raw JWT string
 * @returns Decoded payload
 * @throws JsonWebTokenError if the token is invalid or expired
 */
export function verifyToken(token: string): JwtPayload {
  const env = getEnv();
  const decoded = jwt.verify(token, env.JWT_SECRET, {
    issuer: 'whatsapp-api',
  }) as jwt.JwtPayload & JwtPayload;

  return {
    userId: decoded.userId,
    orgId: decoded.orgId,
    email: decoded.email,
    role: decoded.role,
    hasAllSessionsAccess: decoded.hasAllSessionsAccess,
    emailVerified: decoded.emailVerified,
  };
}

/**
 * Validate a refresh token and issue a fresh access + refresh pair.
 * The old refresh token is implicitly invalidated by the new expiry.
 *
 * @param refreshToken - The refresh token to validate
 * @returns New token pair
 * @throws Error if the refresh token is invalid
 */
export function refreshTokens(refreshToken: string): AuthTokens {
  const env = getEnv();
  const decoded = jwt.verify(refreshToken, env.JWT_SECRET, {
    issuer: 'whatsapp-api',
  }) as jwt.JwtPayload & JwtPayload & { type?: string };

  if (decoded.type !== 'refresh') {
    throw new Error('INVALID_REFRESH_TOKEN');
  }

  const payload: JwtPayload = {
    userId: decoded.userId,
    orgId: decoded.orgId,
    email: decoded.email,
    role: decoded.role,
    hasAllSessionsAccess: decoded.hasAllSessionsAccess,
    emailVerified: decoded.emailVerified,
  };

  return generateTokens(payload);
}

/**
 * Generate a token for email verification.
 */
export function generateVerificationToken(userId: string): string {
  const env = getEnv();
  return jwt.sign(
    { type: 'email_verification', userId },
    env.JWT_SECRET,
    { expiresIn: '24h', issuer: 'whatsapp-api' }
  );
}

/**
 * Generate a token for member invitation.
 */
export function generateInvitationToken(userId: string, orgId: string): string {
  const env = getEnv();
  return jwt.sign(
    { type: 'member_invitation', userId, orgId },
    env.JWT_SECRET,
    { expiresIn: '48h', issuer: 'whatsapp-api' }
  );
}

/**
 * Verify an email verification token.
 */
export function verifyVerificationToken(token: string): { userId: string } {
  const env = getEnv();
  const decoded = jwt.verify(token, env.JWT_SECRET, {
    issuer: 'whatsapp-api',
  }) as { type?: string; userId: string };

  if (decoded.type !== 'email_verification') {
    throw new Error('INVALID_TOKEN_TYPE');
  }

  return { userId: decoded.userId };
}

/**
 * Verify a member invitation token.
 */
export function verifyInvitationToken(token: string): { userId: string; orgId: string } {
  const env = getEnv();
  const decoded = jwt.verify(token, env.JWT_SECRET, {
    issuer: 'whatsapp-api',
  }) as { type?: string; userId: string; orgId: string };

  if (decoded.type !== 'member_invitation') {
    throw new Error('INVALID_TOKEN_TYPE');
  }

  return { userId: decoded.userId, orgId: decoded.orgId };
}
