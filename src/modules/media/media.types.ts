/**
 * Media handling type definitions.
 */

export interface MediaFile {
  id: string;
  orgId: string;
  messageId: string | null;
  bucket: string;
  objectKey: string;
  originalFilename: string | null;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string | null;
  encryptionKeyId: string | null;
  thumbnailKey: string | null;
  transcodedVariants: Record<string, string>;
  createdAt: Date;
}

export interface MediaUploadRequest {
  orgId: string;
  sessionId: string;
  messageId?: string;
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export interface MediaUploadResult {
  fileId: string;
  objectKey: string;
  url: string;
  thumbnailUrl: string | null;
  sizeBytes: number;
  checksumSha256: string;
}

export interface PresignedUrlOptions {
  objectKey: string;
  expiresIn?: number;
}

export interface TranscodeRequest {
  fileId: string;
  objectKey: string;
  targetFormat: string;
  options?: Record<string, unknown>;
}

export type MediaCategory = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export function getMediaCategory(mimeType: string): MediaCategory {
  if (mimeType.startsWith('image/')) return mimeType.includes('webp') ? 'sticker' : 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}
