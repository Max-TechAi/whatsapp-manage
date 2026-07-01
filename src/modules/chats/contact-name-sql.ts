/**
 * Shared LID-aware contact name resolution for chat list queries.
 * Matches contacts by direct waId, metadata.lid on phone contacts, or linked LID row.
 */

import { chats, contacts } from '../../db/schema.js';
import { sql } from 'drizzle-orm';

const contactMatchForChat = sql`(
  ${contacts.waId} = ${chats.waChatId}
  OR ${contacts.metadata}->>'lid' = ${chats.waChatId}
  OR ${contacts.waId} = (
    SELECT c2.metadata->>'lid' FROM contacts c2
    WHERE c2.session_id = ${chats.sessionId}
      AND c2.wa_id = ${chats.waChatId}
      AND c2.metadata->>'lid' IS NOT NULL
    LIMIT 1
  )
)`;

const contactNameOrder = sql`CASE WHEN ${contacts.displayName} IS NOT NULL OR ${contacts.pushName} IS NOT NULL THEN 0 ELSE 1 END ASC`;

export const contactDisplayNameSubquery = sql<string | null>`(
  SELECT ${contacts.displayName} FROM ${contacts}
  WHERE ${contacts.sessionId} = ${chats.sessionId}
    AND ${contactMatchForChat}
  ORDER BY ${contactNameOrder}
  LIMIT 1
)`;

export const contactPushNameSubquery = sql<string | null>`(
  SELECT ${contacts.pushName} FROM ${contacts}
  WHERE ${contacts.sessionId} = ${chats.sessionId}
    AND ${contactMatchForChat}
  ORDER BY ${contactNameOrder}
  LIMIT 1
)`;

export function resolveChatDisplayName(
  contactName: string | null | undefined,
  contactPushName: string | null | undefined,
  chatName: string | null | undefined,
): string | null {
  return contactName ?? contactPushName ?? chatName ?? null;
}
