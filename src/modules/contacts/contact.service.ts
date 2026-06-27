/**
 * Contact Service — CRUD and sync from WhatsApp.
 * All queries scoped by orgId for multi-tenant isolation.
 */

import { db } from '../../config/database.js';
import { contacts } from '../../db/schema.js';
import { eq, and, ilike, or, sql, count } from 'drizzle-orm';
import { logger } from '../../observability/logger.js';
import type { Contact, ContactListQuery, ContactListResponse, ContactSyncPayload } from './contact.types.js';

export class ContactService {
  /**
   * Upsert a contact from WhatsApp sync data.
   * Uses ON CONFLICT (sessionId, waId) for idempotent sync.
   */
  async upsertContact(data: {
    orgId: string;
    sessionId: string;
    waId: string;
    phoneNumber?: string | null;
    pushName?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    isBusiness?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<Contact> {
    // Extract phone number from JID if not provided
    const phoneNumber = data.phoneNumber ?? data.waId.split('@')[0]?.split(':')[0] ?? null;

    const [result] = await db
      .insert(contacts)
      .values({
        orgId: data.orgId,
        sessionId: data.sessionId,
        waId: data.waId,
        phoneNumber,
        pushName: data.pushName ?? null,
        displayName: data.displayName ?? null,
        avatarUrl: data.avatarUrl ?? null,
        isBusiness: data.isBusiness ?? false,
        metadata: data.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: [contacts.sessionId, contacts.waId],
        set: {
          pushName: data.pushName ?? undefined,
          displayName: data.displayName ?? undefined,
          avatarUrl: data.avatarUrl ?? undefined,
          isBusiness: data.isBusiness ?? undefined,
          phoneNumber: phoneNumber ?? undefined,
          updatedAt: new Date(),
        },
      })
      .returning();

    return result as Contact;
  }

  /**
   * Bulk sync contacts from WhatsApp.
   */
  async bulkSync(payload: ContactSyncPayload): Promise<number> {
    let synced = 0;

    for (const contact of payload.contacts) {
      try {
        await this.upsertContact({
          orgId: payload.orgId,
          sessionId: payload.sessionId,
          ...contact,
        });
        synced++;
      } catch (err) {
        logger.warn('Failed to sync contact', {
          waId: contact.waId,
          error: (err as Error).message,
        });
      }
    }

    logger.info('Contact sync complete', {
      sessionId: payload.sessionId,
      total: payload.contacts.length,
      synced,
    });

    return synced;
  }

  /**
   * List contacts with optional search and pagination.
   */
  async getContacts(orgId: string, query: ContactListQuery): Promise<ContactListResponse> {
    const limit = Math.min(query.limit ?? 50, 5000);
    const offset = query.offset ?? 0;

    const conditions = [
      eq(contacts.orgId, orgId),
      eq(contacts.sessionId, query.sessionId),
    ];

    if (query.search) {
      const searchTerm = `%${query.search}%`;
      conditions.push(
        or(
          ilike(contacts.pushName, searchTerm),
          ilike(contacts.displayName, searchTerm),
          ilike(contacts.phoneNumber, searchTerm),
          ilike(contacts.waId, searchTerm)
        )!
      );
    }

    const [rows, [totalResult]] = await Promise.all([
      db
        .select()
        .from(contacts)
        .where(and(...conditions))
        .orderBy(
          sql`COALESCE(contacts.display_name, contacts.push_name, contacts.phone_number)`,
        )
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(contacts)
        .where(and(...conditions)),
    ]);

    const total = totalResult?.total ?? 0;

    return {
      contacts: rows as Contact[],
      total,
      hasMore: offset + limit < total,
    };
  }

  /**
   * Get a single contact by ID.
   */
  async getContactById(orgId: string, contactId: string): Promise<Contact | null> {
    const [result] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)))
      .limit(1);
    return (result as Contact) ?? null;
  }

  /**
   * Get a contact by WhatsApp JID.
   */
  async getContactByWaId(sessionId: string, waId: string): Promise<Contact | null> {
    const [result] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.sessionId, sessionId), eq(contacts.waId, waId)))
      .limit(1);
    return (result as Contact) ?? null;
  }

  /**
   * Update contact display name.
   */
  async updateContact(
    orgId: string,
    contactId: string,
    data: { displayName?: string; metadata?: Record<string, unknown> }
  ): Promise<Contact | null> {
    const [result] = await db
      .update(contacts)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)))
      .returning();
    return (result as Contact) ?? null;
  }

  /**
   * Delete a contact.
   */
  async deleteContact(orgId: string, contactId: string): Promise<void> {
    await db
      .delete(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)));
  }
}

export const contactService = new ContactService();
