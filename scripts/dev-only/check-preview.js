/**
 * Dev-only: inspect recent chat previews in the database.
 * Usage: node --env-file=.env scripts/dev-only/check-preview.js
 */
import pg from 'pg';

async function run() {
  const connectionString = process.env.DATABASE_URL;
  console.log('Connecting to:', connectionString ? connectionString.replace(/:[^:@]+@/, ':***@') : 'undefined');
  const client = new pg.Client({ connectionString });
  await client.connect();
  const res = await client.query('SELECT name, last_message_preview, last_message_at FROM chats ORDER BY last_message_at DESC LIMIT 10');
  console.log(JSON.stringify(res.rows, null, 2));
  await client.end();
}

run().catch(console.error);
