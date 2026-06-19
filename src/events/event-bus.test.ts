import { describe, it, expect } from 'vitest';
import { generateInboundJobId, generateHistorySyncJobId } from './event-bus.js';

describe('BullMQ Job ID Sanitization', () => {
  it('should generate inbound message job IDs without unsafe characters', () => {
    const sessionId = 'uuid-1234-5678';
    const messageId = 'ABC12345:6'; // JID with device suffix
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
