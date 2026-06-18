/**
 * Contact type definitions.
 */

export interface Contact {
  id: string;
  orgId: string;
  sessionId: string;
  waId: string;
  phoneNumber: string | null;
  pushName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  isBusiness: boolean;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContactListQuery {
  sessionId: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ContactListResponse {
  contacts: Contact[];
  total: number;
  hasMore: boolean;
}

export interface ContactSyncPayload {
  sessionId: string;
  orgId: string;
  contacts: Array<{
    waId: string;
    pushName?: string;
    displayName?: string;
    avatarUrl?: string;
    isBusiness?: boolean;
    phoneNumber?: string;
  }>;
}
