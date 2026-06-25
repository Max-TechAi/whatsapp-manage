/**
 * @fileoverview Complete Drizzle ORM schema for the WhatsApp Business API platform.
 *
 * Design decisions:
 * - Multi-tenant: every resource table carries an `orgId` FK to `organizations`.
 * - UUID primary keys via PostgreSQL `gen_random_uuid()` — no application-layer UUID generation needed.
 * - JSONB columns for flexible metadata that doesn't warrant its own columns.
 * - tsvector column on `messages` for full-text search — populated by a SQL trigger (see migrate.ts).
 * - No partitioning — target volume (~500 msgs/day) doesn't justify the complexity.
 * - Soft-delete on messages via `deletedAt` timestamp.
 * - All timestamps are `timestamptz` (with timezone).
 */

import { relations, sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  text,
  uuid,
  varchar,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ─── Enums ──────────────────────────────────────────────────────────────────────

/** Organization billing plan */
export const planEnum = pgEnum('plan', ['free', 'pro', 'enterprise']);

/** User role within an organization */
export const userRoleEnum = pgEnum('user_role', ['admin', 'agent']);

// ─── 1. Organizations ──────────────────────────────────────────────────────────

/** Top-level tenant. All resources are scoped under an organization. */
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  plan: planEnum('plan').notNull().default('free'),
  /** Flexible org-level settings (rate limits, feature flags, etc.) */
  settings: jsonb('settings').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── 2. Users ───────────────────────────────────────────────────────────────────

/** Human user accounts. Email is globally unique across all orgs. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull().unique(),
    /** bcrypt hash — never log or expose */
    passwordHash: text('password_hash').notNull(),
    displayName: varchar('display_name', { length: 255 }),
    role: userRoleEnum('role').notNull().default('agent'),
    hasAllSessionsAccess: boolean('has_all_sessions_access').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_users_org_id').on(table.orgId),
  ],
);

// ─── 3. Sessions ────────────────────────────────────────────────────────────────

/**
 * WhatsApp device sessions managed by Baileys.
 * Each session represents one connected WhatsApp number.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionName: varchar('session_name', { length: 255 }).notNull(),
    /** Linked phone number once connected, null during QR phase */
    phoneNumber: varchar('phone_number', { length: 50 }),
    status: varchar('status', { length: 30 })
      .notNull()
      .default('initializing'),
    /** Base64-encoded QR code data, cleared after scan */
    qrCode: text('qr_code'),
    /** Encrypted Baileys AuthenticationCreds — AES-256-GCM wrapped */
    authCreds: jsonb('auth_creds'),
    lastConnectedAt: timestamp('last_connected_at', { withTimezone: true }),
    /** Flexible JSON metadata (e.g. historySyncCompleted, syncStatus, etc.) */
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_sessions_org_id').on(table.orgId),
    /**
     * Partial unique index: a phone number can only belong to one session per org.
     * NULL phone numbers are excluded (multiple sessions can be in QR phase).
     */
    uniqueIndex('uq_sessions_org_phone')
      .on(table.orgId, table.phoneNumber)
      .where(sql`${table.phoneNumber} IS NOT NULL`),
  ],
);

// ─── 4. Session Keys ────────────────────────────────────────────────────────────

/**
 * Signal protocol keys for Baileys multi-device auth state.
 * Stored encrypted via AES-256-GCM in the `keyData` JSONB field.
 */
export const sessionKeys = pgTable(
  'session_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    keyType: varchar('key_type', { length: 100 }).notNull(),
    keyId: varchar('key_id', { length: 255 }).notNull(),
    /** Encrypted key material — never log contents */
    keyData: jsonb('key_data').notNull(),
  },
  (table) => [
    uniqueIndex('uq_session_keys_type_id').on(
      table.sessionId,
      table.keyType,
      table.keyId,
    ),
    index('idx_session_keys_session_id').on(table.sessionId),
  ],
);

// ─── 4.5. User Session Access ───────────────────────────────────────────────────

/** Stores which employees have access to which WhatsApp sessions (Level 1 permissions) */
export const userSessionAccess = pgTable(
  'user_session_access',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_user_session_access_user_session').on(table.userId, table.sessionId),
    index('idx_user_session_access_user_id').on(table.userId),
  ],
);

// ─── 5. Contacts ────────────────────────────────────────────────────────────────

/** WhatsApp contacts discovered through message exchange or synced from the device. */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** WhatsApp JID, e.g. "1234567890@s.whatsapp.net" */
    waId: varchar('wa_id', { length: 100 }).notNull(),
    phoneNumber: varchar('phone_number', { length: 50 }),
    /** Name the user chose to display on WhatsApp */
    pushName: varchar('push_name', { length: 255 }),
    /** Locally assigned display name (by agent) */
    displayName: varchar('display_name', { length: 255 }),
    avatarUrl: text('avatar_url'),
    isBusiness: boolean('is_business').notNull().default(false),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_contacts_session_waid').on(table.sessionId, table.waId),
    index('idx_contacts_org_id').on(table.orgId),
  ],
);

// ─── 6. Chats ───────────────────────────────────────────────────────────────────

/** Chat threads (private 1:1 or group). One per remote JID per session. */
export const chats = pgTable(
  'chats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** Remote JID — the other party or group JID */
    waChatId: varchar('wa_chat_id', { length: 100 }).notNull(),
    chatType: varchar('chat_type', { length: 10 }).notNull().default('private'),
    name: varchar('name', { length: 255 }),
    avatarUrl: text('avatar_url'),
    unreadCount: integer('unread_count').notNull().default(0),
    isArchived: boolean('is_archived').notNull().default(false),
    isPinned: boolean('is_pinned').notNull().default(false),
    mutedUntil: timestamp('muted_until', { withTimezone: true }),
    /** Truncated last message body for chat list preview */
    lastMessagePreview: text('last_message_preview'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    metadata: jsonb('metadata').default({}),
    assignedToUserId: uuid('assigned_to_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_chats_session_wachatid').on(table.sessionId, table.waChatId),
    /** Descending index for chat list sorted by most-recent message */
    index('idx_chats_session_last_msg').on(table.sessionId, table.lastMessageAt),
    index('idx_chats_org_id').on(table.orgId),
  ],
);

// ─── 7. Messages ────────────────────────────────────────────────────────────────

/**
 * All WhatsApp messages across all sessions.
 * This is the highest-volume table; indexes are tuned for chat-scoped pagination.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    /** Baileys message key (serialized). Unique per session. */
    waMessageId: varchar('wa_message_id', { length: 255 }).notNull(),
    senderJid: varchar('sender_jid', { length: 100 }).notNull(),
    fromMe: boolean('from_me').notNull(),
    messageType: varchar('message_type', { length: 30 }).notNull().default('text'),
    content: text('content'),
    /** S3/MinIO URL for media attachments */
    mediaUrl: text('media_url'),
    mediaMimeType: varchar('media_mime_type', { length: 100 }),
    mediaSize: integer('media_size'),
    /** Self-referential FK for reply threading */
    quotedMessageId: uuid('quoted_message_id'),
    /** Preview text of the quoted message (denormalized for performance) */
    quotedContent: text('quoted_content'),
    status: varchar('status', { length: 20 }).notNull().default('sent'),
    isForwarded: boolean('is_forwarded').notNull().default(false),
    forwardScore: integer('forward_score').notNull().default(0),
    starred: boolean('starred').notNull().default(false),
    isEdited: boolean('is_edited').notNull().default(false),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    isDeleted: boolean('is_deleted').notNull().default(false),
    metadata: jsonb('metadata').default({}),
    sentByUserId: uuid('sent_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Full-text search vector column.
     * This column is managed by a PostgreSQL trigger (see migrate.ts).
     * DO NOT set this from application code — the trigger auto-populates it
     * from `content` on INSERT and UPDATE.
     */
    contentVector: text('content_vector'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft-delete: NULL means active, non-NULL means deleted */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('uq_messages_session_wamsgid').on(
      table.sessionId,
      table.waMessageId,
    ),
    /** Primary pagination index: fetch messages in a chat ordered by time desc */
    index('idx_messages_chat_created').on(
      table.chatId,
      table.createdAt,
      table.id,
    ),
    index('idx_messages_org_id').on(table.orgId),
    index('idx_messages_session_id').on(table.sessionId),
    /**
     * GIN index on metadata JSONB for flexible querying.
     * Uses raw SQL because Drizzle doesn't natively support GIN indexes.
     */
    index('idx_messages_metadata_gin')
      .using('gin', table.metadata),
  ],
);

// ─── 8. Message Reactions ───────────────────────────────────────────────────────

/** Emoji reactions on messages. One reaction per reactor per message. */
export const messageReactions = pgTable(
  'message_reactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    reactorJid: varchar('reactor_jid', { length: 100 }).notNull(),
    emoji: varchar('emoji', { length: 10 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_reactions_message_reactor').on(
      table.messageId,
      table.reactorJid,
    ),
  ],
);

// ─── 9. Media Files ─────────────────────────────────────────────────────────────

/** Object storage metadata for all uploaded/downloaded media. */
export const mediaFiles = pgTable(
  'media_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Nullable — media can exist without a message (e.g. profile pictures) */
    messageId: uuid('message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    bucket: varchar('bucket', { length: 255 }).notNull(),
    /** S3 object key — globally unique within the bucket */
    objectKey: varchar('object_key', { length: 1024 }).notNull().unique(),
    originalFilename: varchar('original_filename', { length: 512 }),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    checksumSha256: varchar('checksum_sha256', { length: 64 }),
    /** Reference to the encryption key used (for at-rest encryption) */
    encryptionKeyId: varchar('encryption_key_id', { length: 255 }),
    /** Object key of a generated thumbnail, if applicable */
    thumbnailKey: varchar('thumbnail_key', { length: 1024 }),
    /** Transcoded variants (e.g. { "webp": "key", "mp4_360p": "key" }) */
    transcodedVariants: jsonb('transcoded_variants').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_media_files_org_id').on(table.orgId),
    index('idx_media_files_message_id').on(table.messageId),
  ],
);

// ─── 10. Webhooks ───────────────────────────────────────────────────────────────

/** Outbound webhook subscriptions for real-time event delivery. */
export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    /** HMAC-SHA256 signing secret — never log */
    secret: varchar('secret', { length: 255 }).notNull(),
    /** Array of event type strings, e.g. ["message.received", "session.connected"] */
    events: jsonb('events').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /** Circuit breaker: increment on failure, reset on success */
    failureCount: integer('failure_count').notNull().default(0),
    lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_webhooks_org_id').on(table.orgId),
  ],
);

// ─── 11. Webhook Deliveries ─────────────────────────────────────────────────────

/** Delivery log for webhook invocations. Used for debugging and retry tracking. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    event: varchar('event', { length: 100 }).notNull(),
    payload: jsonb('payload').notNull(),
    statusCode: integer('status_code'),
    response: text('response'),
    attempts: integer('attempts').notNull().default(0),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_webhook_deliveries_webhook_id').on(table.webhookId),
    index('idx_webhook_deliveries_created').on(table.createdAt),
  ],
);

// ─── 12. Audit Logs ─────────────────────────────────────────────────────────────

/**
 * Immutable audit trail for security-sensitive operations.
 * Insert-only — no UPDATE/DELETE allowed (enforce via app-level policy).
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    sessionId: uuid('session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    /** e.g. "message.send", "session.create", "user.login" */
    action: varchar('action', { length: 100 }).notNull(),
    /** e.g. "session", "message", "user", "webhook" */
    resourceType: varchar('resource_type', { length: 100 }).notNull(),
    resourceId: varchar('resource_id', { length: 255 }),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    /** Arbitrary details about the action (diff, old/new values, etc.) */
    details: jsonb('details').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_audit_logs_org_id').on(table.orgId),
    index('idx_audit_logs_user_id').on(table.userId),
    index('idx_audit_logs_action').on(table.action),
    index('idx_audit_logs_created').on(table.createdAt),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════════
// Relations — used by Drizzle's relational query builder (db.query.*)
// ═══════════════════════════════════════════════════════════════════════════════

/** Organization has many users, sessions, contacts, chats, messages, etc. */
export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  sessions: many(sessions),
  contacts: many(contacts),
  chats: many(chats),
  messages: many(messages),
  mediaFiles: many(mediaFiles),
  webhooks: many(webhooks),
  auditLogs: many(auditLogs),
}));

/** User belongs to an org, can own sessions, and appear in audit logs. */
export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [users.orgId],
    references: [organizations.id],
  }),
  sessions: many(sessions),
  auditLogs: many(auditLogs),
  sessionAccess: many(userSessionAccess),
  assignedChats: many(chats),
  sentMessages: many(messages),
}));

/** Session belongs to an org and user; has keys, contacts, chats, messages, audit logs. */
export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [sessions.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
  keys: many(sessionKeys),
  contacts: many(contacts),
  chats: many(chats),
  messages: many(messages),
  auditLogs: many(auditLogs),
  userAccess: many(userSessionAccess),
}));

/** Session key belongs to a session. */
export const sessionKeysRelations = relations(sessionKeys, ({ one }) => ({
  session: one(sessions, {
    fields: [sessionKeys.sessionId],
    references: [sessions.id],
  }),
}));

/** Contact belongs to an org and session. */
export const contactsRelations = relations(contacts, ({ one }) => ({
  organization: one(organizations, {
    fields: [contacts.orgId],
    references: [organizations.id],
  }),
  session: one(sessions, {
    fields: [contacts.sessionId],
    references: [sessions.id],
  }),
}));

/** Chat belongs to an org and session; has many messages. */
export const chatsRelations = relations(chats, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [chats.orgId],
    references: [organizations.id],
  }),
  session: one(sessions, {
    fields: [chats.sessionId],
    references: [sessions.id],
  }),
  messages: many(messages),
  assignedToUser: one(users, {
    fields: [chats.assignedToUserId],
    references: [users.id],
  }),
}));

/** Message belongs to an org, session, and chat; may have reactions, media, and a quoted parent. */
export const messagesRelations = relations(messages, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [messages.orgId],
    references: [organizations.id],
  }),
  session: one(sessions, {
    fields: [messages.sessionId],
    references: [sessions.id],
  }),
  chat: one(chats, {
    fields: [messages.chatId],
    references: [chats.id],
  }),
  /** Self-referential: the message this one quotes/replies to */
  quotedMessage: one(messages, {
    fields: [messages.quotedMessageId],
    references: [messages.id],
    relationName: 'quotedMessage',
  }),
  /** Messages that quote this message */
  replies: many(messages, { relationName: 'quotedMessage' }),
  reactions: many(messageReactions),
  mediaFiles: many(mediaFiles),
  sentByUser: one(users, {
    fields: [messages.sentByUserId],
    references: [users.id],
  }),
}));

/** Reaction belongs to a message. */
export const messageReactionsRelations = relations(
  messageReactions,
  ({ one }) => ({
    message: one(messages, {
      fields: [messageReactions.messageId],
      references: [messages.id],
    }),
  }),
);

/** Media file belongs to an org and optionally a message. */
export const mediaFilesRelations = relations(mediaFiles, ({ one }) => ({
  organization: one(organizations, {
    fields: [mediaFiles.orgId],
    references: [organizations.id],
  }),
  message: one(messages, {
    fields: [mediaFiles.messageId],
    references: [messages.id],
  }),
}));

/** Webhook belongs to an org; has delivery log entries. */
export const webhooksRelations = relations(webhooks, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [webhooks.orgId],
    references: [organizations.id],
  }),
  deliveries: many(webhookDeliveries),
}));

/** Webhook delivery belongs to a webhook. */
export const webhookDeliveriesRelations = relations(
  webhookDeliveries,
  ({ one }) => ({
    webhook: one(webhooks, {
      fields: [webhookDeliveries.webhookId],
      references: [webhooks.id],
    }),
  }),
);

/** Audit log belongs to an org, optionally a user and session. */
export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  organization: one(organizations, {
    fields: [auditLogs.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [auditLogs.userId],
    references: [users.id],
  }),
  session: one(sessions, {
    fields: [auditLogs.sessionId],
    references: [sessions.id],
  }),
}));
