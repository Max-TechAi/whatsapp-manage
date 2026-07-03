/**
 * API Key service — create, list, verify, and revoke org-scoped API keys.
 */

import { and, eq, isNull, or, gt, desc } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { apiKeys, users } from '../../db/schema.js';
import {
  extractApiKeyPrefix,
  generateApiKeyMaterial,
  verifyApiKeyHash,
} from '../../security/api-key.js';
import { redis } from '../../config/redis.js';
import { logger } from '../../observability/logger.js';
import type { JwtPayload } from '../auth/auth.types.js';

export interface ApiKeyListItem {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdByUserId: string;
  createdByEmail: string | null;
}

export interface ApiKeyCreateResult {
  key: ApiKeyListItem;
  plaintext: string;
}

const AUTH_CACHE_TTL_SEC = 60;

function activeKeyConditions(prefix: string) {
  return and(
    eq(apiKeys.keyPrefix, prefix),
    isNull(apiKeys.revokedAt),
    or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
  );
}

export async function listApiKeys(orgId: string): Promise<ApiKeyListItem[]> {
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      createdByUserId: apiKeys.createdByUserId,
      createdByEmail: users.email,
    })
    .from(apiKeys)
    .leftJoin(users, eq(apiKeys.createdByUserId, users.id))
    .where(eq(apiKeys.orgId, orgId))
    .orderBy(desc(apiKeys.createdAt));

  return rows;
}

export async function createApiKey(
  orgId: string,
  createdByUserId: string,
  name: string,
  expiresAt?: Date | null,
): Promise<ApiKeyCreateResult> {
  const { plaintext, keyPrefix, keyHash } = generateApiKeyMaterial();

  const [row] = await db
    .insert(apiKeys)
    .values({
      orgId,
      createdByUserId,
      name,
      keyPrefix,
      keyHash,
      expiresAt: expiresAt ?? null,
    })
    .returning({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      createdByUserId: apiKeys.createdByUserId,
    });

  const [creator] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, createdByUserId))
    .limit(1);

  return {
    plaintext,
    key: {
      ...row,
      createdByEmail: creator?.email ?? null,
    },
  };
}

export async function revokeApiKey(orgId: string, keyId: string): Promise<boolean> {
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId), isNull(apiKeys.revokedAt)))
    .returning({ keyPrefix: apiKeys.keyPrefix });

  if (row) {
    try {
      await redis.del(`api_key_auth:${row.keyPrefix}`);
    } catch (err) {
      logger.warn('Failed to invalidate API key cache on revoke', { error: (err as Error).message });
    }
    return true;
  }
  return false;
}

export interface VerifiedApiKeyAuth {
  user: JwtPayload;
  apiKeyId: string;
}

/**
 * Verify a presented API key and resolve the creating user's permissions.
 */
export async function verifyApiKeyAndResolveUser(plaintext: string): Promise<VerifiedApiKeyAuth | null> {
  const prefix = extractApiKeyPrefix(plaintext);
  const cacheKey = `api_key_auth:${prefix}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as {
        user: JwtPayload;
        apiKeyId: string;
        keyHash: string;
      };
      if (verifyApiKeyHash(plaintext, parsed.keyHash)) {
        void touchApiKeyLastUsed(parsed.apiKeyId, prefix);
        return { user: parsed.user, apiKeyId: parsed.apiKeyId };
      }
    }
  } catch (err) {
    logger.warn('API key cache read failed', { error: (err as Error).message });
  }

  const [record] = await db
    .select({
      id: apiKeys.id,
      keyHash: apiKeys.keyHash,
      orgId: apiKeys.orgId,
      createdByUserId: apiKeys.createdByUserId,
      email: users.email,
      role: users.role,
      hasAllSessionsAccess: users.hasAllSessionsAccess,
      emailVerified: users.emailVerified,
      isActive: users.isActive,
    })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.createdByUserId, users.id))
    .where(activeKeyConditions(prefix))
    .limit(1);

  if (!record || !record.isActive) {
    return null;
  }

  if (!verifyApiKeyHash(plaintext, record.keyHash)) {
    return null;
  }

  const user: JwtPayload = {
    userId: record.createdByUserId,
    orgId: record.orgId,
    email: record.email,
    role: record.role,
    hasAllSessionsAccess: record.hasAllSessionsAccess,
    emailVerified: record.emailVerified,
  };

  void touchApiKeyLastUsed(record.id, prefix);

  try {
    await redis.setex(
      cacheKey,
      AUTH_CACHE_TTL_SEC,
      JSON.stringify({ user, apiKeyId: record.id, keyHash: record.keyHash }),
    );
  } catch (err) {
    logger.warn('API key cache write failed', { error: (err as Error).message });
  }

  return { user, apiKeyId: record.id };
}

/** Throttled last_used_at update (at most once per minute per key). */
async function touchApiKeyLastUsed(apiKeyId: string, prefix: string): Promise<void> {
  const throttleKey = `api_key_used:${apiKeyId}`;
  try {
    const set = await redis.set(throttleKey, '1', 'EX', 60, 'NX');
    if (set) {
      await db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, apiKeyId));
    }
  } catch (err) {
    logger.warn('Failed to update API key last_used_at', { apiKeyId, error: (err as Error).message });
  }
}
