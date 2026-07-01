/**
 * Shared LID-aware contact name resolution for chat list queries.
 *
 * Match paths (correlated to chats.session_id / chats.wa_chat_id):
 *  1. contacts.wa_id = chats.wa_chat_id           — direct JID (phone or @lid row)
 *  2. contacts.metadata->>'lid' = chats.wa_chat_id — phone contact when chat JID is @lid
 *  3. contacts.wa_id = phone.metadata->>'lid'      — @lid row when chat JID is phone
 */

import { db } from '../../config/database.js';
import { chats, contacts } from '../../db/schema.js';
import { and, eq, or, sql } from 'drizzle-orm';
import { resolveLidJid } from '../sessions/lid-mapping.js';
import { normalizeJid } from '../sessions/session.events.js';

const contactMatchForChat = sql`(
  ${contacts.waId} = ${chats.waChatId}
  OR ${contacts.metadata}->>'lid' = ${chats.waChatId}
  OR ${contacts.waId} = (
    SELECT c2.metadata->>'lid' FROM contacts c2
    WHERE c2.session_id = ${chats.sessionId}
      AND c2.org_id = ${chats.orgId}
      AND c2.wa_id = ${chats.waChatId}
      AND c2.metadata->>'lid' IS NOT NULL
    LIMIT 1
  )
)`;

const contactNameOrder = sql`CASE WHEN ${contacts.displayName} IS NOT NULL OR ${contacts.pushName} IS NOT NULL THEN 0 ELSE 1 END ASC`;

/** Exact SQL emitted for the display-name subquery (for debugging). */
export const CONTACT_DISPLAY_NAME_SUBQUERY_SQL = `(
  SELECT contacts.display_name FROM contacts
  WHERE contacts.session_id = chats.session_id
    AND (
      contacts.wa_id = chats.wa_chat_id
      OR contacts.metadata->>'lid' = chats.wa_chat_id
      OR contacts.wa_id = (
        SELECT c2.metadata->>'lid' FROM contacts c2
        WHERE c2.session_id = chats.session_id
          AND c2.org_id = chats.org_id
          AND c2.wa_id = chats.wa_chat_id
          AND c2.metadata->>'lid' IS NOT NULL
        LIMIT 1
      )
    )
  ORDER BY CASE WHEN contacts.display_name IS NOT NULL OR contacts.push_name IS NOT NULL THEN 0 ELSE 1 END ASC
  LIMIT 1
)`;

export const contactDisplayNameSubquery = sql<string | null>`(
  SELECT ${contacts.displayName} FROM ${contacts}
  WHERE ${contacts.sessionId} = ${chats.sessionId}
    AND ${contacts.orgId} = ${chats.orgId}
    AND ${contactMatchForChat}
  ORDER BY ${contactNameOrder}
  LIMIT 1
)`;

export const contactPushNameSubquery = sql<string | null>`(
  SELECT ${contacts.pushName} FROM ${contacts}
  WHERE ${contacts.sessionId} = ${chats.sessionId}
    AND ${contacts.orgId} = ${chats.orgId}
    AND ${contactMatchForChat}
  ORDER BY ${contactNameOrder}
  LIMIT 1
)`;

/** Reject phone-number-shaped strings masquerading as chat names. */
export function isUsableChatName(name: string | null | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.includes('∙') || /^[+\d\s]+$/.test(trimmed)) {
    return false;
  }
  return true;
}

export function resolveChatDisplayName(
  contactName: string | null | undefined,
  contactPushName: string | null | undefined,
  chatName: string | null | undefined,
): string | null {
  if (contactName) return contactName;
  if (contactPushName) return contactPushName;
  if (isUsableChatName(chatName)) return chatName!;
  return null;
}

function buildContactMatchConditions(sessionId: string, orgId: string, waChatId: string) {
  const conditions = [
    eq(contacts.waId, waChatId),
    sql`${contacts.metadata}->>'lid' = ${waChatId}`,
    sql`${contacts.waId} = (
      SELECT c2.metadata->>'lid' FROM contacts c2
      WHERE c2.session_id = ${sessionId}
        AND c2.org_id = ${orgId}
        AND c2.wa_id = ${waChatId}
        AND c2.metadata->>'lid' IS NOT NULL
      LIMIT 1
    )`,
  ];

  if (waChatId.endsWith('@lid')) {
    conditions.push(
      sql`(${contacts.waId} LIKE '%@s.whatsapp.net' AND ${contacts.metadata}->>'lid' = ${waChatId})`,
    );
  }

  return conditions;
}

/**
 * Imperative contact lookup using all JID candidates (incl. Redis LID→phone resolution).
 * Used when the correlated SQL subquery returns NULL (e.g. metadata.lid not yet persisted).
 */
export async function lookupContactNamesForChat(
  sessionId: string,
  orgId: string,
  waChatId: string,
): Promise<{ displayName: string | null; pushName: string | null }> {
  const normalized = normalizeJid(waChatId);
  let resolved = normalized;
  try {
    resolved = normalizeJid(await resolveLidJid(sessionId, waChatId));
  } catch {
    // keep normalized
  }

  const candidates = [...new Set([normalized, resolved].filter(Boolean))];
  const matchParts = candidates.flatMap((jid) =>
    buildContactMatchConditions(sessionId, orgId, jid),
  );

  const [row] = await db
    .select({
      displayName: contacts.displayName,
      pushName: contacts.pushName,
    })
    .from(contacts)
    .where(and(eq(contacts.sessionId, sessionId), eq(contacts.orgId, orgId), or(...matchParts)))
    .orderBy(contactNameOrder)
    .limit(1);

  return {
    displayName: row?.displayName ?? null,
    pushName: row?.pushName ?? null,
  };
}
