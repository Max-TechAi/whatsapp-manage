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
    lastLoginAt: users.lastLoginAt,
  })
    .from(users)
    .where(eq(users.orgId, orgId));

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
  const existing = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  if (existing.length > 0) {
    throw new Error('EMAIL_EXISTS');
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
