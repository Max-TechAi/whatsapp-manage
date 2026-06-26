import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from './auth.service.js';
import { logger } from '../../observability/logger.js';
import type { JwtPayload } from './auth.types.js';
import { db } from '../../config/database.js';
import { users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { redis } from '../../config/redis.js';

/* ------------------------------------------------------------------ */
/*  Augment Express Request with authenticated user payload            */
/* ------------------------------------------------------------------ */

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Middleware                                                          */
/* ------------------------------------------------------------------ */

/**
 * Authenticate incoming requests via Bearer token.
 * Extracts the JWT from the Authorization header, verifies it,
 * and attaches the decoded payload to `req.user`.
 *
 * Returns 401 if the token is missing or invalid.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    let token: string | undefined;
    const authHeader = req.headers.authorization;

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7); // Strip 'Bearer '
    } else if (req.query.token) {
      token = req.query.token as string;
    }

    if (!token) {
      res.status(401).json({ error: 'Missing or malformed authorization credentials' });
      return;
    }

    const payload = verifyToken(token);

    const cacheKey = `user_auth:${payload.userId}`;
    let dbUser: { id: string; role: 'admin' | 'agent'; isActive: boolean; hasAllSessionsAccess: boolean } | null = null;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        dbUser = JSON.parse(cached);
      }
    } catch (err) {
      logger.warn('Failed to fetch auth from cache', { error: (err as Error).message });
    }

    if (!dbUser) {
      // Fetch latest user status and permissions from database
      const [user] = await db
        .select({
          id: users.id,
          role: users.role,
          isActive: users.isActive,
          hasAllSessionsAccess: users.hasAllSessionsAccess,
        })
        .from(users)
        .where(eq(users.id, payload.userId))
        .limit(1);

      if (user) {
        dbUser = user;
        try {
          // Cache user auth details for 30 seconds
          await redis.setex(cacheKey, 30, JSON.stringify(user));
        } catch (err) {
          logger.warn('Failed to store auth in cache', { error: (err as Error).message });
        }
      }
    }

    if (!dbUser || !dbUser.isActive) {
      res.status(401).json({ error: 'User account is deactivated or does not exist' });
      return;
    }

    // Attach user payload with fresh role and access flags from DB
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

/**
 * Require the authenticated user to have one of the specified roles.
 * Must be placed after `authenticate` in the middleware chain.
 *
 * @param roles - Allowed roles (e.g. 'admin', 'agent')
 * @returns Express middleware
 *
 * @example
 * router.use(authenticate, requireRole('admin'));
 */
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

/**
 * Ensure the authenticated user's orgId matches the `orgId` route parameter.
 * Prevents cross-tenant data access when routes include `:orgId`.
 * Must be placed after `authenticate` in the middleware chain.
 *
 * If no `:orgId` param is present on the route, this middleware passes through.
 */
export function requireOrg(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const routeOrgId = req.params.orgId;

  // If route doesn't have an orgId param, allow through
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
