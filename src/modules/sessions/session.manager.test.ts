import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sessionManager } from './session.manager.js';
import { db } from '../../config/database.js';
import { redis } from '../../config/redis.js';

// Mock config/database.js
vi.mock('../../config/database.js', () => ({
  db: {
    update: vi.fn(),
    set: vi.fn(),
    where: vi.fn(),
    select: vi.fn(),
    from: vi.fn(),
    limit: vi.fn(),
  },
}));

// Mock config/redis.js
vi.mock('../../config/redis.js', () => ({
  redis: {
    eval: vi.fn().mockResolvedValue(1), // Success by default
    get: vi.fn().mockResolvedValue('replica-1'),
  },
  workerRedis: {
    duplicate: vi.fn().mockReturnValue({}),
  },
  queueRedis: {
    duplicate: vi.fn().mockReturnValue({}),
  },
  subRedis: {
    duplicate: vi.fn().mockReturnValue({}),
  },
}));

describe('SessionManager Watchdog Timer', () => {
  const sessionId = 'd3b07384-d113-4f21-a578-8316dfa996f0';
  const orgId = '7b9605cb-4a25-4c07-b3ea-37b518bb1389';
  let mockSocket: any;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSocket = {
      ev: {
        removeAllListeners: vi.fn(),
        on: vi.fn(),
      },
      end: vi.fn(),
    };

    // Re-apply database mock implementations before each test with type assertions
    vi.mocked((db as any).update).mockReturnValue(db as any);
    vi.mocked((db as any).set).mockReturnValue(db as any);
    vi.mocked((db as any).where).mockResolvedValue([] as any);
    vi.mocked((db as any).select).mockReturnValue(db as any);
    vi.mocked((db as any).from).mockReturnValue(db as any);
    vi.mocked((db as any).limit).mockResolvedValue([] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    // Clean up session manager state after each test
    (sessionManager as any).clearLockRenewal(sessionId);
    (sessionManager as any).activeSessions.delete(sessionId);
  });

  it('should start watchdog timer when lock renewal is started', () => {
    // Put dummy socket in active sessions
    (sessionManager as any).activeSessions.set(sessionId, {
      socket: mockSocket,
      sessionId,
      orgId,
      retryCount: 0,
      lastRetry: null,
    });

    (sessionManager as any).startLockRenewal(sessionId);

    // Verify lastSuccessfulRenewal is initialized to current time
    const lastRenewal = (sessionManager as any).lastSuccessfulRenewal.get(sessionId);
    expect(lastRenewal).toBeDefined();
    expect(lastRenewal).toBeLessThanOrEqual(Date.now());

    // Verify watchdog interval is created
    const watchdog = (sessionManager as any).watchdogIntervals.get(sessionId);
    expect(watchdog).toBeDefined();
  });

  it('should not terminate socket if heartbeat keeps lastSuccessfulRenewal fresh', async () => {
    const forceTerminateSpy = vi.spyOn(sessionManager, 'forceTerminateSocket');

    (sessionManager as any).activeSessions.set(sessionId, {
      socket: mockSocket,
      sessionId,
      orgId,
      retryCount: 0,
      lastRetry: null,
    });

    (sessionManager as any).startLockRenewal(sessionId);

    // Advance time by 6 seconds (heartbeat ticks twice at 3s and 6s, renewing last renewal time)
    // Mock redis.eval success
    vi.mocked(redis.eval).mockResolvedValue(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(forceTerminateSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(forceTerminateSpy).not.toHaveBeenCalled();

    // Verify the socket was never ended
    expect(mockSocket.end).not.toHaveBeenCalled();
    expect(forceTerminateSpy).not.toHaveBeenCalled();
  });

  it('should forcibly self-terminate socket if lastSuccessfulRenewal is stale for > 8s', async () => {
    const forceTerminateSpy = vi.spyOn(sessionManager, 'forceTerminateSocket');

    (sessionManager as any).activeSessions.set(sessionId, {
      socket: mockSocket,
      sessionId,
      orgId,
      retryCount: 0,
      lastRetry: null,
    });

    (sessionManager as any).startLockRenewal(sessionId);

    // Simulate Redis partition: mock redis.eval to throw or hang (never resolves / resolves false / we just don't update lastSuccessfulRenewal)
    // We manually freeze lastSuccessfulRenewal's update by making redis.eval throw
    vi.mocked(redis.eval).mockRejectedValue(new Error('Redis connection lost'));

    // Advance time past the 8-second threshold (e.g. 9 seconds)
    // Since the watchdog ticks every 2s, at 8s-10s it should see the last renewal was 9s ago (greater than 8s maxElapsed)
    // and fire forceTerminateSocket.
    await vi.advanceTimersByTimeAsync(9000);

    // The watchdog should have fired forceTerminateSocket
    expect(forceTerminateSpy).toHaveBeenCalledWith(sessionId);

    // Verify that mockSocket.end was called to terminate the socket connection
    expect(mockSocket.end).toHaveBeenCalled();
  });
});
