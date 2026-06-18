/**
 * Webhook type definitions for external integrations.
 */

export interface Webhook {
  id: string;
  orgId: string;
  url: string;
  secret: string;
  events: WebhookEventType[];
  isActive: boolean;
  failureCount: number;
  lastTriggeredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type WebhookEventType =
  | 'message.received'
  | 'message.sent'
  | 'message.delivered'
  | 'message.read'
  | 'message.deleted'
  | 'session.connected'
  | 'session.disconnected'
  | 'chat.created'
  | 'chat.updated'
  | 'contact.created'
  | 'contact.updated';

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  payload: Record<string, unknown>;
  statusCode: number | null;
  response: string | null;
  attempts: number;
  deliveredAt: Date | null;
  createdAt: Date;
}

export interface WebhookCreateRequest {
  url: string;
  events: WebhookEventType[];
  secret?: string;
}

export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  orgId: string;
  data: Record<string, unknown>;
}

export interface WebhookDeliveryAttempt {
  webhookId: string;
  payload: WebhookPayload;
  attempt: number;
  maxAttempts: number;
}
