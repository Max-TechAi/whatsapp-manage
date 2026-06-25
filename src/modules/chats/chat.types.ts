/**
 * Chat/Conversation type definitions.
 */

export type ChatType = 'private' | 'group';

export interface Chat {
  id: string;
  orgId: string;
  sessionId: string;
  waChatId: string;
  chatType: ChatType;
  name: string | null;
  avatarUrl: string | null;
  unreadCount: number;
  isArchived: boolean;
  isPinned: boolean;
  mutedUntil: Date | null;
  lastMessagePreview: string | null;
  lastMessageAt: Date | null;
  metadata: Record<string, unknown>;
  assignedToUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatListQuery {
  sessionId: string;
  archived?: boolean;
  limit?: number;
  cursor?: string;
}

export interface ChatListResponse {
  chats: Chat[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ChatUpdatePayload {
  chatId: string;
  unreadCount?: number;
  isArchived?: boolean;
  isPinned?: boolean;
  mutedUntil?: Date | null;
  name?: string;
  avatarUrl?: string;
  assignedToUserId?: string | null;
}
