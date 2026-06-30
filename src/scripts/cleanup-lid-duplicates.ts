import pg from 'pg';


const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is required');
  process.exit(1);
}

const isConfirm = process.argv.includes('--confirm');

async function main() {
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
  });

  const client = await pool.connect();

  try {
    console.log('🔍 Scanning database for LID-to-Phone JID mappings in contacts...');
    
    // Find all contact mappings
    const mappingsRes = await client.query(`
      SELECT c.session_id, c.org_id, c.wa_id AS phone_jid, c.metadata->>'lid' AS lid_jid, c.display_name, c.push_name
      FROM contacts c
      WHERE c.wa_id LIKE '%@s.whatsapp.net' AND c.metadata->>'lid' LIKE '%@lid'
    `);

    const mappings = mappingsRes.rows;
    if (mappings.length === 0) {
      console.log('✅ No LID-to-Phone mappings found in contact metadata. Nothing to merge.');
      return;
    }

    console.log(`Found ${mappings.length} contact mapping(s). Analyzing chats...\n`);

    let mergeCount = 0;
    let renameCount = 0;

    for (const r of mappings) {
      const name = r.display_name || r.push_name || 'Unknown';
      
      // Get the LID chat details
      const lidChatRes = await client.query(`
        SELECT id, last_message_at, last_message_preview, unread_count
        FROM chats
        WHERE org_id = $1 AND session_id = $2 AND wa_chat_id = $3
      `, [r.org_id, r.session_id, r.lid_jid]);
      const lidChat = lidChatRes.rows[0];

      // Get the Phone chat details
      const phoneChatRes = await client.query(`
        SELECT id, last_message_at, last_message_preview, unread_count
        FROM chats
        WHERE org_id = $1 AND session_id = $2 AND wa_chat_id = $3
      `, [r.org_id, r.session_id, r.phone_jid]);
      const phoneChat = phoneChatRes.rows[0];

      if (!lidChat) {
        // No LID chat exists, so nothing to merge or rename for this mapping
        continue;
      }

      if (phoneChat) {
        mergeCount++;
        // Get message counts for analysis
        const totalLidMsgsRes = await client.query('SELECT COUNT(*)::int as count FROM messages WHERE chat_id = $1', [lidChat.id]);
        const totalLidMsgs = totalLidMsgsRes.rows[0].count;

        const conflictMsgsRes = await client.query(`
          SELECT COUNT(*)::int as count 
          FROM messages 
          WHERE chat_id = $1 
            AND wa_message_id IN (SELECT wa_message_id FROM messages WHERE chat_id = $2)
        `, [lidChat.id, phoneChat.id]);
        const conflictMsgs = conflictMsgsRes.rows[0].count;

        const uniqueLidMsgs = totalLidMsgs - conflictMsgs;

        console.log(`[MERGE] Contact: "${name}"`);
        console.log(`  - LID Chat ID:   ${lidChat.id} (${r.lid_jid})`);
        console.log(`  - Phone Chat ID: ${phoneChat.id} (${r.phone_jid})`);
        console.log(`  - Message Stats: ${totalLidMsgs} total LID messages (${conflictMsgs} duplicates will be deleted, ${uniqueLidMsgs} unique messages will be moved)`);
        console.log(`  - Unread Badge:  LID unread count (${lidChat.unread_count}) will be added to Phone unread count (${phoneChat.unread_count})`);

        if (isConfirm) {
          console.log(`  → Merging database records...`);
          await client.query('BEGIN');
          try {
            // Delete messages from lidChat that have the same waMessageId in phoneChat to avoid unique constraint violations
            await client.query(`
              DELETE FROM messages 
              WHERE org_id = $1
                AND chat_id = $2
                AND wa_message_id IN (
                  SELECT wa_message_id FROM messages WHERE org_id = $1 AND chat_id = $3
                )
            `, [r.org_id, lidChat.id, phoneChat.id]);

            // Safely move remaining messages
            await client.query(`
              UPDATE messages 
              SET chat_id = $1, updated_at = NOW() 
              WHERE org_id = $2 AND chat_id = $3
            `, [phoneChat.id, r.org_id, lidChat.id]);

            // Merge unread count, lastMessageAt, lastMessagePreview
            const newUnreadCount = (phoneChat.unread_count || 0) + (lidChat.unread_count || 0);
            const newLastMessageAt =
              lidChat.last_message_at && (!phoneChat.last_message_at || lidChat.last_message_at > phoneChat.last_message_at)
                ? lidChat.last_message_at
                : phoneChat.last_message_at;
            const newLastMessagePreview =
              lidChat.last_message_at && (!phoneChat.last_message_at || lidChat.last_message_at > phoneChat.last_message_at)
                ? lidChat.last_message_preview
                : phoneChat.last_message_preview;

            await client.query(`
              UPDATE chats
              SET 
                unread_count = $1,
                last_message_at = $2,
                last_message_preview = $3,
                updated_at = NOW()
              WHERE id = $4
            `, [newUnreadCount, newLastMessageAt, newLastMessagePreview, phoneChat.id]);

            // Delete lidChat
            await client.query('DELETE FROM chats WHERE id = $1', [lidChat.id]);
            await client.query('COMMIT');
            console.log(`  ✅ Successfully merged "${name}" LID chat into Phone JID chat.`);
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        }
      } else {
        renameCount++;
        console.log(`[RENAME] Contact: "${name}"`);
        console.log(`  - LID Chat ID: ${lidChat.id} (${r.lid_jid})`);
        console.log(`  - Action:      No Phone JID chat exists; renaming LID JID to Phone JID (${r.phone_jid}) in place`);

        if (isConfirm) {
          console.log(`  → Renaming database record...`);
          await client.query(`
            UPDATE chats 
            SET wa_chat_id = $1, updated_at = NOW() 
            WHERE id = $2
          `, [r.phone_jid, lidChat.id]);
          console.log(`  ✅ Successfully renamed "${name}" LID chat to Phone JID.`);
        }
      }
      console.log('--------------------------------------------------');
    }

    console.log('\n📊 Summary:');
    console.log(`  - Chats to Merge:  ${mergeCount}`);
    console.log(`  - Chats to Rename: ${renameCount}`);
    console.log(`  - Mode:            ${isConfirm ? '🔴 LIVE RUN (Applied)' : '🟢 DRY RUN (No changes made)'}`);
    
    if (!isConfirm) {
      console.log('\n💡 To apply these changes, run the script with the --confirm flag:');
      console.log('   npx tsx --env-file=.env src/scripts/cleanup-lid-duplicates.ts --confirm');
    }

  } catch (error) {
    console.error('❌ Cleanup failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
