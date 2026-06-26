/**
 * @fileoverview Main entry point for the WhatsApp Business API Platform.
 * Sets up Express API server, WebSocket server, and handles lifecycle hooks.
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import http from 'node:http';

import { getEnv } from './config/env.js';
import { logger, httpLogger } from './observability/logger.js';
import { metricsMiddleware, getMetrics } from './observability/metrics.js';
import { healthRouter } from './observability/health.js';

import { authRouter } from './modules/auth/auth.routes.js';
import { orgRouter } from './modules/organizations/org.routes.js';
import sessionRouter from './modules/sessions/session.routes.js';
import { messageRouter } from './modules/messages/message.routes.js';
import { chatRouter } from './modules/chats/chat.routes.js';
import { contactRouter } from './modules/contacts/contact.routes.js';
import { mediaRouter } from './modules/media/media.stream.js';
import { webhookRouter } from './modules/webhooks/webhook.routes.js';

import { wsServer } from './websocket/ws-server.js';
import { sessionManager } from './modules/sessions/session.manager.js';
import { mediaService } from './modules/media/media.service.js';
import { closePool } from './config/database.js';
import { closeRedis } from './config/redis.js';
import { apiRateLimiter } from './security/rate-limiter.js';
import { createOutboundWorker } from './events/workers/outbound.worker.js';
import { createMediaWorker } from './events/workers/media.worker.js';
import { emailService } from './modules/email/email.service.js';

const env = getEnv();
const app = express();
let outboundWorker: any = null;
let mediaWorker: any = null;

// ─── Security & Observability Middleware ────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('src/public'));
app.use(httpLogger);
app.use(metricsMiddleware);

// ─── Public Routes ──────────────────────────────────────────────────────────────

app.get('/metrics', getMetrics);
app.use('/health', healthRouter);

// ─── API Routes ─────────────────────────────────────────────────────────────────

// Apply API-wide rate limiting to all business endpoints
const apiBase = express.Router();
apiBase.use(apiRateLimiter);

apiBase.use('/auth', authRouter);
apiBase.use('/orgs', orgRouter);
apiBase.use('/sessions', sessionRouter);
apiBase.use('/messages', messageRouter);
apiBase.use('/chats', chatRouter);
apiBase.use('/contacts', contactRouter);
apiBase.use('/media', mediaRouter);
apiBase.use('/webhooks', webhookRouter);

app.use('/api', apiBase);

// ─── Fallback handlers ──────────────────────────────────────────────────────────

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// Global 500 Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled server error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Startup Lifecycle ──────────────────────────────────────────────────────────

const httpServer = http.createServer(app);

async function startServer(): Promise<void> {
  try {
    logger.info('Starting WhatsApp API Platform...');

    // 1. Initialize MinIO bucket
    await mediaService.initialize();

    // 0. Verify SMTP connection
    await emailService.verifySmtpConnection();

    // 2. Start WebSocket server
    await wsServer.start();

    // 3. Restore WhatsApp sessions
    await sessionManager.restoreAllSessions();

    // 4. Start outbound and media workers (run in API process to access active sockets)
    outboundWorker = createOutboundWorker();
    mediaWorker = createMediaWorker();

    // 5. Start HTTP Server
    httpServer.listen(env.PORT, () => {
      logger.info(`HTTP Server running in ${env.NODE_ENV} mode on port ${env.PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start server', { error: error instanceof Error ? error.message : 'Unknown' });
    process.exit(1);
  }
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────────

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.warn(`Received ${signal}. Starting graceful shutdown...`);

  // Give clients 10 seconds to finish requests
  const forceTimeout = setTimeout(() => {
    logger.error('Forced shutdown: could not close connections in time');
    process.exit(1);
  }, 10000);

  try {
    // 0. Close outbound and media workers
    if (outboundWorker) {
      logger.info('Shutting down outbound worker...');
      await outboundWorker.close();
    }
    if (mediaWorker) {
      logger.info('Shutting down media worker...');
      await mediaWorker.close();
    }

    // 1. Close WebSocket server (disconnect all WS clients)
    await wsServer.close();

    // 2. Stop accepting HTTP requests
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) return reject(err);
        logger.info('HTTP server stopped accepting connections');
        resolve();
      });
    });

    // 3. Stop all WhatsApp connections
    const activeSessions = sessionManager.getAllSessions();
    logger.info(`Closing socket connections for ${activeSessions.length} active sessions...`);
    for (const session of activeSessions) {
      await sessionManager.destroySession(session.sessionId).catch((err) => {
        logger.warn('Failed to clean up session on exit', { sessionId: session.sessionId, error: err.message });
      });
    }

    // 4. Close database and Redis connection pools
    await closePool();
    await closeRedis();

    clearTimeout(forceTimeout);
    logger.info('Graceful shutdown completed. Exiting.');
    process.exit(0);
  } catch (error) {
    logger.error('Error occurred during graceful shutdown', { error: error instanceof Error ? error.message : 'Unknown' });
    clearTimeout(forceTimeout);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startServer();
