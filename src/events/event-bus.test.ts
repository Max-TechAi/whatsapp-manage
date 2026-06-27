import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateInboundJobId, generateHistorySyncJobId, eventBus, QUEUES } from './event-bus.js';
import { redis } from '../config/redis.js';

// Mock config/redis.js
vi.mock('../config/redis.js', () => {
  const mockRedis = {
    incr: vi.fn(),
    decr: vi.fn(),
    expire: vi.fn(),
    del: vi.fn(),
  };
  return {
    redis: mockRedis,
    queueRedis: {
      duplicate: vi.fn().mockReturnValue({}),
    },
  };
});

// Mock bullmq Queue class
vi.mock('bullmq', () => {
  const mockQueue = {
    add: vi.fn().mockResolvedValue({ id: 'job-1' }),
  };
  return {
    Queue: vi.fn().mockImplementation(() => mockQueue),
    QueueEvents: vi.fn(),
  };
});

describe('BullMQ Job ID Sanitization', () => {
  it('should generate inbound message job IDs without unsafe characters', () => {
    const sessionId = 'uuid-1234-5678';
    const messageId = 'ABC12345:6';
    const jobId = generateInboundJobId(sessionId, messageId);

    expect(jobId).not.toContain(':');
    expect(jobId).not.toContain('/');
    expect(jobId).toBe('uuid-1234-5678-ABC12345-6');
  });

  it('should generate history sync job IDs without unsafe characters', () => {
    const sessionId = 'uuid-1234-5678';
    const syncType = 'INITIAL_BOOTSTRAP';
    const chunkOrder = '1';
    const messageSignature = '100_first:id_last:id';
    
    const jobId = generateHistorySyncJobId(sessionId, syncType, chunkOrder, messageSignature);

    expect(jobId).not.toContain(':');
    expect(jobId).not.toContain('/');
    expect(jobId).toBe('history-sync-uuid-1234-5678-INITIAL_BOOTSTRAP-1-100_first-id_last-id');
  });
});

describe('Dynamic Priority-Based Fair Scheduling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should increment active jobs and set job priority in publishMessageInbound', async () => {
    // Mock redis.incr to return active job count
    vi.mocked(redis.incr).mockResolvedValue(5);
    vi.mocked(redis.expire).mockResolvedValue(1);

    const queue = eventBus.getQueue(QUEUES.MESSAGE_INBOUND);

    await eventBus.publishMessageInbound('sess-1', 'org-1', [{ key: { id: 'msg-1' } }], 'notify');

    // Verify Redis increment was called
    expect(redis.incr).toHaveBeenCalledWith('queue_count:org-1:message-inbound');
    expect(redis.expire).toHaveBeenCalledWith('queue_count:org-1:message-inbound', 3600);

    // Verify job was added with priority 5
    expect(queue.add).toHaveBeenCalledWith(
      'msg-notify',
      expect.objectContaining({ sessionId: 'sess-1', orgId: 'org-1' }),
      expect.objectContaining({ priority: 5 })
    );
  });

  it('should decrement active jobs when decrementActiveJobs is called', async () => {
    vi.mocked(redis.decr).mockResolvedValue(0);

    await eventBus.decrementActiveJobs('org-1', 'message-inbound');

    expect(redis.decr).toHaveBeenCalledWith('queue_count:org-1:message-inbound');
    expect(redis.del).toHaveBeenCalledWith('queue_count:org-1:message-inbound');
  });

  it('should decrement active jobs but not delete key when count > 0', async () => {
    vi.mocked(redis.decr).mockResolvedValue(2);

    await eventBus.decrementActiveJobs('org-1', 'message-inbound');

    expect(redis.decr).toHaveBeenCalledWith('queue_count:org-1:message-inbound');
    expect(redis.del).not.toHaveBeenCalled();
  });
});
