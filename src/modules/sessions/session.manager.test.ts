import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sessionManager } from './session.manager.js';
import { db } from '../../config/database.js';
import { redis } from '../../config/redis.js';

// Mock config/database.js using a chainable mock builder
vi.mock('../../config/database.js', () => {
  const dbMock = {
    update: vi.fn(),
    set: vi.fn(),
    where: vi.fn(),
    select: vi.fn(),
    from: vi.fn(),
    limit: vi.fn(),
    then: vi.fn(),
  };
  return { db: dbMock };
});

// Mock config/redis.js
vi.mock('../../config/redis.js', () => ({
  redis: {
    eval: vi.fn().mockResolvedValue(1), // Success by default
    get: vi.fn().mockResolvedValue('replica-1'),
    set: vi.fn().mockResolvedValue('OK'),
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

// Mock @whiskeysockets/baileys using plain function mocks immune to restoreAllMocks
vi.mock('@whiskeysockets/baileys', () => {
  return {
    default: () => ({
      ev: {
        on: () => {},
        removeAllListeners: () => {},
      },
      end: () => {},
    }),
    DisconnectReason: {
      loggedOut: 401,
    },
    Browsers: {
      macOS: () => ['macOS', 'Desktop'],
    },
    fetchLatestBaileysVersion: () => Promise.resolve({
      version: [6, 0, 0],
      isLatest: true,
    }),
  };
});

// Mock session.auth-state.js using plain function mocks immune to restoreAllMocks
vi.mock('./session.auth-state.js', () => ({
  usePostgresAuthState: () => Promise.resolve({
    state: {},
    saveCreds: () => Promise.resolve(),
  }),
}));

// Mock event-bus.js using plain function mocks immune to restoreAllMocks
vi.mock('../../events/event-bus.js', () => ({
  eventBus: {
    publishToStream: () => Promise.resolve(),
  },
  STREAMS: {
    SESSIONS: 'sessions-stream',
  },
}));

describe('SessionManager Watchdog Timer', () => {
  const sessionId = 'd3b07384-d113-4f21-a578-8316dfa996f0';
  const orgId = '7b9605cb-4a25-4c07-b3ea-37b518bb1389';
  let mockSocket: any;

  beforeEach(() => {
    process.env.RUN_SESSION_RUNNER = 'true';
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
    vi.mocked((db as any).where).mockReturnValue(db as any);
    vi.mocked((db as any).select).mockReturnValue(db as any);
    vi.mocked((db as any).from).mockReturnValue(db as any);
    vi.mocked((db as any).limit).mockReturnValue(db as any);

    // Setup mock query resolutions sequentially via thenable `.then`
    let callCount = 0;
    (db as any).then = (onFulfilled: any) => {
      callCount++;
      if (callCount === 1) {
        // First select in restoreAllSessions returns the list of sessions
        return Promise.resolve([{ id: sessionId, orgId: orgId }]).then(onFulfilled);
      } else {
        // Second select in initializeSocket returns session metadata
        return Promise.resolve([{ metadata: { historySyncCompleted: true } }]).then(onFulfilled);
      }
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    // Clean up session manager state after each test
    (sessionManager as any).clearLockRenewal(sessionId);
    (sessionManager as any).activeSessions.delete(sessionId);
    (sessionManager as any).initializingSessions.clear();
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

  it('should run full socket initialization and register watchdog during restoreAllSessions', async () => {
    // Mock Redis ownership checking and set-lock behavior to act as if we are the sole owner
    vi.mocked(redis.get).mockResolvedValue(sessionManager.replicaId);
    vi.mocked(redis.set).mockResolvedValue('OK');

    // Spies on key methods
    const initializeSocketSpy = vi.spyOn(sessionManager, 'initializeSocket');
    const startLockRenewalSpy = vi.spyOn(sessionManager as any, 'startLockRenewal');

    // Trigger restoration
    const restorePromise = sessionManager.restoreAllSessions();

    // Fast-forward timers by 1.5 seconds to bypass the fencing delay
    await vi.advanceTimersByTimeAsync(1500);

    await restorePromise;

    // Verify results
    expect(initializeSocketSpy).toHaveBeenCalledWith(sessionId, orgId);
    expect(startLockRenewalSpy).toHaveBeenCalledWith(sessionId);

    // Verify that watchdog and heartbeat timers are active in memory
    const watchdog = (sessionManager as any).watchdogIntervals.get(sessionId);
    const heartbeat = (sessionManager as any).lockRenewals.get(sessionId);
    expect(watchdog).toBeDefined();
    expect(heartbeat).toBeDefined();

    // Verify socket was stored in activeSessions
    const active = sessionManager.getSession(sessionId);
    expect(active).toBeDefined();
    expect(active?.socket).toBeDefined();
  });
});
