import { z } from 'zod';

/**
 * Environment configuration schema with runtime validation.
 * All environment variables are validated at startup — fail fast on misconfiguration.
 */
const envSchema = z.object({
  // PostgreSQL
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  REDIS_PASSWORD: z.string().min(1),

  // MinIO
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().int().default(9000),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().default('whatsapp-media'),
  MINIO_USE_SSL: z.preprocess(
    (val) => val === 'true' || val === '1' || val === true,
    z.boolean()
  ).default(false),

  // JWT
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  // Encryption
  ENCRYPTION_KEY: z.string().length(64).regex(/^[0-9a-fA-F]+$/, 'Must be 64 hex characters'),

  // Server
  PORT: z.coerce.number().int().default(3000),
  WS_PORT: z.coerce.number().int().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),

  // Rate Limiting
  RATE_LIMIT_AUTH: z.coerce.number().int().default(5),
  RATE_LIMIT_API: z.coerce.number().int().default(100),
  RATE_LIMIT_WA_MESSAGES: z.coerce.number().int().default(20),
});

export type Env = z.infer<typeof envSchema>;

/** Validated environment singleton — throws on invalid config at import time */
let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      console.error('❌ Invalid environment variables:');
      for (const issue of result.error.issues) {
        console.error(`  ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exit(1);
    }
    _env = result.data;
  }
  return _env;
}

export const env = getEnv();
