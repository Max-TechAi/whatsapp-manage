import { redis } from '../../config/redis.js';
import { logger } from '../../observability/logger.js';

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

  // Ensure they have the correct JID domains appended
  if (!normalizedLid.includes('@')) {
    normalizedLid = `${normalizedLid}@lid`;
  }
  if (!normalizedPhone.includes('@')) {
    normalizedPhone = `${normalizedPhone}@s.whatsapp.net`;
  }
  
  if (normalizedLid.endsWith('@lid') && normalizedPhone.endsWith('@s.whatsapp.net')) {
    try {
      await redis.hset(lidMappingKey(sessionId), normalizedLid, normalizedPhone);
      logger.info('Saved LID to Phone mapping', { sessionId, lid: normalizedLid, phone: normalizedPhone });

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
      logger.error('Failed to save LID mapping in Redis', { sessionId, error: (err as Error).message });
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
      logger.debug('Resolved LID JID to Phone JID', { sessionId, original: jid, resolved });
      return resolved;
    }
  } catch (err) {
    logger.error('Failed to resolve LID JID in Redis', { sessionId, jid, error: (err as Error).message });
  }

  return jid;
}
