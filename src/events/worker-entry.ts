/**
 * Worker Entry Point — starts all BullMQ workers in a single process.
 * Run separately from the API server: `tsx src/events/worker-entry.ts`
 */

import { createMessageWorker } from './workers/message.worker.js';
import { createSyncWorker, createContactSyncWorker, createChatSyncWorker } from './workers/sync.worker.js';
import { createWebhookWorker } from './workers/webhook.worker.js';
import { logger } from '../observability/logger.js';

const workers: any[] = [];

async function startWorkers(): Promise<void> {
  logger.info('Starting BullMQ workers...');

  workers.push(
    createMessageWorker(),
    createSyncWorker(),
    createContactSyncWorker(),
    createChatSyncWorker(),
    createWebhookWorker(),
  );

  logger.info(`${workers.length} workers started`, {
    names: workers.map((w) => w.name),
  });
}

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down workers...`);

  const forceExit = setTimeout(() => {
    logger.error('Worker shutdown timed out, forcing exit');
    process.exit(1);
  }, 30000);

  try {
    await Promise.all(workers.map((w) => w.close()));
    clearTimeout(forceExit);
    logger.info('All workers shut down gracefully');
    process.exit(0);
  } catch (err) {
    logger.error('Worker shutdown error', { error: (err as Error).message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startWorkers().catch((err) => {
  logger.error('Failed to start workers', { error: err.message });
  process.exit(1);
});
