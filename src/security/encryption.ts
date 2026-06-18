import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { getEnv } from '../config/env.js';

/** AES-256-GCM algorithm identifier */
const ALGORITHM = 'aes-256-gcm';

/** IV size in bytes (96 bits is recommended for GCM) */
const IV_LENGTH = 12;

/** Auth tag length in bytes */
const TAG_LENGTH = 16;

/** Bcrypt cost factor — 2^12 iterations */
const SALT_ROUNDS = 12;

/**
 * Encrypt plaintext using AES-256-GCM.
 *
 * @param plaintext - The string to encrypt
 * @param keyHex - 64-char hex string (32 bytes). Defaults to env ENCRYPTION_KEY.
 * @returns Object with hex-encoded ciphertext, iv, and auth tag
 */
export function encrypt(
  plaintext: string,
  keyHex?: string,
): { ciphertext: string; iv: string; tag: string } {
  const key = Buffer.from(keyHex ?? getEnv().ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  };
}

/**
 * Decrypt ciphertext that was encrypted with AES-256-GCM.
 *
 * @param ciphertext - Hex-encoded ciphertext
 * @param iv - Hex-encoded initialization vector
 * @param tag - Hex-encoded authentication tag
 * @param keyHex - 64-char hex string (32 bytes). Defaults to env ENCRYPTION_KEY.
 * @returns The original plaintext string
 * @throws Error if decryption or authentication fails
 */
export function decrypt(
  ciphertext: string,
  iv: string,
  tag: string,
  keyHex?: string,
): string {
  const key = Buffer.from(keyHex ?? getEnv().ENCRYPTION_KEY, 'hex');
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'hex'),
    { authTagLength: TAG_LENGTH },
  );

  decipher.setAuthTag(Buffer.from(tag, 'hex'));

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Serialize data to JSON and encrypt it, returning a single base64 string.
 * The base64 payload contains JSON with { ciphertext, iv, tag }.
 *
 * @param data - Any JSON-serializable value
 * @param keyHex - Optional encryption key override
 * @returns Base64-encoded string containing the encrypted envelope
 */
export function encryptJSON(data: unknown, keyHex?: string): string {
  const json = JSON.stringify(data);
  const encrypted = encrypt(json, keyHex);
  return Buffer.from(JSON.stringify(encrypted)).toString('base64');
}

/**
 * Decrypt a base64 envelope produced by encryptJSON and parse the JSON payload.
 *
 * @typeParam T - The expected return type after JSON.parse
 * @param encrypted - Base64-encoded encrypted envelope
 * @param keyHex - Optional encryption key override
 * @returns The parsed object of type T
 */
export function decryptJSON<T>(encrypted: string, keyHex?: string): T {
  const envelope = JSON.parse(Buffer.from(encrypted, 'base64').toString('utf8')) as {
    ciphertext: string;
    iv: string;
    tag: string;
  };
  const json = decrypt(envelope.ciphertext, envelope.iv, envelope.tag, keyHex);
  return JSON.parse(json) as T;
}

/**
 * Hash a password using bcrypt with a cost factor of 12.
 * Never log the plaintext password.
 *
 * @param password - Plaintext password
 * @returns Bcrypt hash string
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a plaintext password against a bcrypt hash.
 *
 * @param password - Plaintext password to check
 * @param hash - Stored bcrypt hash
 * @returns True if the password matches
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generate a cryptographically secure random key as a hex string.
 *
 * @param bytes - Number of random bytes (default: 32 → 64 hex chars)
 * @returns Hex-encoded random key
 */
export function generateRandomKey(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}
