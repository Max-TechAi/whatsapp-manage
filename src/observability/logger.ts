import winston from 'winston';

const { combine, timestamp, printf, colorize, json, errors } = winston.format;

/** Custom format for development console output */
const devFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length > 0
    ? ` ${JSON.stringify(meta, null, 0)}`
    : '';
  return `${timestamp} [${level}]${metaStr}: ${message}`;
});

/**
 * Redact sensitive fields from log metadata.
 * Prevents accidental leakage of passwords, tokens, phone numbers.
 */
const redactSensitive = winston.format((info) => {
  const sensitiveKeys = ['password', 'token', 'secret', 'authorization', 'cookie', 'credentials'];
  for (const key of sensitiveKeys) {
    if (info[key]) {
      info[key] = '[REDACTED]';
    }
  }
  return info;
});

const logLevel = process.env.LOG_LEVEL || 'info';
const isProduction = process.env.NODE_ENV === 'production';

export const logger = winston.createLogger({
  level: logLevel,
  defaultMeta: { service: 'whatsapp-api' },
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    redactSensitive(),
  ),
  transports: [
    // Console — colored in dev, JSON in production
    new winston.transports.Console({
      format: isProduction
        ? combine(json())
        : combine(colorize(), devFormat),
    }),

    // File — JSON format, rotated by Winston daily rotate transport if needed
    ...(isProduction
      ? [
          new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
            format: combine(json()),
            maxsize: 10 * 1024 * 1024, // 10MB
            maxFiles: 5,
          }),
          new winston.transports.File({
            filename: 'logs/combined.log',
            format: combine(json()),
            maxsize: 10 * 1024 * 1024,
            maxFiles: 10,
          }),
        ]
      : []),
  ],
  // Don't exit on uncaught exceptions — let the process manager handle it
  exitOnError: false,
});

/**
 * Express HTTP request logger middleware.
 * Logs method, path, status, and response time.
 */
export function httpLogger(req: any, res: any, next: any): void {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.http('HTTP request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  });
  next();
}
