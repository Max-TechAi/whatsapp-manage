import pg from 'pg';
import Redis from 'ioredis';

const pgConnectionString = 'postgresql://whatsapp:secret_password@localhost:5432/whatsapp_db';

async function diagnose() {
  console.log('=== Starting Diagnostics ===');
  const client = new pg.Client({ connectionString: pgConnectionString });
  try {
    await client.connect();
    console.log('✅ Connected to PostgreSQL');
  } catch (err) {
    console.error('❌ Failed to connect to PostgreSQL:', err.message);
    process.exit(1);
  }

  // 1. Get all chats
  const chatRes = await client.query(`
    SELECT id, wa_chat_id, name, unread_count, last_message_preview, last_message_at, created_at, updated_at
    FROM chats
    ORDER BY name, wa_chat_id
  `);
  console.log(`\n--- Chats (${chatRes.rows.length} found) ---`);
  chatRes.rows.forEach(r => {
    console.log(`ID: ${r.id} | JID: ${r.wa_chat_id} | Name: ${r.name} | LastMsgAt: ${r.last_message_at} | Preview: ${r.last_message_preview}`);
  });

  // 2. Find duplicate chats (chats with same name or matching similar patterns)
  const dupChats = await client.query(`
    SELECT name, COUNT(*) as cnt
    FROM chats
    WHERE name IS NOT NULL AND name != ''
    GROUP BY name
    HAVING COUNT(*) > 1
  `);
  console.log('\n--- Duplicate Chat Names in DB ---');
  console.log(dupChats.rows);

  // 3. For any duplicate names, show details
  for (const dup of dupChats.rows) {
    const details = await client.query(`
      SELECT id, wa_chat_id, name, last_message_preview, last_message_at,
             (SELECT COUNT(*) FROM messages WHERE chat_id = chats.id) as msg_count
      FROM chats
      WHERE name = $1
    `, [dup.name]);
    console.log(`\nDetails for duplicate name "${dup.name}":`);
    details.rows.forEach(r => {
      console.log(`  JID: ${r.wa_chat_id} | ID: ${r.id} | MsgCount: ${r.msg_count} | Preview: ${r.last_message_preview}`);
    });
  }

  // 4. Check Redis LID mappings
  console.log('\n--- Redis LID Mappings ---');
  const redis = new Redis({
    host: 'localhost',
    port: 6379,
    password: 'redis_secret_password'
  });

  try {
    const keys = await redis.keys('lid:mapping:*');
    console.log(`Found ${keys.length} session mapping keys:`, keys);
    for (const key of keys) {
      const mappings = await redis.hgetall(key);
      console.log(`Mappings for key ${key}:`);
      console.log(JSON.stringify(mappings, null, 2));
    }
  } catch (err) {
    console.error('❌ Redis error:', err.message);
  }

  await client.end();
  await redis.quit();
  console.log('=== Diagnostics Done ===');
}

diagnose().catch(console.error);
