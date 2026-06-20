/**
 * PostgreSQL-backed Baileys AuthenticationState.
 *
 * Replaces Baileys' default `useMultiFileAuthState` with database-backed
 * credential and signal key persistence. All sensitive auth data is
 * encrypted at rest using AES-256-GCM via the encryption module.
 *
 * This ensures:
 * - Sessions survive container restarts (no ephemeral filesystem)
 * - Credentials are encrypted at rest
 * - Multi-instance deployments can share session state via the DB
 */

import type {
  AuthenticationState,
  AuthenticationCreds,
  SignalDataTypeMap,
  SignalDataSet,
} from '@whiskeysockets/baileys';
import { proto, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { sessions, sessionKeys } from '../../db/schema.js';
import { encryptJSON, decryptJSON } from '../../security/encryption.js';
import { logger } from '../../observability/logger.js';

/**
 * Create a PostgreSQL-backed AuthenticationState for Baileys.
 *
 * Loads or initializes credentials from the `sessions` table,
 * and manages signal protocol keys in the `sessionKeys` table.
 * All data is AES-256-GCM encrypted before storage.
 *
 * @param sessionId - The session ID to load/store auth state for
 * @returns Object with Baileys-compatible `state` and a `saveCreds` callback
 */
export async function usePostgresAuthState(sessionId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  // ── Load or initialize credentials ──────────────────────────────────────

  let creds: AuthenticationCreds;

  const sessionRecord = await db
    .select({ authCreds: sessions.authCreds })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (sessionRecord.length > 0 && sessionRecord[0].authCreds) {
    try {
      const decrypted = decryptJSON(sessionRecord[0].authCreds as string);
      // BufferJSON.reviver restores Buffer instances from { type: 'Buffer', data: [...] }
      creds = JSON.parse(JSON.stringify(decrypted), BufferJSON.reviver);
      logger.debug('Loaded existing auth credentials', { sessionId });
    } catch (error) {
      logger.warn('Failed to decrypt auth creds, initializing fresh', {
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      creds = initAuthCreds();
    }
  } else {
    creds = initAuthCreds();
    logger.debug('Initialized new auth credentials', { sessionId });
  }

  // ── In-memory keys cache for fast read/writes ───────────────────────────
  const keysCache = new Map<string, Map<string, any>>();

  const getCache = (type: string, id: string) => {
    return keysCache.get(type)?.get(id);
  };

  const setCache = (type: string, id: string, value: any) => {
    if (!keysCache.has(type)) {
      keysCache.set(type, new Map());
    }
    keysCache.get(type)!.set(id, value);
  };

  const deleteCache = (type: string, id: string) => {
    keysCache.get(type)?.delete(id);
  };

  // ── Build AuthenticationState ───────────────────────────────────────────

  const state: AuthenticationState = {
    creds,
    keys: {
      /**
       * Retrieve signal protocol keys by type and ID.
       * Uses local cache first, fallback to batch database lookup.
       */
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[],
      ): Promise<Record<string, SignalDataTypeMap[T]>> => {
        const result: Record<string, SignalDataTypeMap[T]> = {};
        const missingIds: string[] = [];

        for (const id of ids) {
          const cached = getCache(type, id);
          if (cached !== undefined) {
            result[id] = cached;
          } else {
            missingIds.push(id);
          }
        }

        if (missingIds.length === 0) {
          // Filter out cached null markers before returning to Baileys
          const finalResult: Record<string, SignalDataTypeMap[T]> = {};
          for (const id of ids) {
            const val = result[id];
            if (val !== undefined && val !== null) {
              finalResult[id] = val;
            }
          }
          return finalResult;
        }

        try {
          const rows = await db
            .select({
              keyId: sessionKeys.keyId,
              keyData: sessionKeys.keyData,
            })
            .from(sessionKeys)
            .where(
              and(
                eq(sessionKeys.sessionId, sessionId),
                eq(sessionKeys.keyType, type),
                inArray(sessionKeys.keyId, missingIds),
              ),
            );

          for (const row of rows) {
            try {
              const decrypted = decryptJSON(row.keyData as string);
              // Revive Buffer objects from serialized form
              const value = JSON.parse(
                JSON.stringify(decrypted),
                BufferJSON.reviver,
              );
              result[row.keyId] = value;
              setCache(type, row.keyId, value);
            } catch (error) {
              logger.warn('Failed to decrypt session key', {
                sessionId,
                keyType: type,
                keyId: row.keyId,
                error: error instanceof Error ? error.message : 'Unknown error',
              });
            }
          }

          // Mark missing keys as null in cache to avoid repeated DB hits
          for (const id of missingIds) {
            if (!(id in result)) {
              setCache(type, id, null);
            }
          }
        } catch (error) {
          logger.error('Failed to query session keys', {
            sessionId,
            keyType: type,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }

        // Filter out null values before returning to Baileys
        const finalResult: Record<string, SignalDataTypeMap[T]> = {};
        for (const id of ids) {
          const val = result[id];
          if (val !== undefined && val !== null) {
            finalResult[id] = val;
          }
        }
        return finalResult;
      },

      /**
       * Persist signal protocol keys.
       * Updates local cache immediately (instant read-after-write) and schedules batch DB writes.
       */
      set: async (data: SignalDataSet): Promise<void> => {
        try {
          const upsertValues: Array<{
            sessionId: string;
            keyType: string;
            keyId: string;
            keyData: string;
          }> = [];

          const deleteIdsByType: Record<string, string[]> = {};

          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries ?? {})) {
              if (value === null || value === undefined) {
                // Delete from cache
                deleteCache(type, id);
                if (!deleteIdsByType[type]) {
                  deleteIdsByType[type] = [];
                }
                deleteIdsByType[type].push(id);
              } else {
                // Save to cache immediately
                setCache(type, id, value);

                // Serialize and encrypt
                const serialized = JSON.parse(
                  JSON.stringify(value, BufferJSON.replacer),
                );
                const encrypted = encryptJSON(serialized);

                upsertValues.push({
                  sessionId,
                  keyType: type,
                  keyId: id,
                  keyData: encrypted,
                });
              }
            }
          }

          // Execute deletes in batch
          for (const [type, ids] of Object.entries(deleteIdsByType)) {
            if (ids.length > 0) {
              await db
                .delete(sessionKeys)
                .where(
                  and(
                    eq(sessionKeys.sessionId, sessionId),
                    eq(sessionKeys.keyType, type),
                    inArray(sessionKeys.keyId, ids),
                  ),
                );
            }
          }

          // Execute upserts in batch (chunked to avoid database parameters overflow)
          const batchSize = 100;
          for (let i = 0; i < upsertValues.length; i += batchSize) {
            const batch = upsertValues.slice(i, i + batchSize);
            await db
              .insert(sessionKeys)
              .values(batch)
              .onConflictDoUpdate({
                target: [
                  sessionKeys.sessionId,
                  sessionKeys.keyType,
                  sessionKeys.keyId,
                ],
                set: { keyData: sql`EXCLUDED.key_data` },
              });
          }
        } catch (error) {
          logger.error('Failed to persist session keys', {
            sessionId,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          throw error;
        }
      },
    },
  };

  // ── Save credentials callback ───────────────────────────────────────────

  /**
   * Persist updated credentials back to the sessions table.
   * Called by Baileys on `creds.update` events.
   */
  const saveCreds = async (): Promise<void> => {
    try {
      // Serialize with BufferJSON.replacer, then encrypt
      const serialized = JSON.parse(
        JSON.stringify(creds, BufferJSON.replacer),
      );
      const encrypted = encryptJSON(serialized);

      await db
        .update(sessions)
        .set({ authCreds: encrypted })
        .where(eq(sessions.id, sessionId));

      logger.debug('Auth credentials saved', { sessionId });
    } catch (error) {
      logger.error('Failed to save auth credentials', {
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  };

  return { state, saveCreds };
}
