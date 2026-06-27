import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeOptionalAuth, createRateLimiter } from './rate-limiter.js';
import { verifyToken } from '../modules/auth/auth.service.js';
import { redis } from '../config/redis.js';

// Mock auth.service.js
vi.mock('../modules/auth/auth.service.js', () => ({
  verifyToken: vi.fn(),
}));

// Mock config/redis.js
vi.mock('../config/redis.js', () => {
  const mockMulti = {
    zremrangebyscore: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    pexpire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([
      [null, 0], // zremrangebyscore
      [null, 1], // zadd
      [null, 1], // zcard
      [null, 1], // pexpire
    ]),
  };
  return {
    redis: {
      multi: vi.fn().mockReturnValue(mockMulti),
    },
  };
});

describe('decodeOptionalAuth Middleware', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should decode Bearer token and attach payload to req.user', () => {
    const req = {
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
    } as any;
    const res = {} as any;
    const next = vi.fn();

    const mockPayload = { userId: 'user-1', orgId: 'org-1', email: 'test@test.com', role: 'admin' };
    vi.mocked(verifyToken).mockReturnValue(mockPayload as any);

    decodeOptionalAuth(req, res, next);

    expect(verifyToken).toHaveBeenCalledWith('valid-jwt-token');
    expect(req.user).toEqual(mockPayload);
    expect(next).toHaveBeenCalled();
  });

  it('should fail silently and call next if authorization header is missing', () => {
    const req = {
      headers: {},
    } as any;
    const res = {} as any;
    const next = vi.fn();

    decodeOptionalAuth(req, res, next);

    expect(verifyToken).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('should fail silently and call next if token is invalid/expired', () => {
    const req = {
      headers: {
        authorization: 'Bearer expired-jwt-token',
      },
    } as any;
    const res = {} as any;
    const next = vi.fn();

    vi.mocked(verifyToken).mockImplementation(() => {
      throw new Error('Token expired');
    });

    decodeOptionalAuth(req, res, next);

    expect(verifyToken).toHaveBeenCalledWith('expired-jwt-token');
    expect(req.user).toBeUndefined(); // Remains undefined
    expect(next).toHaveBeenCalled();
  });
});

describe('Rate Limiter Scoping', () => {
  it('should scope rate-limiting key by orgId:userId if req.user is present', async () => {
    const req = {
      user: {
        orgId: 'org-1',
        userId: 'user-1',
      },
      ip: '127.0.0.1',
    } as any;
    const res = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    const limiter = createRateLimiter({
      windowMs: 60000,
      max: 100,
      keyPrefix: 'test',
    });

    await limiter(req, res, next);

    // Verify key passed to Redis multi commands contains the user scoped identifier
    const multiInstance = redis.multi();
    expect(redis.multi).toHaveBeenCalled();
    expect(multiInstance.zadd).toHaveBeenCalledWith(
      'ratelimit:test:org-1:user-1',
      expect.any(Number),
      expect.any(String)
    );
    expect(next).toHaveBeenCalled();
  });

  it('should scope rate-limiting key by req.ip if req.user is absent', async () => {
    const req = {
      ip: '192.168.1.50',
    } as any;
    const res = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    const limiter = createRateLimiter({
      windowMs: 60000,
      max: 100,
      keyPrefix: 'test',
    });

    await limiter(req, res, next);

    const multiInstance = redis.multi();
    expect(redis.multi).toHaveBeenCalled();
    expect(multiInstance.zadd).toHaveBeenCalledWith(
      'ratelimit:test:192.168.1.50',
      expect.any(Number),
      expect.any(String)
    );
    expect(next).toHaveBeenCalled();
  });
});
