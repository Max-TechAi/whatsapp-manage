/**
 * @fileoverview Immutable audit logs for security-sensitive operations.
 */

import { db } from '../config/database.js';
import { auditLogs } from '../db/schema.js';
import type { Request } from 'express';
import { logger } from '../observability/logger.js';

export interface AuditLogPayload {
  orgId: string;
  userId?: string | null;
  sessionId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  details?: Record<string, any>;
}

export const auditService = {
  /**
   * Log an audit event.
   * Fails open but logs errors to prevent blocking main transactions.
   */
  async log(payload: AuditLogPayload): Promise<void> {
    try {
      await db.insert(auditLogs).values({
        orgId: payload.orgId,
        userId: payload.userId || null,
        sessionId: payload.sessionId || null,
        action: payload.action,
        resourceType: payload.resourceType,
        resourceId: payload.resourceId || null,
        ipAddress: payload.ipAddress || null,
        userAgent: payload.userAgent || null,
        details: payload.details || {},
      });
    } catch (err) {
      logger.error('Failed to write audit log to database', {
        error: (err as Error).message,
        payload,
      });
    }
  },

  /**
   * Log an audit event automatically extracting tenant/user details from Express Request.
   */
  async logFromRequest(
    req: Request,
    action: string,
    resourceType: string,
    resourceId?: string | null,
    details?: Record<string, any>
  ): Promise<void> {
    if (!req.user) {
      logger.warn('Attempted to log audit from request without req.user', { action, resourceType });
      return;
    }

    await this.log({
      orgId: req.user.orgId,
      userId: req.user.userId,
      action,
      resourceType,
      resourceId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      details,
    });
  }
};
