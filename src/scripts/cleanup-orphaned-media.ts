/**
 * Report and optionally remove orphaned media_files rows + MinIO blobs.
 *
 * Orphans are detected when:
 * 1. message_id IS NULL (typical after session delete before this fix)
 * 2. object_key embeds a session UUID that no longer exists in sessions
 *
 * Dry run (default):
 *   npm run db:cleanup-orphaned-media
 *
 * Apply deletions:
 *   npm run db:cleanup-orphaned-media -- --confirm
 */

import { sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { mediaService } from '../modules/media/media.service.js';
import { logger } from '../observability/logger.js';

const isConfirm = process.argv.includes('--confirm');

type OrphanRow = {
  id: string;
  object_key: string;
  thumbnail_key: string | null;
  size_bytes: number;
  message_id: string | null;
  reason: string;
};

async function findOrphanedMedia(): Promise<OrphanRow[]> {
  const result = await db.execute<OrphanRow>(sql`
    SELECT
      mf.id,
      mf.object_key,
      mf.thumbnail_key,
      mf.size_bytes,
      mf.message_id,
      CASE
        WHEN mf.message_id IS NULL THEN 'message_id_is_null'
        ELSE 'session_missing_in_object_key'
      END AS reason
    FROM media_files mf
    WHERE mf.message_id IS NULL
       OR (
         mf.object_key ~ '^[^/]+/[0-9a-fA-F-]{36}/'
         AND NOT EXISTS (
           SELECT 1
           FROM sessions s
           WHERE s.id::text = split_part(mf.object_key, '/', 2)
         )
       )
    ORDER BY mf.created_at ASC
  `);

  return result.rows as OrphanRow[];
}

async function main() {
  console.log('==================================================');
  console.log('🗑️  ORPHANED MEDIA FILES CLEANUP TOOL');
  console.log(`Mode: ${isConfirm ? '🔴 LIVE RUN (Deleting files)' : '🟢 DRY RUN (Read-only scan)'}`);
  console.log('==================================================\n');

  const orphans = await findOrphanedMedia();

  if (orphans.length === 0) {
    console.log('✅ No orphaned media_files rows found.');
    return;
  }

  const totalBytes = orphans.reduce((sum, row) => sum + (row.size_bytes || 0), 0);
  const byReason = orphans.reduce<Record<string, number>>((acc, row) => {
    acc[row.reason] = (acc[row.reason] || 0) + 1;
    return acc;
  }, {});

  console.log(`Found ${orphans.length} orphaned media file(s)`);
  console.log(`Estimated DB-reported size: ${formatBytes(totalBytes)}`);
  console.log('Breakdown by reason:');
  for (const [reason, count] of Object.entries(byReason)) {
    console.log(`  - ${reason}: ${count}`);
  }
  console.log('\nSample rows (up to 20):');
  for (const row of orphans.slice(0, 20)) {
    console.log(
      `  - ${row.id} | ${formatBytes(row.size_bytes)} | ${row.reason} | ${row.object_key}`,
    );
  }
  if (orphans.length > 20) {
    console.log(`  ... and ${orphans.length - 20} more`);
  }

  if (!isConfirm) {
    console.log('\n💡 To delete these orphans (MinIO + DB), run:');
    console.log('   npm run db:cleanup-orphaned-media -- --confirm');
    console.log('   npm run db:cleanup-orphaned-media:prod -- --confirm');
    return;
  }

  let deleted = 0;
  let failed = 0;

  for (const row of orphans) {
    try {
      await mediaService.deleteFile(row.id);
      deleted++;
    } catch (err) {
      failed++;
      logger.warn('Failed to delete orphaned media file', {
        fileId: row.id,
        objectKey: row.object_key,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      console.warn(`  ⚠️ Failed: ${row.id} (${row.object_key})`);
    }
  }

  console.log('\n==================================================');
  console.log('📊 CLEANUP SUMMARY');
  console.log(`  - Deleted: ${deleted}`);
  console.log(`  - Failed:  ${failed}`);
  console.log('==================================================');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

main()
  .catch((err) => {
    console.error('❌ Orphaned media cleanup failed:', err);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
