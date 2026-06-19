import { redis } from '../../config/redis.js';
import { logger } from '../../observability/logger.js';

/**
 * Key format for storing LID-to-Phone-JID mappings in Redis
 */
function lidMappingKey(sessionId: string): string {
  return `lid:mapping:${sessionId}`;
}

/**
 * Save a mapping between a LID JID and its corresponding Phone JID
 */
export async function saveLidMapping(sessionId: string, lid: string, phone: string): Promise<void> {
  if (!lid || !phone) return;
  
  const normalizedLid = lid.trim();
  const normalizedPhone = phone.trim();
  
  if (normalizedLid.endsWith('@lid') && normalizedPhone.endsWith('@s.whatsapp.net')) {
    try {
      await redis.hset(lidMappingKey(sessionId), normalizedLid, normalizedPhone);
      logger.debug('Saved LID to Phone mapping', { sessionId, lid: normalizedLid, phone: normalizedPhone });

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
  if (!jid || !jid.endsWith('@lid')) {
    return jid;
  }

  try {
    const resolved = await redis.hget(lidMappingKey(sessionId), jid);
    if (resolved) {
      logger.debug('Resolved LID JID to Phone JID', { sessionId, original: jid, resolved });
      return resolved;
    }
  } catch (err) {
    logger.error('Failed to resolve LID JID in Redis', { sessionId, jid, error: (err as Error).message });
  }

  return jid;
}
