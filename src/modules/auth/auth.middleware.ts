import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from './auth.service.js';
import { logger } from '../../observability/logger.js';
import type { JwtPayload, AuthMethod } from './auth.types.js';
import { db } from '../../config/database.js';
import { users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { redis } from '../../config/redis.js';
import { classifyCredential, extractAuthCredential } from './auth-credential.js';
import { verifyApiKeyAndResolveUser } from '../api-keys/api-key.service.js';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      authMethod?: AuthMethod;
      apiKeyId?: string;
    }
  }
}

async function loadUserFromDb(userId: string): Promise<{
  id: string;
  role: 'admin' | 'agent';
  isActive: boolean;
  hasAllSessionsAccess: boolean;
} | null> {
  const cacheKey = `user_auth:${userId}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    logger.warn('Failed to fetch auth from cache', { error: (err as Error).message });
  }

  const [user] = await db
    .select({
      id: users.id,
      role: users.role,
      isActive: users.isActive,
      hasAllSessionsAccess: users.hasAllSessionsAccess,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (user) {
    try {
      await redis.setex(cacheKey, 30, JSON.stringify(user));
    } catch (err) {
      logger.warn('Failed to store auth in cache', { error: (err as Error).message });
    }
  }

  return user ?? null;
}

/**
 * Authenticate via JWT Bearer token or API key (Bearer wa_live_... or X-API-Key).
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractAuthCredential(req);

    if (!token) {
      res.status(401).json({ error: 'Missing or malformed authorization credentials' });
      return;
    }

    const method = classifyCredential(token);
    req.authMethod = method;

    if (method === 'api_key') {
      const resolved = await verifyApiKeyAndResolveUser(token);
      if (!resolved) {
        res.status(401).json({ error: 'Invalid or expired API key' });
        return;
      }
      req.user = resolved.user;
      req.apiKeyId = resolved.apiKeyId;
      next();
      return;
    }

    const payload = verifyToken(token);
    const dbUser = await loadUserFromDb(payload.userId);

    if (!dbUser || !dbUser.isActive) {
      res.status(401).json({ error: 'User account is deactivated or does not exist' });
      return;
    }

    req.user = {
      ...payload,
      role: dbUser.role,
      hasAllSessionsAccess: dbUser.hasAllSessionsAccess,
    };

    next();
  } catch (error) {
    logger.warn('Authentication failed', {
      path: req.path,
      ip: req.ip,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Reject API-key-authenticated requests (management endpoints require JWT). */
export function requireJwt(req: Request, res: Response, next: NextFunction): void {
  if (req.authMethod === 'api_key') {
    res.status(403).json({
      error: 'This endpoint requires dashboard login (JWT). API keys cannot be used here.',
    });
    return;
  }
  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      logger.warn('Insufficient role', {
        userId: req.user.userId,
        requiredRoles: roles,
        actualRole: req.user.role,
      });
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
}

export function requireOrg(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const routeOrgId = req.params.orgId;

  if (!routeOrgId) {
    next();
    return;
  }

  if (req.user.orgId !== routeOrgId) {
    logger.warn('Org mismatch', {
      userId: req.user.userId,
      userOrgId: req.user.orgId,
      routeOrgId,
    });
    res.status(403).json({ error: 'Access denied: organization mismatch' });
    return;
  }

  next();
}
