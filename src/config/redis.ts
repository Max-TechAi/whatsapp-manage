import Redis from 'ioredis';
import { getEnv } from './env.js';
import { logger } from '../observability/logger.js';

const env = getEnv();

/**
 * Redis connection factory.
 * BullMQ requires maxRetriesPerRequest: null for workers.
 */
function createRedisConnection(name: string, options: { forWorker?: boolean } = {}): Redis {
  const connection = new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
    maxRetriesPerRequest: options.forWorker ? null : 3,
    enableOfflineQueue: !options.forWorker,
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, 5000);
      logger.warn(`Redis [${name}] reconnecting, attempt ${times}, delay ${delay}ms`);
      return delay;
    },
    lazyConnect: false,
  });

  connection.on('connect', () => {
    logger.info(`Redis [${name}] connected`);
  });

  connection.on('error', (err) => {
    logger.error(`Redis [${name}] error`, { error: err.message });
  });

  connection.on('close', () => {
    logger.warn(`Redis [${name}] connection closed`);
  });

  return connection;
}

/**
 * General-purpose Redis client for caching, rate limiting, presence, etc.
 */
export const redis = createRedisConnection('general');

/**
 * Redis connection for BullMQ workers (requires maxRetriesPerRequest: null).
 */
export const workerRedis = createRedisConnection('worker', { forWorker: true });

/**
 * Redis connection for BullMQ producers/queues.
 */
export const queueRedis = createRedisConnection('queue', { forWorker: true });

/**
 * Redis subscriber for pub/sub patterns (LISTEN-like notifications).
 * Dedicated connection because once a client subscribes, it can only
 * receive subscribe/unsubscribe/message replies.
 */
export const subRedis = createRedisConnection('subscriber');

/**
 * Test Redis connectivity — used by health checks.
 */
export async function testRedisConnection(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Graceful shutdown of all Redis connections.
 */
export async function closeRedis(): Promise<void> {
  await Promise.allSettled([
    redis.quit(),
    workerRedis.quit(),
    queueRedis.quit(),
    subRedis.quit(),
  ]);
  logger.info('All Redis connections closed');
}
