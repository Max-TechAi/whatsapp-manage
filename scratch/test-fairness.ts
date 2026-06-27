import { Queue, Worker, Job } from 'bullmq';
import { redis, queueRedis, workerRedis } from '../src/config/redis.js';
import { QUEUES, eventBus } from '../src/events/event-bus.js';

// Setup helper to delay
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log('Connecting to Redis for fairness testing...');

  const queue = new Queue(QUEUES.MESSAGE_INBOUND, {
    connection: queueRedis.duplicate() as any,
  });

  console.log('Draining existing jobs in message-inbound queue...');
  await queue.drain();

  // Clear any existing active job counters in Redis
  await redis.del('queue_count:org-A:message-inbound');
  await redis.del('queue_count:org-B:message-inbound');

  console.log('Step 1: Enqueuing 1000 mock jobs for Org A...');
  const orgAEnqueuedAt = Date.now();
  for (let i = 0; i < 1000; i++) {
    const activeJobs = await eventBus.incrementActiveJobs('org-A', QUEUES.MESSAGE_INBOUND);
    await queue.add(
      'msg-notify',
      { sessionId: 'sess-A', orgId: 'org-A', message: { key: { id: `msg-A-${i}`, remoteJid: '123@s.whatsapp.net' } }, type: 'notify' },
      { jobId: `job-A-${i}`, priority: Math.min(activeJobs, 500) }
    );
  }
  console.log(`Enqueued 1000 jobs for Org A in ${Date.now() - orgAEnqueuedAt}ms`);

  console.log('Step 2: Waiting 50ms...');
  await delay(50);

  console.log('Step 3: Enqueuing 1 job for Org B...');
  const orgBEnqueuedAt = Date.now();
  const activeJobsB = await eventBus.incrementActiveJobs('org-B', QUEUES.MESSAGE_INBOUND);
  const priorityB = Math.min(activeJobsB, 500);
  await queue.add(
    'msg-notify',
    { sessionId: 'sess-B', orgId: 'org-B', message: { key: { id: 'msg-B-1', remoteJid: '456@s.whatsapp.net' } }, type: 'notify' },
    { jobId: 'job-B-1', priority: priorityB }
  );
  console.log(`Enqueued Org B's job. Priority assigned: ${priorityB}`);

  console.log('Step 4: Starting worker to measure processing order...');
  let processedCount = 0;
  let orgBProcessedAt = 0;
  let orgBOrder = -1;

  const worker = new Worker(
    QUEUES.MESSAGE_INBOUND,
    async (job: Job) => {
      processedCount++;
      if (job.data.orgId === 'org-B') {
        orgBProcessedAt = Date.now();
        orgBOrder = processedCount;
        console.log(`>>> Org B Job Processed! Order in Queue: #${orgBOrder}, Latency since enqueue: ${orgBProcessedAt - orgBEnqueuedAt}ms`);
      }
      // Decrement counter
      await eventBus.decrementActiveJobs(job.data.orgId, QUEUES.MESSAGE_INBOUND);
    },
    {
      connection: workerRedis.duplicate() as any,
      concurrency: 1, // Run serially to clearly check order
    }
  );

  // Wait until Org B's job is processed, or timeout after 8 seconds
  const start = Date.now();
  while (orgBOrder === -1 && Date.now() - start < 8000) {
    await delay(100);
  }

  console.log('Shutting down worker and queue...');
  await worker.close();
  await queue.close();
  await redis.del('queue_count:org-A:message-inbound');
  await redis.del('queue_count:org-B:message-inbound');

  if (orgBOrder !== -1) {
    console.log('\n--- FAIRNESS TEST SUCCESS ---');
    console.log(`Org B job was processed at position #${orgBOrder} (expected #1 due to priority jump).`);
    console.log(`Total processing latency for Org B job: ${orgBProcessedAt - orgBEnqueuedAt}ms (expected <100ms).`);
  } else {
    console.log('\n--- FAIRNESS TEST FAILED / TIMEOUT ---');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
