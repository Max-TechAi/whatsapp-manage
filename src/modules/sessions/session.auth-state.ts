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
import { eq, and, inArray } from 'drizzle-orm';
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
 *
 * @example
 * ```typescript
 * const { state, saveCreds } = await usePostgresAuthState(sessionId);
 * const socket = makeWASocket({ auth: state });
 * socket.ev.on('creds.update', saveCreds);
 * ```
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

  // ── Build AuthenticationState ───────────────────────────────────────────

  const state: AuthenticationState = {
    creds,
    keys: {
      /**
       * Retrieve signal protocol keys by type and ID.
       * Queries the sessionKeys table, decrypts, and deserializes.
       */
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[],
      ): Promise<Record<string, SignalDataTypeMap[T]>> => {
        const result: Record<string, SignalDataTypeMap[T]> = {};

        if (ids.length === 0) return result;

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
                inArray(sessionKeys.keyId, ids),
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
            } catch (error) {
              logger.warn('Failed to decrypt session key', {
                sessionId,
                keyType: type,
                keyId: row.keyId,
                error: error instanceof Error ? error.message : 'Unknown error',
              });
            }
          }
        } catch (error) {
          logger.error('Failed to query session keys', {
            sessionId,
            keyType: type,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }

        return result;
      },

      /**
       * Persist signal protocol keys.
       * Upserts encrypted key data; null values trigger deletion.
       */
      set: async (data: SignalDataSet): Promise<void> => {
        try {
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries ?? {})) {
              if (value === null || value === undefined) {
                // Delete key when value is null (key invalidation)
                await db
                  .delete(sessionKeys)
                  .where(
                    and(
                      eq(sessionKeys.sessionId, sessionId),
                      eq(sessionKeys.keyType, type),
                      eq(sessionKeys.keyId, id),
                    ),
                  );
              } else {
                // Serialize with BufferJSON.replacer to handle Buffer instances,
                // then encrypt the result for at-rest security
                const serialized = JSON.parse(
                  JSON.stringify(value, BufferJSON.replacer),
                );
                const encrypted = encryptJSON(serialized);

                await db
                  .insert(sessionKeys)
                  .values({
                    sessionId,
                    keyType: type,
                    keyId: id,
                    keyData: encrypted,
                  })
                  .onConflictDoUpdate({
                    target: [
                      sessionKeys.sessionId,
                      sessionKeys.keyType,
                      sessionKeys.keyId,
                    ],
                    set: { keyData: encrypted },
                  });
              }
            }
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
