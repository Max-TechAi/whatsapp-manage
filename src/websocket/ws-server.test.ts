import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wsServer } from './ws-server.js';
import { redis } from '../config/redis.js';

// Mock config/redis.js with all required connection exports
vi.mock('../config/redis.js', () => {
  const mockRedis = {
    duplicate: vi.fn(),
    xread: vi.fn(),
  };
  return {
    redis: mockRedis,
    subRedis: mockRedis,
    queueRedis: {
      duplicate: vi.fn().mockReturnValue({}),
    },
    workerRedis: {
      duplicate: vi.fn().mockReturnValue({}),
    },
  };
});

// Mock config/database.js
vi.mock('../config/database.js', () => ({
  db: {},
  getDirectClient: vi.fn(),
}));

// Mock config/env.js
vi.mock('../config/env.js', () => ({
  getEnv: vi.fn().mockReturnValue({
    WS_PORT: 3001,
  }),
}));

// Mock ws module
vi.mock('ws', () => {
  return {
    WebSocketServer: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      clients: new Set(),
    })),
    WebSocket: {
      OPEN: 1,
    },
  };
});

// Mock auth.service.js
vi.mock('../modules/auth/auth.service.js', () => ({
  verifyToken: vi.fn(),
}));

// Mock session.manager.js
vi.mock('../modules/sessions/session.manager.js', () => ({
  sessionManager: {
    replicaId: 'replica-test',
    getSession: vi.fn(),
  },
}));

describe('WsServer Stream Fan-Out Reader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    (wsServer as any).streamReaderRunning = false;
    if ((wsServer as any).streamRedis) {
      (wsServer as any).streamRedis = undefined;
    }
  });

  it('should initialize lastIds to $ and invoke direct xread', async () => {
    const mockDuplicatedRedis = {
      xread: vi.fn(),
      on: vi.fn(),
    };
    vi.mocked(redis.duplicate).mockReturnValue(mockDuplicatedRedis as any);

    // Stop loop after first execution to prevent infinite loop / OOM
    mockDuplicatedRedis.xread.mockImplementation(async () => {
      (wsServer as any).streamReaderRunning = false;
      return null;
    });

    // Call private startStreamReader
    (wsServer as any).startStreamReader();

    expect(redis.duplicate).toHaveBeenCalled();
    expect(mockDuplicatedRedis.on).toHaveBeenCalledWith('error', expect.any(Function));

    // Run ticks to let loop execute once
    await vi.advanceTimersByTimeAsync(0);

    // Verify it called xread with $ offsets
    expect(mockDuplicatedRedis.xread).toHaveBeenCalledWith(
      'COUNT', '50',
      'BLOCK', '5000',
      'STREAMS',
      'events:messages', 'events:sessions', 'events:presence', 'events:chats',
      '$', '$', '$', '$'
    );
  });

  it('should update offset map to last read message ID when messages are returned', async () => {
    const mockDuplicatedRedis = {
      xread: vi.fn(),
      on: vi.fn(),
    };
    vi.mocked(redis.duplicate).mockReturnValue(mockDuplicatedRedis as any);

    // Setup first call to return one message for events:messages
    // Setup second call to stop loop to avoid OOM
    let callCount = 0;
    mockDuplicatedRedis.xread.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [
          [
            'events:messages',
            [
              [
                '1719500000-0',
                ['event', 'message:new', 'data', JSON.stringify({ orgId: 'org-1', sessionId: 'sess-1' })]
              ]
            ]
          ]
        ];
      }
      (wsServer as any).streamReaderRunning = false;
      return null;
    });

    // Spy on broadcast methods
    const broadcastToOrgSpy = vi.spyOn(wsServer as any, 'broadcastToOrg').mockResolvedValue(undefined);
    const broadcastToChannelSpy = vi.spyOn(wsServer as any, 'broadcastToChannel').mockResolvedValue(undefined);

    (wsServer as any).startStreamReader();

    // Advance loop
    await vi.advanceTimersByTimeAsync(0);

    // Verify it received and processed the event
    expect(broadcastToOrgSpy).toHaveBeenCalledWith('org-1', expect.objectContaining({ type: 'message:new', orgId: 'org-1' }));
    expect(broadcastToChannelSpy).toHaveBeenCalledWith('session:sess-1', expect.objectContaining({ type: 'message:new' }));

    // Advance loop again so it calls xread the second time using the new offset
    await vi.advanceTimersByTimeAsync(0);

    // The second call to xread should use the updated offset '1719500000-0' for events:messages
    expect(mockDuplicatedRedis.xread).toHaveBeenLastCalledWith(
      'COUNT', '50',
      'BLOCK', '5000',
      'STREAMS',
      'events:messages', 'events:sessions', 'events:presence', 'events:chats',
      '1719500000-0', '$', '$', '$'
    );
  });
});
