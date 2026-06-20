import pg from 'pg';
import Redis from 'ioredis';

const pgConnectionString = process.env.DATABASE_URL || 'postgresql://whatsapp:secret_password@postgres:5432/whatsapp_db';
const redisUrl = process.env.REDIS_URL || 'redis://:redis_secret_password@redis:6379';

async function runRepair() {
  console.log('🚀 Starting WhatsApp Chat Repair Script...');
  
  const client = new pg.Client({ connectionString: pgConnectionString });
  await client.connect();
  console.log('✅ Connected to PostgreSQL');

  const redis = new Redis(redisUrl);
  console.log('✅ Connected to Redis');

  try {
    // 1. Gather all session IDs
    const sessionsRes = await client.query('SELECT id, phone_number FROM sessions');
    console.log(`Found ${sessionsRes.rows.length} sessions in database.`);

    for (const session of sessionsRes.rows) {
      const sessionId = session.id;
      console.log(`\nProcessing session: ${sessionId} (${session.phone_number || 'No Phone'})`);

      // Get Redis LID mappings for this session
      const mappingKey = `lid:mapping:${sessionId}`;
      const mappings = await redis.hgetall(mappingKey);
      console.log(`Found ${Object.keys(mappings).length} LID mappings in Redis.`);

      // Get all chats for this session
      const chatsRes = await client.query(
        'SELECT id, wa_chat_id, name, unread_count, last_message_preview, last_message_at FROM chats WHERE session_id = $1',
        [sessionId]
      );
      const chats = chatsRes.rows;
      console.log(`Found ${chats.length} chats in database for this session.`);

      // Map chats by wa_chat_id
      const chatMap = new Map();
      chats.forEach(c => chatMap.set(c.wa_chat_id, c));

      // Map chats by name (to detect name-based duplicates where no Redis mapping exists yet)
      const nameGroups = {};
      chats.forEach(c => {
        if (c.name) {
          const lowerName = c.name.toLowerCase().trim();
          if (!nameGroups[lowerName]) nameGroups[lowerName] = [];
          nameGroups[lowerName].push(c);
        }
      });

      // ─── Phase 1: Repair using Redis mappings ───
      for (const [lid, phone] of Object.entries(mappings)) {
        const lidChat = chatMap.get(lid);
        const phoneChat = chatMap.get(phone);

        if (lidChat) {
          console.log(`Found LID Chat in DB: ${lid} (ID: ${lidChat.id}) -> Target Phone: ${phone}`);
          if (phoneChat) {
            console.log(`  Both chats exist! Merging ${lidChat.id} into ${phoneChat.id}...`);
            await mergeChats(client, sessionId, lidChat, phoneChat, lid, phone);
          } else {
            console.log(`  Only LID chat exists. Renaming JID to Phone JID...`);
            await renameChat(client, sessionId, lidChat, lid, phone);
          }
          // Refresh list locally
          chatMap.delete(lid);
          if (!phoneChat) {
            lidChat.wa_chat_id = phone;
            chatMap.set(phone, lidChat);
          }
        }
      }

      // ─── Phase 2: Repair using Name-based duplicates (safety check) ───
      for (const [name, group] of Object.entries(nameGroups)) {
        if (group.length > 1) {
          const lidChat = group.find(c => c.wa_chat_id.endsWith('@lid'));
          const phoneChat = group.find(c => c.wa_chat_id.endsWith('@s.whatsapp.net'));

          // Double check they haven't been deleted/merged in Phase 1
          if (lidChat && phoneChat) {
            // Verify if they still exist in DB
            const verifyLid = await client.query('SELECT id FROM chats WHERE id = $1', [lidChat.id]);
            const verifyPhone = await client.query('SELECT id FROM chats WHERE id = $1', [phoneChat.id]);

            if (verifyLid.rows.length > 0 && verifyPhone.rows.length > 0) {
              console.log(`Found duplicate chats by name "${lidChat.name}":`);
              console.log(`  LID Chat: ${lidChat.wa_chat_id} (ID: ${lidChat.id})`);
              console.log(`  Phone Chat: ${phoneChat.wa_chat_id} (ID: ${phoneChat.id})`);
              console.log(`  Merging name-matched chats...`);
              await mergeChats(client, sessionId, lidChat, phoneChat, lidChat.wa_chat_id, phoneChat.wa_chat_id);
            }
          }
        }
      }
    }

    console.log('\n🎉 Repair completed successfully!');

  } catch (err) {
    console.error('❌ Error running repair:', err);
  } finally {
    await client.end();
    await redis.quit();
  }
}

async function renameChat(client, sessionId, lidChat, lid, phone) {
  try {
    await client.query('BEGIN');

    // 1. Rename chat JID
    await client.query(
      'UPDATE chats SET wa_chat_id = $1, updated_at = NOW() WHERE id = $2',
      [phone, lidChat.id]
    );

    // 2. Rename contact JID
    await client.query(
      'UPDATE contacts SET wa_id = $1, phone_number = $2, updated_at = NOW() WHERE session_id = $3 AND wa_id = $4',
      [phone, phone.split('@')[0], sessionId, lid]
    );

    await client.query('COMMIT');
    console.log(`  Successfully renamed JID from ${lid} to ${phone}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`  Failed to rename JID:`, err.message);
  }
}

async function mergeChats(client, sessionId, lidChat, phoneChat, lid, phone) {
  try {
    await client.query('BEGIN');

    // 1. Merge Contacts
    const lidContactRes = await client.query(
      'SELECT id, push_name, display_name, avatar_url FROM contacts WHERE session_id = $1 AND wa_id = $2',
      [sessionId, lid]
    );
    const phoneContactRes = await client.query(
      'SELECT id, push_name, display_name, avatar_url FROM contacts WHERE session_id = $1 AND wa_id = $2',
      [sessionId, phone]
    );

    const lidContact = lidContactRes.rows[0];
    const phoneContact = phoneContactRes.rows[0];

    if (lidContact) {
      if (phoneContact) {
        // Merge metadata into phone contact
        const updates = [];
        const params = [];
        let index = 1;

        if (!phoneContact.push_name && lidContact.push_name) {
          updates.push(`push_name = $${index++}`);
          params.push(lidContact.push_name);
        }
        if (!phoneContact.display_name && lidContact.display_name) {
          updates.push(`display_name = $${index++}`);
          params.push(lidContact.display_name);
        }
        if (!phoneContact.avatar_url && lidContact.avatar_url) {
          updates.push(`avatar_url = $${index++}`);
          params.push(lidContact.avatar_url);
        }

        if (updates.length > 0) {
          params.push(phoneContact.id);
          await client.query(
            `UPDATE contacts SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${index}`,
            params
          );
        }

        // Delete lid contact
        await client.query('DELETE FROM contacts WHERE id = $1', [lidContact.id]);
      } else {
        // Rename contact
        await client.query(
          'UPDATE contacts SET wa_id = $1, phone_number = $2, updated_at = NOW() WHERE id = $3',
          [phone, phone.split('@')[0], lidContact.id]
        );
      }
    }

    // 2. Merge Messages
    // Delete duplicate message IDs in lidChat to prevent unique constraints violations
    await client.query(`
      DELETE FROM messages 
      WHERE chat_id = $1 
        AND wa_message_id IN (
          SELECT wa_message_id FROM messages WHERE chat_id = $2
        )
    `, [lidChat.id, phoneChat.id]);

    // Move remaining messages
    await client.query(
      'UPDATE messages SET chat_id = $1, updated_at = NOW() WHERE chat_id = $2',
      [phoneChat.id, lidChat.id]
    );

    // 3. Merge Chat Metadata
    const newUnreadCount = (phoneChat.unread_count || 0) + (lidChat.unread_count || 0);
    const newLastMessageAt =
      lidChat.last_message_at && (!phoneChat.last_message_at || lidChat.last_message_at > phoneChat.last_message_at)
        ? lidChat.last_message_at
        : phoneChat.last_message_at;
    const newLastMessagePreview =
      lidChat.last_message_at && (!phoneChat.last_message_at || lidChat.last_message_at > phoneChat.last_message_at)
        ? lidChat.last_message_preview
        : phoneChat.last_message_preview;

    await client.query(
      `UPDATE chats 
       SET unread_count = $1, last_message_at = $2, last_message_preview = $3, updated_at = NOW() 
       WHERE id = $4`,
      [newUnreadCount, newLastMessageAt, newLastMessagePreview, phoneChat.id]
    );

    // 4. Delete LID Chat
    await client.query('DELETE FROM chats WHERE id = $1', [lidChat.id]);

    await client.query('COMMIT');
    console.log(`  Successfully merged and deleted duplicate LID chat ${lid}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`  Failed to merge chats:`, err.message);
  }
}

runRepair().catch(console.error);
