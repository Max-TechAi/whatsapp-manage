import client from 'prom-client';
import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';

// Enable default metrics collection (CPU, Memory, etc.)
client.collectDefaultMetrics({ register: client.register });

// ─── Custom Metrics ─────────────────────────────────────────────────────────────

/** HTTP request counter */
export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests processed',
  labelNames: ['method', 'path', 'status'],
});

/** HTTP request duration histogram */
export const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'path', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10], // buckets in seconds
});

/** Active WebSocket connections */
export const activeWsConnections = new client.Gauge({
  name: 'websocket_active_connections',
  help: 'Number of active WebSocket connections',
});

/** Active WhatsApp sessions count by status */
export const activeSessionsCount = new client.Gauge({
  name: 'whatsapp_active_sessions',
  help: 'Number of active WhatsApp sessions by status',
  labelNames: ['status'],
});

/** Event bus published events counter */
export const eventBusPublishedTotal = new client.Counter({
  name: 'event_bus_published_total',
  help: 'Total number of events published to the event bus',
  labelNames: ['queue', 'type'],
});

/** Event bus processed events counter */
export const eventBusProcessedTotal = new client.Counter({
  name: 'event_bus_processed_total',
  help: 'Total number of events processed by workers',
  labelNames: ['queue', 'status'],
});

// ─── Middleware ─────────────────────────────────────────────────────────────────

/**
 * Express middleware to record HTTP metrics.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime();

  res.on('finish', () => {
    const diff = process.hrtime(start);
    const durationSeconds = diff[0] + diff[1] / 1e9;

    // Normalize path to prevent high cardinality (e.g. replace IDs with placeholders)
    const path = req.route ? req.route.path : req.path;
    const labels = {
      method: req.method,
      path: path || 'unknown',
      status: res.statusCode.toString(),
    };

    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSeconds);
  });

  next();
}

/**
 * Express handler to expose Prometheus metrics.
 */
export async function getMetrics(req: Request, res: Response): Promise<void> {
  try {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  } catch (err) {
    logger.error('Failed to generate metrics', { error: (err as Error).message });
    res.status(500).end();
  }
}
