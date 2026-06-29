/**
 * Message type definitions for the WhatsApp Business API platform.
 * Maps WhatsApp message formats to our internal representation.
 */

export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'reaction'
  | 'poll'
  | 'system'
  | 'call';

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Message {
  id: string;
  orgId: string;
  sessionId: string;
  chatId: string;
  waMessageId: string;
  senderJid: string;
  fromMe: boolean;
  messageType: MessageType;
  content: string | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  mediaSize: number | null;
  quotedMessageId: string | null;
  quotedContent: string | null;
  status: MessageStatus;
  isForwarded: boolean;
  forwardScore: number;
  starred: boolean;
  metadata: Record<string, unknown>;
  isEdited?: boolean;
  editedAt?: Date | null;
  isDeleted?: boolean;
  sentByUserId?: string | null;
  sentByDisplayName?: string | null;
  createdAt: Date;
  updatedAt: Date | null;
  deletedAt: Date | null;
}

export interface SendMessageRequest {
  sessionId: string;
  chatId: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'document';
  content?: string;
  mediaUrl?: string;
  caption?: string;
  quotedMessageId?: string;
  mentions?: string[];
  sentByUserId?: string | null;
}

export interface PaginationCursor {
  createdAt: string;
  id: string;
}

export interface PaginatedMessages {
  messages: Message[];
  nextCursor: PaginationCursor | null;
  hasMore: boolean;
  totalEstimate?: number;
}

export interface MessageSearchRequest {
  sessionId?: string;
  chatId?: string;
  query: string;
  cursor?: PaginationCursor;
  limit?: number;
}

export interface MessageSearchResult {
  message: Message;
  rank: number;
  headline: string;
}

export interface MessageUpdatePayload {
  messageId: string;
  status?: MessageStatus;
  starred?: boolean;
  content?: string;
  deletedAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface BulkInsertResult {
  inserted: number;
  duplicates: number;
  errors: number;
}
