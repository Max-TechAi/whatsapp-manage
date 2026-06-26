/**
 * @fileoverview Main entry point for the WhatsApp Session Runner Service.
 * Orchestrates WhatsApp socket connections in a dedicated process.
 */

import { Worker } from 'bullmq';
import { inArray } from 'drizzle-orm';

import { db } from './config/database.js';
import { sessions } from './db/schema.js';
import { redis, workerRedis } from './config/redis.js';
import { logger } from './observability/logger.js';
import { sessionManager } from './modules/sessions/session.manager.js';
import { QUEUES } from './events/event-bus.js';

logger.info('Starting WhatsApp Session Runner Service...', {
  replicaId: sessionManager.replicaId,
});

// Set environment variable flag if not already set to enable runner behaviors
process.env.RUN_SESSION_RUNNER = 'true';

// ─── 1. Orchestration Queue Worker ──────────────────────────────────────────────

const orchestrationWorker = new Worker(
  QUEUES.SESSIONS_ORCHESTRATION,
  async (job) => {
    const { sessionId, orgId, action } = job.data;
    logger.info('Processing sessions orchestration job', { jobId: job.id, sessionId, action });

    if (action === 'start') {
      try {
        await sessionManager.initializeSocket(sessionId, orgId);
      } catch (err) {
        logger.error('Failed to initialize socket from orchestration job', { sessionId, error: (err as Error).message });
        throw err;
      }
    }
  },
  {
    connection: workerRedis.duplicate() as any,
    concurrency: 5,
  }
);

orchestrationWorker.on('completed', (job) => {
  logger.debug(`Orchestration job ${job.id} completed successfully`);
});

orchestrationWorker.on('failed', (job, err) => {
  logger.error(`Orchestration job ${job?.id} failed`, { error: err.message });
});

// ─── 2. Periodic Reconciliation Loop ───────────────────────────────────────────

/**
 * Periodically find sessions marked as active/disconnected in DB
 * that do not have an active Redis lock owner, and trigger startup.
 */
async function runReconciliation(): Promise<void> {
  try {
    const sessionsToReconcile = await db
      .select({ id: sessions.id, orgId: sessions.orgId, status: sessions.status })
      .from(sessions)
      .where(inArray(sessions.status, ['connected', 'disconnected', 'connecting', 'qr_pending']));

    for (const session of sessionsToReconcile) {
      const lockKey = `session:${session.id}:owner`;
      const owner = await redis.get(lockKey);
      if (!owner) {
        logger.info('Reconciliation: Found orphaned session, triggering initialization', {
          sessionId: session.id,
          status: session.status,
        });

        // Trigger startup via orchestration queue to distribute/deduplicate
        await sessionManager.initializeSocket(session.id, session.orgId).catch((err) => {
          logger.error('Reconciliation failed to initialize socket', { sessionId: session.id, error: err.message });
        });
      }
    }
  } catch (err) {
    logger.error('Error during reconciliation loop', { error: (err as Error).message });
  }
}

// Restore all active sessions on startup
sessionManager.restoreAllSessions().then(() => {
  logger.info('Completed initial restoration of sessions');
  
  // Start the reconciliation interval (runs every 10 seconds)
  const reconciliationInterval = setInterval(runReconciliation, 10000);
  
  // Save interval to prevent process exit and support cleanup
  (global as any).reconciliationInterval = reconciliationInterval;
}).catch((err) => {
  logger.error('Failed initial restoration of sessions', { error: err.message });
});

// ─── 3. Graceful Shutdown ────────────────────────────────────────────────────────

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.warn(`Received ${signal}. Starting session-runner graceful shutdown...`);

  // Force exit after 15 seconds if graceful shutdown hangs
  const forceTimeout = setTimeout(() => {
    logger.error('Forced shutdown: could not close sessions in time');
    process.exit(1);
  }, 15000);

  try {
    // Stop the reconciliation interval
    if ((global as any).reconciliationInterval) {
      clearInterval((global as any).reconciliationInterval);
    }

    // Pause orchestration worker to stop taking new jobs
    logger.info('Pausing orchestration worker...');
    await orchestrationWorker.pause();

    // Force terminate all active sessions owned by this replica
    const activeSessions = sessionManager.getAllSessions();
    logger.info(`Terminating ${activeSessions.length} active sessions managed by replica ${sessionManager.replicaId}...`);

    await Promise.all(
      activeSessions.map((session) =>
        sessionManager.forceTerminateSocket(session.sessionId).catch((err) => {
          logger.error('Error terminating session on shutdown', {
            sessionId: session.sessionId,
            error: err.message,
          });
        })
      )
    );

    // Close DB and Redis connection pools
    logger.info('Closing connection pools...');
    const { closePool } = await import('./config/database.js');
    const { closeRedis } = await import('./config/redis.js');
    await closePool();
    await closeRedis();

    clearTimeout(forceTimeout);
    logger.info('Graceful shutdown completed. Exiting.');
    process.exit(0);
  } catch (error) {
    logger.error('Error occurred during graceful shutdown', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    clearTimeout(forceTimeout);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
