import { Router, type Request, type Response } from 'express';
import { testConnection as testDbConnection } from '../config/database.js';
import { testRedisConnection } from '../config/redis.js';
import { mediaService } from '../modules/media/media.service.js';
import { logger } from './logger.js';

export const healthRouter = Router();

healthRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const status = {
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      database: 'down',
      redis: 'down',
      storage: 'down',
    },
  };

  try {
    const [dbOk, redisOk, storageOk] = await Promise.all([
      testDbConnection(),
      testRedisConnection(),
      mediaService.testConnection(),
    ]);

    status.services.database = dbOk ? 'up' : 'down';
    status.services.redis = redisOk ? 'up' : 'down';
    status.services.storage = storageOk ? 'up' : 'down';

    const isHealthy = dbOk && redisOk && storageOk;

    if (!isHealthy) {
      logger.error('Health check failed', status);
      res.status(503).json({ status: 'unhealthy', ...status });
      return;
    }

    res.status(200).json({ status: 'healthy', ...status });
  } catch (err) {
    logger.error('Health check exception', { error: (err as Error).message });
    res.status(500).json({ status: 'error', error: (err as Error).message });
  }
});
