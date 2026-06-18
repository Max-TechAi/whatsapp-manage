/**
 * Session type definitions for WhatsApp connection management.
 * These types map Baileys socket state to our multi-tenant data model.
 */

import type { WASocket, WAMessage, proto } from '@whiskeysockets/baileys';

/**
 * Represents a persisted WhatsApp session in the database.
 * Each session maps to a single WhatsApp account connection.
 */
export interface WhatsAppSession {
  /** Unique session identifier (UUID) */
  id: string;
  /** Organization this session belongs to (multi-tenancy scope) */
  orgId: string;
  /** User who created this session */
  userId: string;
  /** Human-readable session label (e.g. "Sales Phone") */
  sessionName: string;
  /** Phone number once authenticated, null before QR scan */
  phoneNumber: string | null;
  /** Current connection lifecycle state */
  status: SessionStatus;
  /** Base64 QR code data URL for pairing, null when not in QR state */
  qrCode: string | null;
  /** Last time this session was fully connected */
  lastConnectedAt: Date | null;
  /** Session creation timestamp */
  createdAt: Date;
}

/**
 * Session connection lifecycle states.
 *
 * Flow: initializing → qr_pending → connecting → connected
 *                                                ↓
 *                                           disconnected (retryable)
 *                                                ↓
 *                                             banned (terminal)
 */
export type SessionStatus =
  | 'initializing'
  | 'qr_pending'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'banned';

/**
 * In-memory representation of a live Baileys socket connection.
 * Stored in SessionManager's activeSessions map.
 */
export interface ActiveSession {
  /** The Baileys WebSocket connection */
  socket: WASocket;
  /** Reference to the persisted session ID */
  sessionId: string;
  /** Organization scope for this session */
  orgId: string;
  /** Number of consecutive reconnection attempts */
  retryCount: number;
  /** Timestamp of last reconnection attempt */
  lastRetry: Date | null;
}

/**
 * Request body for creating a new session.
 */
export interface SessionCreateRequest {
  /** Human-readable name for the session */
  sessionName: string;
}

/**
 * Internal event representation for session lifecycle events.
 * Used to fan out Baileys events to our internal pub/sub.
 */
export interface SessionEvent {
  /** Session this event originated from */
  sessionId: string;
  /** Organization scope */
  orgId: string;
  /** Event type identifier */
  type: string;
  /** Event-specific payload data */
  payload: unknown;
  /** When the event occurred */
  timestamp: Date;
}

/**
 * QR code polling response for client-side pairing UI.
 */
export interface QrCodeResponse {
  /** Session being paired */
  sessionId: string;
  /** Base64 data URL of QR code, null if not in QR state */
  qrCode: string | null;
  /** Current session status */
  status: SessionStatus;
}
