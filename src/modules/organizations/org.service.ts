import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../config/database.js';
import { users, organizations } from '../../db/schema.js';
import { hashPassword, generateRandomKey } from '../../security/encryption.js';
import { logger } from '../../observability/logger.js';
import type { Organization, UpdateOrgRequest, OrgMember } from './org.types.js';

/**
 * Retrieve an organization by its ID.
 *
 * @param orgId - Organization UUID
 * @returns Organization entity or null if not found
 */
export async function getOrganization(orgId: string): Promise<Organization | null> {
  const rows = await db.select({
    id: organizations.id,
    name: organizations.name,
    slug: organizations.slug,
    plan: organizations.plan,
    settings: organizations.settings,
    createdAt: organizations.createdAt,
  })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const org = rows[0];
  if (!org) return null;

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    plan: org.plan as Organization['plan'],
    settings: (org.settings ?? {}) as Record<string, unknown>,
    createdAt: org.createdAt,
  };
}

/**
 * Update an organization's mutable fields (name, settings).
 *
 * @param orgId - Organization UUID
 * @param data - Fields to update
 * @returns Updated organization or null if not found
 */
export async function updateOrganization(
  orgId: string,
  data: UpdateOrgRequest,
): Promise<Organization | null> {
  const updatePayload: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (data.name !== undefined) {
    updatePayload.name = data.name;
  }
  if (data.settings !== undefined) {
    updatePayload.settings = data.settings;
  }

  const rows = await db.update(organizations)
    .set(updatePayload)
    .where(eq(organizations.id, orgId))
    .returning({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      plan: organizations.plan,
      settings: organizations.settings,
      createdAt: organizations.createdAt,
    });

  const org = rows[0];
  if (!org) return null;

  logger.info('Organization updated', { orgId });

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    plan: org.plan as Organization['plan'],
    settings: (org.settings ?? {}) as Record<string, unknown>,
    createdAt: org.createdAt,
  };
}

/**
 * List all members of an organization.
 * Returns non-sensitive user fields, scoped to the given org.
 *
 * @param orgId - Organization UUID
 * @returns Array of org members
 */
export async function getMembers(orgId: string): Promise<OrgMember[]> {
  const rows = await db.select({
    id: users.id,
    email: users.email,
    displayName: users.displayName,
    role: users.role,
    isActive: users.isActive,
    hasAllSessionsAccess: users.hasAllSessionsAccess,
    lastLoginAt: users.lastLoginAt,
  })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.isActive, true)));

  return rows;
}

/**
 * Invite a new member to the organization.
 * Creates a user with a temporary random password that must be changed on first login.
 *
 * @param orgId - Organization UUID
 * @param email - Invitee's email address
 * @param role - Role to assign ('admin' or 'agent')
 * @returns The created member
 * @throws Error if the email is already registered
 */
export async function inviteMember(
  orgId: string,
  email: string,
  role: string,
): Promise<OrgMember> {
  // Check for existing user with this email
  const existing = await db.select({ id: users.id, isActive: users.isActive })
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  const existingUser = existing[0];
  if (existingUser) {
    if (existingUser.isActive) {
      throw new Error('EMAIL_EXISTS');
    }

    // Reactivate soft-deleted user
    const tempPassword = generateRandomKey(16);
    const passwordHash = await hashPassword(tempPassword);
    const now = new Date();

    const rows = await db.update(users)
      .set({
        orgId,
        role: role as 'admin' | 'agent',
        passwordHash,
        isActive: true,
        updatedAt: now,
      })
      .where(eq(users.id, existingUser.id))
      .returning({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        isActive: users.isActive,
        hasAllSessionsAccess: users.hasAllSessionsAccess,
        lastLoginAt: users.lastLoginAt,
      });

    return rows[0]!;
  }

  // Generate a temporary password — in production, send a password-reset link instead
  const tempPassword = generateRandomKey(16);
  const passwordHash = await hashPassword(tempPassword);
  const userId = uuidv4();
  const now = new Date();

  const rows = await db.insert(users).values({
    id: userId,
    orgId,
    email: email.toLowerCase(),
    passwordHash,
    displayName: email.split('@')[0] ?? email,
    role: role as 'admin' | 'agent',
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }).returning({
    id: users.id,
    email: users.email,
    displayName: users.displayName,
    role: users.role,
    isActive: users.isActive,
    hasAllSessionsAccess: users.hasAllSessionsAccess,
    lastLoginAt: users.lastLoginAt,
  });

  const member = rows[0]!;

  logger.info('Member invited to organization', { orgId, userId, role });

  return member;
}

/**
 * Soft-delete a member by setting isActive to false.
 * Preserves the user record for audit purposes.
 *
 * @param orgId - Organization UUID (for scoping)
 * @param userId - User UUID to deactivate
 * @throws Error if the user is not found in the organization
 */
export async function removeMember(orgId: string, userId: string): Promise<void> {
  const rows = await db.update(users)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .returning({ id: users.id });

  if (rows.length === 0) {
    throw new Error('USER_NOT_FOUND');
  }

  logger.info('Member removed from organization', { orgId, userId });
}

/**
 * Update an organization member's fields (displayName, role, isActive).
 */
export async function updateMember(
  orgId: string,
  userId: string,
  data: {
    displayName?: string;
    role?: 'admin' | 'agent';
    isActive?: boolean;
    hasAllSessionsAccess?: boolean;
    password?: string;
  }
): Promise<OrgMember | null> {
  const updatePayload: Record<string, any> = {
    updatedAt: new Date(),
  };

  if (data.displayName !== undefined) updatePayload.displayName = data.displayName;
  if (data.role !== undefined) updatePayload.role = data.role;
  if (data.isActive !== undefined) updatePayload.isActive = data.isActive;
  if (data.hasAllSessionsAccess !== undefined) {
    updatePayload.hasAllSessionsAccess = data.hasAllSessionsAccess;
  }

  // If role is admin, they implicitly have all session access
  if (data.role === 'admin') {
    updatePayload.hasAllSessionsAccess = true;
  }

  if (data.password !== undefined && data.password.trim() !== '') {
    updatePayload.passwordHash = await hashPassword(data.password);
  }

  const member = await db.transaction(async (tx) => {
    const rows = await tx
      .update(users)
      .set(updatePayload)
      .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
      .returning({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        isActive: users.isActive,
        hasAllSessionsAccess: users.hasAllSessionsAccess,
        lastLoginAt: users.lastLoginAt,
      });

    const updatedUser = rows[0];
    if (!updatedUser) return null;

    // Purge userSessionAccess if promoted to admin
    if (data.role === 'admin') {
      const { userSessionAccess } = await import('../../db/schema.js');
      await tx
        .delete(userSessionAccess)
        .where(eq(userSessionAccess.userId, userId));
    }

    return updatedUser;
  });

  if (member) {
    logger.info('Member updated successfully', { orgId, userId, role: data.role });
  }

  return member;
}

/**
 * Update user's Level 1 session permissions.
 */
export async function updateMemberPermissions(
  orgId: string,
  userId: string,
  data: {
    hasAllSessionsAccess: boolean;
    sessionIds: string[];
  }
): Promise<void> {
  // Verify user exists in the org
  const [user] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .limit(1);

  if (!user) {
    throw new Error('USER_NOT_FOUND');
  }

  const finalHasAll = user.role === 'admin' ? true : data.hasAllSessionsAccess;

  await db.transaction(async (tx) => {
    // Update users table
    await tx
      .update(users)
      .set({
        hasAllSessionsAccess: finalHasAll,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    const { userSessionAccess } = await import('../../db/schema.js');

    // Delete existing session access
    await tx
      .delete(userSessionAccess)
      .where(eq(userSessionAccess.userId, userId));

    // Insert new specific session access rows
    if (!finalHasAll && data.sessionIds && data.sessionIds.length > 0) {
      await tx.insert(userSessionAccess).values(
        data.sessionIds.map((sessionId) => ({
          userId,
          sessionId,
        }))
      );
    }
  });

  logger.info('Member permissions updated successfully', { orgId, userId });
}

/**
 * Get user's current session access list.
 */
export async function getMemberPermissions(orgId: string, userId: string) {
  const [user] = await db
    .select({
      id: users.id,
      hasAllSessionsAccess: users.hasAllSessionsAccess,
      role: users.role,
    })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .limit(1);

  if (!user) {
    throw new Error('USER_NOT_FOUND');
  }

  const { userSessionAccess } = await import('../../db/schema.js');
  const allowedSessions = await db
    .select({
      sessionId: userSessionAccess.sessionId,
    })
    .from(userSessionAccess)
    .where(eq(userSessionAccess.userId, userId));

  return {
    hasAllSessionsAccess: user.role === 'admin' ? true : user.hasAllSessionsAccess,
    sessionIds: allowedSessions.map((row) => row.sessionId),
  };
}
