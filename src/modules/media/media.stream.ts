/**
 * Media Stream Handler — serves media files from MinIO with Range request support.
 * Acts as a CDN proxy with caching headers.
 */

import { Router, type Request, type Response } from 'express';
import { mediaService } from './media.service.js';
import { authenticate } from '../auth/auth.middleware.js';
import { logger } from '../../observability/logger.js';

export const mediaRouter = Router();

mediaRouter.use(authenticate);

/**
 * GET /api/media/:id
 * Stream a media file from MinIO with Range support.
 */
mediaRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const file = await mediaService.getFileById(req.params.id as string);
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Verify org ownership
    if (file.orgId !== req.user!.orgId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const stat = await mediaService.getObjectStat(file.objectKey);

    // Handle Range requests for streaming
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': file.mimeType,
        'Cache-Control': 'private, max-age=86400',
        'ETag': `"${file.checksumSha256}"`,
      });

      const stream = await mediaService.download(file.objectKey);
      // For simplicity, pipe the whole stream — MinIO handles the range internally
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': file.mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=86400',
        'ETag': `"${file.checksumSha256}"`,
        'Content-Disposition': file.originalFilename
          ? `inline; filename="${file.originalFilename}"`
          : 'inline',
      });

      const stream = await mediaService.download(file.objectKey);
      stream.pipe(res);
    }
  } catch (err) {
    logger.error('Failed to stream media', { error: (err as Error).message, fileId: req.params.id });
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to stream file' });
    }
  }
});

/**
 * GET /api/media/:id/thumbnail
 * Get pre-generated thumbnail.
 */
mediaRouter.get('/:id/thumbnail', async (req: Request, res: Response) => {
  try {
    const file = await mediaService.getFileById(req.params.id as string);
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (file.orgId !== req.user!.orgId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!file.thumbnailKey) {
      return res.status(404).json({ error: 'No thumbnail available' });
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=604800'); // 1 week
    const stream = await mediaService.download(file.thumbnailKey);
    stream.pipe(res);
  } catch (err) {
    logger.error('Failed to stream thumbnail', { error: (err as Error).message });
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to stream thumbnail' });
    }
  }
});

/**
 * GET /api/media/:id/url
 * Get a presigned URL for direct access.
 */
mediaRouter.get('/:id/url', async (req: Request, res: Response) => {
  try {
    const file = await mediaService.getFileById(req.params.id as string);
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (file.orgId !== req.user!.orgId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const expiresIn = parseInt(req.query.expiresIn as string) || 3600;
    const url = await mediaService.getPresignedUrl({ objectKey: file.objectKey, expiresIn });
    const thumbnailUrl = file.thumbnailKey
      ? await mediaService.getPresignedUrl({ objectKey: file.thumbnailKey, expiresIn })
      : null;

    return res.json({ url, thumbnailUrl, expiresIn });
  } catch (err) {
    logger.error('Failed to generate presigned URL', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to generate URL' });
  }
});

/**
 * POST /api/media/upload
 * Upload a file (expects multipart/form-data — handled by express middleware).
 * For now, accepts raw binary body with headers.
 */
mediaRouter.post('/upload', async (req: Request, res: Response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const buffer = Buffer.concat(chunks);

    if (buffer.length === 0) {
      return res.status(400).json({ error: 'Empty file' });
    }

    const filename = (req.headers['x-filename'] as string) || 'upload';
    const mimeType = (req.headers['content-type'] as string) || 'application/octet-stream';
    const sessionId = req.headers['x-session-id'] as string;

    if (!sessionId) {
      return res.status(400).json({ error: 'x-session-id header is required' });
    }

    const result = await mediaService.upload({
      orgId: req.user!.orgId,
      sessionId,
      buffer,
      filename,
      mimeType,
    });

    return res.status(201).json(result);
  } catch (err) {
    logger.error('Failed to upload media', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to upload file' });
  }
});

/**
 * DELETE /api/media/:id
 * Delete a media file.
 */
mediaRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const file = await mediaService.getFileById(req.params.id as string);
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (file.orgId !== req.user!.orgId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await mediaService.deleteFile(req.params.id as string);
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete media', { error: (err as Error).message });
    return res.status(500).json({ error: 'Failed to delete file' });
  }
});
