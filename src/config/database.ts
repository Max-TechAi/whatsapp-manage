import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.js';
import { getEnv } from './env.js';
import { logger } from '../observability/logger.js';

const env = getEnv();

/**
 * PostgreSQL connection pool.
 * Pool size follows the formula: (CPU_cores * 2) + number_of_disks
 * For a single VPS, 10 is a good default.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  allowExitOnIdle: false,
});

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error', { error: err.message });
});

pool.on('connect', () => {
  logger.debug('New PostgreSQL client connected');
});

/** Drizzle ORM instance with full schema type inference */
export const db = drizzle(pool, {
  schema,
  logger: env.NODE_ENV === 'development',
});

/**
 * Direct pool client for operations that need raw SQL
 * (e.g., LISTEN/NOTIFY, transactions).
 * Always release the client after use.
 */
export async function getDirectClient(): Promise<pg.PoolClient> {
  return pool.connect();
}

/**
 * Test database connectivity — used by health checks.
 */
export async function testConnection(): Promise<boolean> {
  try {
    const result = await pool.query('SELECT 1 as ok');
    return result.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

/**
 * Graceful pool shutdown.
 */
export async function closePool(): Promise<void> {
  await pool.end();
  logger.info('PostgreSQL pool closed');
}
