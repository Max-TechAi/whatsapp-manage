import type { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis.js';
import { getEnv } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { verifyToken } from '../modules/auth/auth.service.js';
import { classifyCredential, extractAuthCredential } from '../modules/auth/auth-credential.js';
import { verifyApiKeyAndResolveUser } from '../modules/api-keys/api-key.service.js';

interface RateLimitConfig {
  windowMs: number;
  max: number;
  keyPrefix: string;
  skip?: (req: Request) => boolean;
  resolveBucket?: (req: Request) => { identifier: string; max: number; keyPrefix: string };
}

/** POST /api/chats/:id/presence/subscribe — already gated by M2 Redis cooldown */
export function isPresenceSubscribeRequest(req: Request): boolean {
  return (
    req.method === 'POST' &&
    /^\/chats\/[^/]+\/presence\/subscribe\/?$/.test(req.path)
  );
}

/**
 * Optionally decode JWT or API key for rate-limit bucketing (fails silently).
 */
export async function decodeOptionalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractAuthCredential(req);
    if (!token) {
      next();
      return;
    }

    const method = classifyCredential(token);
    if (method === 'api_key') {
      const resolved = await verifyApiKeyAndResolveUser(token);
      if (resolved) {
        req.user = resolved.user;
        req.apiKeyId = resolved.apiKeyId;
        req.authMethod = 'api_key';
      }
    } else {
      const payload = verifyToken(token);
      req.user = payload;
      req.authMethod = 'jwt';
    }
  } catch {
    // Downstream authenticate middleware returns 401 when required
  }
  next();
}

export function createRateLimiter(config: RateLimitConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (config.skip?.(req)) {
      next();
      return;
    }

    const bucket = config.resolveBucket
      ? config.resolveBucket(req)
      : {
          identifier: req.user ? `${req.user.orgId}:${req.user.userId}` : (req.ip ?? 'unknown'),
          max: config.max,
          keyPrefix: config.keyPrefix,
        };

    const key = `ratelimit:${bucket.keyPrefix}:${bucket.identifier}`;
    const now = Date.now();
    const clearBefore = now - config.windowMs;

    try {
      const multi = redis.multi();
      multi.zremrangebyscore(key, 0, clearBefore);
      multi.zadd(key, now, now.toString());
      multi.zcard(key);
      multi.pexpire(key, config.windowMs);

      const results = await multi.exec();
      if (!results) {
        throw new Error('Redis transaction returned null');
      }

      const countResult = results[2];
      const count = typeof countResult[1] === 'number' ? countResult[1] : parseInt(countResult[1] as string, 10);

      const remaining = Math.max(0, bucket.max - count);
      const resetTime = now + config.windowMs;

      res.setHeader('X-RateLimit-Limit', bucket.max);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil(resetTime / 1000));

      if (count > bucket.max) {
        logger.warn('Rate limit exceeded', {
          identifier: bucket.identifier,
          prefix: bucket.keyPrefix,
          count,
          limit: bucket.max,
        });
        res.status(429).json({
          error: 'Too many requests, please try again later.',
        });
        return;
      }

      next();
    } catch (err) {
      logger.error('Rate limiter Redis error', { error: (err as Error).message });
      next();
    }
  };
}

const env = getEnv();

export const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: env.RATE_LIMIT_AUTH,
  keyPrefix: 'auth',
});

export const apiRateLimiter = createRateLimiter({
  windowMs: 1 * 60 * 1000,
  max: env.RATE_LIMIT_API,
  keyPrefix: 'api',
  skip: isPresenceSubscribeRequest,
  resolveBucket: (req) => {
    if (req.authMethod === 'api_key' && req.apiKeyId && req.user) {
      return {
        identifier: `${req.user.orgId}:${req.apiKeyId}`,
        max: env.RATE_LIMIT_API_KEY,
        keyPrefix: 'api-key',
      };
    }
    if (req.user) {
      return {
        identifier: `${req.user.orgId}:${req.user.userId}`,
        max: env.RATE_LIMIT_API,
        keyPrefix: 'api',
      };
    }
    return {
      identifier: req.ip ?? 'unknown',
      max: env.RATE_LIMIT_API,
      keyPrefix: 'api',
    };
  },
});
