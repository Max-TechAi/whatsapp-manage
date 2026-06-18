/**
 * Session event definitions and Baileys-to-app event mapping utilities.
 *
 * Transforms raw Baileys protocol data (protobuf-based WAMessage)
 * into our normalized internal structures for storage and processing.
 */

import type { WAMessage, proto } from '@whiskeysockets/baileys';
import { v4 as uuidv4 } from 'uuid';
import type { MessageType } from '../messages/message.types.js';

/**
 * Canonical event types emitted by the session layer.
 * These map to WebSocket channels and BullMQ queue topics.
 */
export enum SessionEventType {
  /** QR code generated, client should display for scanning */
  QR_GENERATED = 'session:qr',
  /** Session fully authenticated and connected */
  CONNECTED = 'session:connected',
  /** Session disconnected (may reconnect automatically) */
  DISCONNECTED = 'session:disconnected',
  /** New inbound message received */
  MESSAGE_RECEIVED = 'message:received',
  /** Outbound message sent confirmation */
  MESSAGE_SENT = 'message:sent',
  /** Message status update (delivered, read, etc.) */
  MESSAGE_UPDATED = 'message:updated',
  /** Chat metadata changed */
  CHAT_UPDATED = 'chat:updated',
  /** Contact info changed */
  CONTACT_UPDATED = 'contact:updated',
  /** Presence (online/typing) status change */
  PRESENCE_UPDATED = 'presence:updated',
  /** History sync batch received */
  HISTORY_SYNC = 'history:sync',
}

/**
 * Extracted message content from a Baileys WAMessage.
 * Normalizes the many message subtypes into a single shape.
 */
export interface ExtractedContent {
  /** Our normalized message type */
  type: MessageType;
  /** Text content (body text, caption, etc.), null for media-only */
  content: string | null;
  /** Media metadata if the message contains media */
  mediaInfo: {
    mimeType?: string;
    size?: number;
    fileName?: string;
  } | null;
}

/**
 * Transform a raw Baileys WAMessage into a plain object matching
 * our messages table schema for database insertion.
 *
 * @param waMessage - Raw protobuf WAMessage from Baileys
 * @param sessionId - Session that received the message
 * @param orgId - Organization scope
 * @param chatId - Internal chat ID this message belongs to
 * @returns Normalized message record ready for DB insertion
 */
export function transformWAMessage(
  waMessage: WAMessage,
  sessionId: string,
  orgId: string,
  chatId: string,
): Record<string, unknown> {
  const messageContent = waMessage.message;
  const extracted = extractMessageContent(waMessage);
  const key = waMessage.key;

  // Extract quoted message info if present
  const contextInfo = getContextInfo(messageContent);
  const quotedMessageId = contextInfo?.quotedMessage
    ? contextInfo.stanzaId ?? null
    : null;
  const quotedContent = contextInfo?.quotedMessage
    ? extractTextFromMessage(contextInfo.quotedMessage)
    : null;

  // Forwarding detection
  const isForwarded = contextInfo?.isForwarded ?? false;
  const forwardScore = contextInfo?.forwardingScore ?? 0;

  return {
    id: uuidv4(),
    orgId,
    sessionId,
    chatId,
    waMessageId: key.id ?? '',
    senderJid: key.fromMe ? 'me' : normalizeJid(key.remoteJid ?? ''),
    fromMe: key.fromMe ?? false,
    messageType: extracted.type,
    content: extracted.content,
    mediaUrl: null, // Set later after media download
    mediaMimeType: extracted.mediaInfo?.mimeType ?? null,
    mediaSize: extracted.mediaInfo?.size ?? null,
    quotedMessageId,
    quotedContent,
    status: key.fromMe ? 'sent' : 'delivered',
    isForwarded,
    forwardScore,
    starred: false,
    metadata: {},
    createdAt: waMessage.messageTimestamp
      ? new Date(
          typeof waMessage.messageTimestamp === 'number'
            ? waMessage.messageTimestamp * 1000
            : Number(waMessage.messageTimestamp) * 1000,
        )
      : new Date(),
    updatedAt: null,
    deletedAt: null,
  };
}

/**
 * Extract text content, message type, and media info from a WAMessage.
 * Handles all common WhatsApp message subtypes.
 *
 * @param waMessage - Raw WAMessage from Baileys
 * @returns Normalized content extraction result
 */
export function extractMessageContent(waMessage: WAMessage): ExtractedContent {
  const msg = waMessage.message;

  if (!msg) {
    return { type: 'system', content: null, mediaInfo: null };
  }

  // Text message (simple conversation)
  if (msg.conversation) {
    return { type: 'text', content: msg.conversation, mediaInfo: null };
  }

  // Extended text message (with link preview, mentions, etc.)
  if (msg.extendedTextMessage) {
    return {
      type: 'text',
      content: msg.extendedTextMessage.text ?? null,
      mediaInfo: null,
    };
  }

  // Image message
  if (msg.imageMessage) {
    return {
      type: 'image',
      content: msg.imageMessage.caption ?? null,
      mediaInfo: {
        mimeType: msg.imageMessage.mimetype ?? undefined,
        size: msg.imageMessage.fileLength
          ? Number(msg.imageMessage.fileLength)
          : undefined,
      },
    };
  }

  // Video message
  if (msg.videoMessage) {
    return {
      type: 'video',
      content: msg.videoMessage.caption ?? null,
      mediaInfo: {
        mimeType: msg.videoMessage.mimetype ?? undefined,
        size: msg.videoMessage.fileLength
          ? Number(msg.videoMessage.fileLength)
          : undefined,
      },
    };
  }

  // Audio message (including voice notes)
  if (msg.audioMessage) {
    return {
      type: 'audio',
      content: null,
      mediaInfo: {
        mimeType: msg.audioMessage.mimetype ?? undefined,
        size: msg.audioMessage.fileLength
          ? Number(msg.audioMessage.fileLength)
          : undefined,
      },
    };
  }

  // Document message
  if (msg.documentMessage) {
    return {
      type: 'document',
      content: msg.documentMessage.caption ?? null,
      mediaInfo: {
        mimeType: msg.documentMessage.mimetype ?? undefined,
        size: msg.documentMessage.fileLength
          ? Number(msg.documentMessage.fileLength)
          : undefined,
        fileName: msg.documentMessage.fileName ?? undefined,
      },
    };
  }

  // Sticker message
  if (msg.stickerMessage) {
    return {
      type: 'sticker',
      content: null,
      mediaInfo: {
        mimeType: msg.stickerMessage.mimetype ?? undefined,
        size: msg.stickerMessage.fileLength
          ? Number(msg.stickerMessage.fileLength)
          : undefined,
      },
    };
  }

  // Location message
  if (msg.locationMessage) {
    const loc = msg.locationMessage;
    return {
      type: 'location',
      content: JSON.stringify({
        latitude: loc.degreesLatitude,
        longitude: loc.degreesLongitude,
        name: loc.name ?? null,
        address: loc.address ?? null,
      }),
      mediaInfo: null,
    };
  }

  // Live location message
  if (msg.liveLocationMessage) {
    const loc = msg.liveLocationMessage;
    return {
      type: 'location',
      content: JSON.stringify({
        latitude: loc.degreesLatitude,
        longitude: loc.degreesLongitude,
        caption: loc.caption ?? null,
      }),
      mediaInfo: null,
    };
  }

  // Contact message
  if (msg.contactMessage) {
    return {
      type: 'contact',
      content: msg.contactMessage.vcard ?? null,
      mediaInfo: null,
    };
  }

  // Contact array message
  if (msg.contactsArrayMessage) {
    return {
      type: 'contact',
      content: JSON.stringify(
        msg.contactsArrayMessage.contacts?.map((c) => ({
          displayName: c.displayName,
          vcard: c.vcard,
        })) ?? [],
      ),
      mediaInfo: null,
    };
  }

  // Reaction message
  if (msg.reactionMessage) {
    return {
      type: 'reaction',
      content: msg.reactionMessage.text ?? null,
      mediaInfo: null,
    };
  }

  // Poll creation message
  if (msg.pollCreationMessage || msg.pollCreationMessageV2 || msg.pollCreationMessageV3) {
    const poll =
      msg.pollCreationMessage ??
      msg.pollCreationMessageV2 ??
      msg.pollCreationMessageV3;
    return {
      type: 'poll',
      content: poll?.name ?? null,
      mediaInfo: null,
    };
  }

  // Protocol/system messages (ephemeral settings, etc.)
  if (
    msg.protocolMessage ||
    msg.senderKeyDistributionMessage ||
    msg.messageContextInfo
  ) {
    return { type: 'system', content: null, mediaInfo: null };
  }

  // Fallback for unknown message types
  return { type: 'system', content: null, mediaInfo: null };
}

/**
 * Determine if a JID represents a private chat or a group.
 *
 * @param jid - WhatsApp JID string
 * @returns 'group' for group chats (@g.us), 'private' for individual chats
 */
export function getJidType(jid: string): 'private' | 'group' {
  if (jid.endsWith('@g.us')) {
    return 'group';
  }
  return 'private';
}

/**
 * Normalize a WhatsApp JID by removing the device suffix.
 *
 * Baileys multi-device JIDs include a `:XX` device identifier
 * (e.g. `1234567890:12@s.whatsapp.net`) which varies across
 * sessions. We strip it for consistent storage and lookups.
 *
 * @param jid - Raw JID from Baileys
 * @returns Normalized JID without device suffix
 */
export function normalizeJid(jid: string): string {
  if (!jid) return jid;

  // Split at '@' to get user part and server part
  const atIndex = jid.indexOf('@');
  if (atIndex === -1) return jid;

  const userPart = jid.substring(0, atIndex);
  const serverPart = jid.substring(atIndex);

  // Remove device suffix (`:XX`) from user part
  const colonIndex = userPart.indexOf(':');
  if (colonIndex === -1) return jid;

  return userPart.substring(0, colonIndex) + serverPart;
}

// ─── Private Helpers ─────────────────────────────────────────────────────────

/**
 * Extract contextInfo (quoted messages, forwarding info) from a message.
 */
function getContextInfo(
  message: proto.IMessage | null | undefined,
): proto.IContextInfo | null {
  if (!message) return null;

  // Check each message type for contextInfo
  const msgWithContext =
    message.extendedTextMessage ??
    message.imageMessage ??
    message.videoMessage ??
    message.audioMessage ??
    message.documentMessage ??
    message.stickerMessage ??
    message.contactMessage ??
    message.locationMessage;

  return (msgWithContext as { contextInfo?: proto.IContextInfo } | null)
    ?.contextInfo ?? null;
}

/**
 * Extract plain text content from an IMessage for quoted message preview.
 */
function extractTextFromMessage(
  message: proto.IMessage | null | undefined,
): string | null {
  if (!message) return null;

  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;

  return null;
}
