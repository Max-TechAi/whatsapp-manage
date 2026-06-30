import { redis } from '../../config/redis.js';
import { logger } from '../../observability/logger.js';
import { db } from '../../config/database.js';
import { contacts } from '../../db/schema.js';
import { and, eq, sql } from 'drizzle-orm';

/**
 * Key format for storing LID-to-Phone-JID mappings in Redis
 */
function lidMappingKey(sessionId: string): string {
  return `lid:mapping:${sessionId}`;
}

/**
 * Normalize a JID locally to strip any device suffix (:XX) for consistent mapping and lookup.
 * Avoids circular import dependency with session.events.ts
 */
function localNormalizeJid(jid: string): string {
  if (!jid) return jid;
  const atIndex = jid.indexOf('@');
  if (atIndex === -1) return jid;
  const userPart = jid.substring(0, atIndex);
  const serverPart = jid.substring(atIndex);
  const colonIndex = userPart.indexOf(':');
  if (colonIndex === -1) return jid;
  return userPart.substring(0, colonIndex) + serverPart;
}

/**
 * Save a mapping between a LID JID and its corresponding Phone JID
 */
export async function saveLidMapping(sessionId: string, lid: string, phone: string): Promise<void> {
  if (!lid || !phone) return;
  
  let normalizedLid = lid.trim();
  let normalizedPhone = phone.trim();
  
  // Strip device suffixes
  normalizedLid = localNormalizeJid(normalizedLid);
  normalizedPhone = localNormalizeJid(normalizedPhone);

  // Convert c.us JID to s.whatsapp.net
  if (normalizedPhone.endsWith('@c.us')) {
    normalizedPhone = normalizedPhone.replace('@c.us', '@s.whatsapp.net');
  }

  // Ensure they have the correct JID domains appended
  if (!normalizedLid.includes('@')) {
    normalizedLid = `${normalizedLid}@lid`;
  }
  if (!normalizedPhone.includes('@')) {
    normalizedPhone = `${normalizedPhone}@s.whatsapp.net`;
  }
  
  // Prevent self-mapping
  if (normalizedLid === normalizedPhone) {
    return;
  }

  if (normalizedLid.endsWith('@lid') && normalizedPhone.endsWith('@s.whatsapp.net')) {
    try {
      await redis.hset(lidMappingKey(sessionId), normalizedLid, normalizedPhone);
      logger.info('Saved LID to Phone mapping in Redis', { sessionId, lid: normalizedLid, phone: normalizedPhone });

      // Also persist to PostgreSQL contacts table metadata to survive Redis restarts
      try {
        const [contactRecord] = await db
          .select({ id: contacts.id, metadata: contacts.metadata })
          .from(contacts)
          .where(
            and(
              eq(contacts.sessionId, sessionId),
              eq(contacts.waId, normalizedPhone)
            )
          )
          .limit(1);

        if (contactRecord) {
          const currentMeta = (contactRecord.metadata as Record<string, any>) || {};
          if (currentMeta.lid !== normalizedLid) {
            await db
              .update(contacts)
              .set({
                metadata: { ...currentMeta, lid: normalizedLid },
                updatedAt: new Date()
              })
              .where(eq(contacts.id, contactRecord.id));
            logger.info('Persisted LID mapping to contact metadata in DB', { sessionId, waId: normalizedPhone, lid: normalizedLid });
          }
        }
      } catch (dbErr) {
        logger.error('Failed to persist LID mapping to database contact metadata', { sessionId, lid: normalizedLid, phone: normalizedPhone, error: (dbErr as Error).message });
      }

      /* BUG 1: Dynamically import chatService and trigger database-level merge of LID chat/contact */
      import('../chats/chat.service.js')
        .then(({ chatService }) => {
          chatService.mergeLidChatAndContact(sessionId, normalizedLid, normalizedPhone)
            .catch((err) => {
              logger.error('Dynamic LID chat merge failed', { sessionId, lid: normalizedLid, phone: normalizedPhone, error: err.message });
            });
        })
        .catch((err) => {
          logger.error('Failed to dynamically import chatService for LID merge', { error: err.message });
        });
    } catch (err) {
      logger.error('Failed to save LID mapping', { sessionId, error: (err as Error).message });
    }
  }
}

/**
 * Resolve a LID JID to its canonical Phone JID, returning the original if no mapping exists
 */
export async function resolveLidJid(sessionId: string, jid: string): Promise<string> {
  if (!jid) return jid;
  
  const normalizedJid = localNormalizeJid(jid.trim());
  if (!normalizedJid.endsWith('@lid')) {
    return jid;
  }

  try {
    const resolved = await redis.hget(lidMappingKey(sessionId), normalizedJid);
    if (resolved) {
      logger.debug('Resolved LID JID to Phone JID from Redis', { sessionId, original: jid, resolved });
      return resolved;
    }

    // Fallback: check database contacts table metadata
    const [dbContact] = await db
      .select({ waId: contacts.waId })
      .from(contacts)
      .where(
        and(
          eq(contacts.sessionId, sessionId),
          sql`${contacts.metadata}->>'lid' = ${normalizedJid}`
        )
      )
      .limit(1);

    if (dbContact) {
      logger.info('Resolved LID JID from PostgreSQL contact metadata', { sessionId, original: jid, resolved: dbContact.waId });
      // Cache back to Redis
      await redis.hset(lidMappingKey(sessionId), normalizedJid, dbContact.waId);
      return dbContact.waId;
    }
  } catch (err) {
    logger.error('Failed to resolve LID JID', { sessionId, jid, error: (err as Error).message });
  }

  return jid;
}
