/**
 * @fileoverview Standalone utility script to clean up legacy WhatsApp newsletter/channel
 * chats, messages, and contacts from the database.
 *
 * Usage: `npx tsx scripts/cleanup-newsletter-chats.ts`
 */

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is required');
  process.exit(1);
}

async function runCleanup(): Promise<void> {
  console.log('🧹 Starting WhatsApp newsletter/channel database cleanup...');

  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    max: 1, // Single connection is sufficient
  });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Delete contacts whose WhatsApp ID ends with '@newsletter'
    console.log('  → Deleting legacy newsletter contacts...');
    const contactResult = await client.query(
      "DELETE FROM contacts WHERE wa_id LIKE '%@newsletter';"
    );
    console.log(`  ✅ Deleted ${contactResult.rowCount} contact rows.`);

    // 2. Delete chats whose WhatsApp Chat ID ends with '@newsletter'
    // Message rows referencing these chats will be cascade deleted due to the foreign key constraint:
    // messages.chat_id REFERENCES chats(id) ON DELETE CASCADE
    console.log('  → Deleting legacy newsletter chats and messages (via cascade)...');
    const chatResult = await client.query(
      "DELETE FROM chats WHERE wa_chat_id LIKE '%@newsletter';"
    );
    console.log(`  ✅ Deleted ${chatResult.rowCount} chat rows (and their associated messages).`);

    await client.query('COMMIT');
    console.log('🎉 Cleanup completed successfully!');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Cleanup failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runCleanup();
