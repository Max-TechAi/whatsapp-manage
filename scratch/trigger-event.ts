import { eventBus, STREAMS } from '../src/events/event-bus.js';
import { closeRedis } from '../src/config/redis.js';

async function main() {
  const orgId = process.argv[2] || 'org-test';
  const sessionId = process.argv[3] || 'sess-test';
  const chatId = process.argv[4] || 'chat-test';

  console.log(`Publishing test event: orgId=${orgId}, sessionId=${sessionId}, chatId=${chatId}`);

  await eventBus.publishToStream(STREAMS.MESSAGES, 'message:new', {
    orgId,
    sessionId,
    chatId,
    message: {
      id: 'msg-' + Date.now(),
      content: 'Hello from real-time fan-out test!',
      createdAt: new Date().toISOString(),
    }
  });

  console.log('Event published successfully. Closing Redis...');
  await closeRedis();
  process.exit(0);
}

main().catch(err => {
  console.error('Failed to trigger event:', err);
  process.exit(1);
});
