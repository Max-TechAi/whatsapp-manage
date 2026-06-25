/**
 * JWT token payload — embedded in both access and refresh tokens.
 * Kept small to minimize token size on every request.
 */
export interface JwtPayload {
  userId: string;
  orgId: string;
  email: string;
  role: 'admin' | 'agent';
  hasAllSessionsAccess: boolean;
}

/**
 * Access + refresh token pair returned after authentication.
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

/**
 * Request body for new user registration.
 * Creates both an organization and the first admin user.
 */
export interface RegisterRequest {
  email: string;
  password: string;
  displayName: string;
  orgName: string;
}

/**
 * Request body for user login.
 */
export interface LoginRequest {
  email: string;
  password: string;
}

/**
 * Unified auth response containing user info and token pair.
 */
export interface AuthResponse {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    role: string;
    orgId: string;
  };
  tokens: AuthTokens;
}
