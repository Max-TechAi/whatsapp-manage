/**
 * Shared credential extraction for JWT and API keys.
 */

import type { Request } from 'express';
import { isApiKeyToken } from '../../security/api-key.js';

export type AuthMethod = 'jwt' | 'api_key';

/** Extract bearer or API key credential from request headers/query. */
export function extractAuthCredential(req: Request): string | undefined {
  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) {
    return apiKeyHeader.trim();
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }

  if (req.query.token && typeof req.query.token === 'string') {
    const queryToken = req.query.token.trim();
    // Query-string auth is JWT-only (media URLs) — never accept API keys via query
    if (!isApiKeyToken(queryToken)) {
      return queryToken;
    }
  }

  return undefined;
}

export function classifyCredential(token: string): AuthMethod {
  return isApiKeyToken(token) ? 'api_key' : 'jwt';
}
