import type { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis.js';
import { getEnv } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { verifyToken } from '../modules/auth/auth.service.js';

interface RateLimitConfig {
  windowMs: number;
  max: number;
  keyPrefix: string;
}

/**
 * Lightweight middleware that optionally decodes a JWT token if present.
 * Populates req.user with the payload so the rate limiter can use it.
 * Fails silently for public routes / missing tokens, leaving req.user undefined.
 */
export function decodeOptionalAuth(req: Request, res: Response, next: NextFunction): void {
  try {
    let token: string | undefined;
    const authHeader = req.headers.authorization;

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7); // Strip 'Bearer '
    } else if (req.query.token) {
      token = req.query.token as string;
    }

    if (token) {
      const payload = verifyToken(token);
      req.user = payload;
    }
  } catch (err) {
    // Fail silently: downstream auth middleware will handle throwing 401
  }
  next();
}

/**
 * Custom sliding window rate limiter using Redis sorted sets.
 */
export function createRateLimiter(config: RateLimitConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // If auth middleware has run, scope by orgId/userId. Otherwise by IP.
    const identifier = req.user ? `${req.user.orgId}:${req.user.userId}` : req.ip;
    const key = `ratelimit:${config.keyPrefix}:${identifier}`;
    const now = Date.now();
    const clearBefore = now - config.windowMs;

    try {
      const multi = redis.multi();
      // Remove timestamps older than the window
      multi.zremrangebyscore(key, 0, clearBefore);
      // Add current timestamp
      multi.zadd(key, now, now.toString());
      // Get count of requests in current window
      multi.zcard(key);
      // Refresh key TTL to window size
      multi.pexpire(key, config.windowMs);

      const results = await multi.exec();
      if (!results) {
        throw new Error('Redis transaction returned null');
      }

      // zcard result is at index 2 (third command in multi)
      const countResult = results[2];
      const count = typeof countResult[1] === 'number' ? countResult[1] : parseInt(countResult[1] as string, 10);

      const remaining = Math.max(0, config.max - count);
      const resetTime = now + config.windowMs;

      res.setHeader('X-RateLimit-Limit', config.max);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil(resetTime / 1000));

      if (count > config.max) {
        logger.warn('Rate limit exceeded', {
          identifier,
          prefix: config.keyPrefix,
          count,
          limit: config.max,
        });
        res.status(429).json({
          error: 'Too many requests, please try again later.',
        });
        return;
      }

      next();
    } catch (err) {
      // Fail open if Redis is down, but log the error
      logger.error('Rate limiter Redis error', { error: (err as Error).message });
      next();
    }
  };
}

const env = getEnv();

// Specific rate limit middleware instances
export const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 mins
  max: env.RATE_LIMIT_AUTH,
  keyPrefix: 'auth',
});

export const apiRateLimiter = createRateLimiter({
  windowMs: 1 * 60 * 1000, // 1 min
  max: env.RATE_LIMIT_API,
  keyPrefix: 'api',
});
