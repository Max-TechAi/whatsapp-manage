import crypto from 'node:crypto';
import { getEnv } from '../config/env.js';

export const API_KEY_PREFIX = 'wa_live_';

/** Detect API key tokens (distinct from JWT which uses dot-separated segments). */
export function isApiKeyToken(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

/** HMAC-SHA256 hash of the full API key using server pepper. */
export function hashApiKey(plaintext: string): string {
  const pepper = getEnv().ENCRYPTION_KEY;
  return crypto.createHmac('sha256', pepper).update(plaintext).digest('hex');
}

export function verifyApiKeyHash(plaintext: string, storedHash: string): boolean {
  const computed = hashApiKey(plaintext);
  try {
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch {
    return false;
  }
}

/** Generate a new API key: plaintext shown once, prefix for lookup, hash for storage. */
export function generateApiKeyMaterial(): {
  plaintext: string;
  keyPrefix: string;
  keyHash: string;
} {
  const secret = crypto.randomBytes(24).toString('base64url');
  const plaintext = `${API_KEY_PREFIX}${secret}`;
  const keyPrefix = plaintext.slice(0, 20);
  return {
    plaintext,
    keyPrefix,
    keyHash: hashApiKey(plaintext),
  };
}

/** Extract lookup prefix from a presented API key. */
export function extractApiKeyPrefix(plaintext: string): string {
  return plaintext.slice(0, 20);
}
