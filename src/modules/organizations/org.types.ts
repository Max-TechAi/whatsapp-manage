/**
 * Organization entity as returned by API responses.
 */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: 'free' | 'pro' | 'enterprise';
  settings: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Partial update payload for an organization.
 */
export interface UpdateOrgRequest {
  name?: string;
  settings?: Record<string, unknown>;
}

/**
 * Organization member as returned by the members list endpoint.
 * Excludes sensitive fields like password hash.
 */
export interface OrgMember {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  isActive: boolean;
  hasAllSessionsAccess: boolean;
  lastLoginAt: Date | null;
}
