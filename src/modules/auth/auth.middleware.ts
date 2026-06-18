import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from './auth.service.js';
import { logger } from '../../observability/logger.js';
import type { JwtPayload } from './auth.types.js';

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
export function authenticate(req: Request, res: Response, next: NextFunction): void {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or malformed authorization header' });
      return;
    }

    const token = authHeader.slice(7); // Strip 'Bearer '
    req.user = verifyToken(token);
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
