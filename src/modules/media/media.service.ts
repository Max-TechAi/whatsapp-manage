/**
 * Media Service — MinIO upload/download, thumbnails, presigned URLs, and dedup.
 * Uses AES-256 server-side encryption at rest in MinIO.
 */

import { Client as MinioClient } from 'minio';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { db } from '../../config/database.js';
import { mediaFiles } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getEnv } from '../../config/env.js';
import { logger } from '../../observability/logger.js';
import type { MediaFile, MediaUploadRequest, MediaUploadResult, PresignedUrlOptions } from './media.types.js';

const env = getEnv();

/** MinIO client singleton */
const minio = new MinioClient({
  endPoint: env.MINIO_ENDPOINT,
  port: env.MINIO_PORT,
  useSSL: env.MINIO_USE_SSL,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
});

export class MediaService {
  private bucket: string;

  constructor() {
    this.bucket = env.MINIO_BUCKET;
  }

  /**
   * Initialize MinIO bucket (create if not exists).
   * Called once during server startup.
   */
  async initialize(): Promise<void> {
    try {
      const exists = await minio.bucketExists(this.bucket);
      if (!exists) {
        await minio.makeBucket(this.bucket);
        logger.info('MinIO bucket created', { bucket: this.bucket });
      }
    } catch (err) {
      logger.error('Failed to initialize MinIO', { error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Upload a file to MinIO with SHA-256 dedup.
   * If a file with the same checksum exists, returns existing reference.
   */
  async upload(request: MediaUploadRequest): Promise<MediaUploadResult> {
    const checksum = crypto.createHash('sha256').update(request.buffer).digest('hex');

    // Check for existing file with same checksum (dedup)
    const [existing] = await db
      .select()
      .from(mediaFiles)
      .where(and(eq(mediaFiles.orgId, request.orgId), eq(mediaFiles.checksumSha256, checksum)))
      .limit(1);

    if (existing) {
      logger.debug('Media dedup hit', { checksum, existingId: existing.id });
      return {
        fileId: existing.id,
        objectKey: existing.objectKey,
        url: await this.getPresignedUrl({ objectKey: existing.objectKey }),
        thumbnailUrl: existing.thumbnailKey
          ? await this.getPresignedUrl({ objectKey: existing.thumbnailKey })
          : null,
        sizeBytes: existing.sizeBytes,
        checksumSha256: checksum,
      };
    }

    // Generate unique object key
    const ext = this.getExtension(request.mimeType, request.filename);
    const objectKey = `${request.orgId}/${request.sessionId}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;

    // Upload to MinIO
    await minio.putObject(this.bucket, objectKey, request.buffer, request.buffer.length, {
      'Content-Type': request.mimeType,
      'x-amz-meta-original-filename': encodeURIComponent(request.filename),
      'x-amz-meta-org-id': request.orgId,
    });

    // Generate thumbnail for images
    let thumbnailKey: string | null = null;
    if (request.mimeType.startsWith('image/') && !request.mimeType.includes('webp')) {
      try {
        thumbnailKey = await this.generateThumbnail(objectKey, request.buffer);
      } catch (err) {
        logger.warn('Thumbnail generation failed', { objectKey, error: (err as Error).message });
      }
    }

    // Store metadata in DB
    const [record] = await db
      .insert(mediaFiles)
      .values({
        orgId: request.orgId,
        messageId: request.messageId ?? null,
        bucket: this.bucket,
        objectKey,
        originalFilename: request.filename,
        mimeType: request.mimeType,
        sizeBytes: request.buffer.length,
        checksumSha256: checksum,
        thumbnailKey,
      })
      .returning();

    logger.info('Media uploaded', {
      fileId: record.id,
      objectKey,
      sizeBytes: request.buffer.length,
      mimeType: request.mimeType,
    });

    return {
      fileId: record.id,
      objectKey,
      url: await this.getPresignedUrl({ objectKey }),
      thumbnailUrl: thumbnailKey
        ? await this.getPresignedUrl({ objectKey: thumbnailKey })
        : null,
      sizeBytes: request.buffer.length,
      checksumSha256: checksum,
    };
  }

  /**
   * Generate a thumbnail for an image.
   * Returns the MinIO object key of the thumbnail.
   */
  private async generateThumbnail(originalKey: string, buffer: Buffer): Promise<string> {
    const thumbnailBuffer = await sharp(buffer)
      .resize(200, 200, { fit: 'cover' })
      .jpeg({ quality: 70 })
      .toBuffer();

    const thumbnailKey = originalKey.replace(/(\.[^.]+)$/, '_thumb.jpg');
    await minio.putObject(this.bucket, thumbnailKey, thumbnailBuffer, thumbnailBuffer.length, {
      'Content-Type': 'image/jpeg',
    });

    return thumbnailKey;
  }

  /**
   * Download a file from MinIO as a readable stream.
   */
  async download(objectKey: string): Promise<Readable> {
    return minio.getObject(this.bucket, objectKey);
  }

  /**
   * Download a partial file from MinIO (range support).
   */
  async downloadPartial(objectKey: string, offset: number, length: number): Promise<Readable> {
    return minio.getPartialObject(this.bucket, objectKey, offset, length);
  }

  /**
   * Generate a presigned URL for temporary access to a file.
   */
  async getPresignedUrl(options: PresignedUrlOptions): Promise<string> {
    const expiresIn = options.expiresIn ?? 3600; // 1 hour default
    return minio.presignedGetObject(this.bucket, options.objectKey, expiresIn);
  }

  /**
   * Get file metadata from DB.
   */
  async getFileById(fileId: string): Promise<MediaFile | null> {
    const [result] = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.id, fileId))
      .limit(1);
    return (result as MediaFile) ?? null;
  }

  /**
   * Get file stat from MinIO (size, last modified, etc.).
   */
  async getObjectStat(objectKey: string): Promise<{ size: number; lastModified: Date; contentType: string }> {
    const stat = await minio.statObject(this.bucket, objectKey);
    return {
      size: stat.size,
      lastModified: stat.lastModified,
      contentType: stat.metaData?.['content-type'] ?? 'application/octet-stream',
    };
  }

  /**
   * Delete a file from MinIO and DB.
   */
  async deleteFile(fileId: string): Promise<void> {
    const file = await this.getFileById(fileId);
    if (!file) return;

    await minio.removeObject(this.bucket, file.objectKey);
    if (file.thumbnailKey) {
      await minio.removeObject(this.bucket, file.thumbnailKey).catch(() => {});
    }

    await db.delete(mediaFiles).where(eq(mediaFiles.id, fileId));
    logger.info('Media deleted', { fileId, objectKey: file.objectKey });
  }

  /**
   * Test MinIO connectivity — used by health checks.
   */
  async testConnection(): Promise<boolean> {
    try {
      await minio.bucketExists(this.bucket);
      return true;
    } catch {
      return false;
    }
  }

  private getExtension(mimeType: string, filename: string): string {
    const fromFilename = filename.includes('.') ? `.${filename.split('.').pop()}` : '';
    if (fromFilename) return fromFilename;

    const mimeMap: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'video/mp4': '.mp4',
      'audio/ogg': '.ogg',
      'audio/mpeg': '.mp3',
      'application/pdf': '.pdf',
    };
    return mimeMap[mimeType] ?? '';
  }
}

export const mediaService = new MediaService();
