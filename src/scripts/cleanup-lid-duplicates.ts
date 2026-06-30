import pg from 'pg';


const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is required');
  process.exit(1);
}

const isConfirm = process.argv.includes('--confirm');
const forceUncertain = process.argv.includes('--force-uncertain');

async function main() {
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
  });

  const client = await pool.connect();

  try {
    console.log('==================================================');
    console.log('🔄 LID JID DUPLICATE CHAT CLEANUP & MERGE TOOL');
    console.log(`Mode: ${isConfirm ? '🔴 LIVE RUN (Applying changes)' : '🟢 DRY RUN (Read-only scan)'}`);
    console.log('==================================================\n');

    // Track processed LID chat IDs to avoid double merging
    const processedLidChatIds = new Set<string>();

    // ----------------------------------------------------------------
    // PASS 1: Detect via explicit contacts.metadata.lid mapping
    // ----------------------------------------------------------------
    console.log('📡 [PASS 1] Scanning via explicit contacts metadata mappings...');
    const mappingsRes = await client.query(`
      SELECT c.session_id, c.org_id, c.wa_id AS phone_jid, c.metadata->>'lid' AS lid_jid, c.display_name, c.push_name
      FROM contacts c
      WHERE c.wa_id LIKE '%@s.whatsapp.net' AND c.metadata->>'lid' LIKE '%@lid'
    `);

    const mappings = mappingsRes.rows;
    let pass1Merges = 0;
    let pass1Renames = 0;

    for (const r of mappings) {
      const name = r.display_name || r.push_name || 'Unknown';
      
      const lidChatRes = await client.query(`
        SELECT id, last_message_at, last_message_preview, unread_count
        FROM chats
        WHERE org_id = $1 AND session_id = $2 AND wa_chat_id = $3
      `, [r.org_id, r.session_id, r.lid_jid]);
      const lidChat = lidChatRes.rows[0];

      if (!lidChat) continue;

      const phoneChatRes = await client.query(`
        SELECT id, last_message_at, last_message_preview, unread_count
        FROM chats
        WHERE org_id = $1 AND session_id = $2 AND wa_chat_id = $3
      `, [r.org_id, r.session_id, r.phone_jid]);
      const phoneChat = phoneChatRes.rows[0];

      processedLidChatIds.add(lidChat.id);

      if (phoneChat) {
        pass1Merges++;
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

        console.log(`  [PASS 1 MERGE] Contact: "${name}"`);
        console.log(`    - LID Chat ID:   ${lidChat.id} (${r.lid_jid})`);
        console.log(`    - Phone Chat ID: ${phoneChat.id} (${r.phone_jid})`);
        console.log(`    - Message Stats: ${totalLidMsgs} total LID messages (${conflictMsgs} duplicates will be deleted, ${uniqueLidMsgs} unique messages will be moved)`);
        console.log(`    - Unread Badge:  LID unread count (${lidChat.unread_count}) -> Phone unread count (${phoneChat.unread_count})`);

        if (isConfirm) {
          await mergeChats(client, r.org_id, lidChat, phoneChat, name);
        }
      } else {
        pass1Renames++;
        console.log(`  [PASS 1 RENAME] Contact: "${name}"`);
        console.log(`    - LID Chat ID: ${lidChat.id} (${r.lid_jid})`);
        console.log(`    - Action:      No Phone JID chat exists; renaming LID to Phone JID (${r.phone_jid}) in place`);

        if (isConfirm) {
          await renameChat(client, lidChat.id, r.phone_jid, name);
        }
      }
      console.log('  --------------------------------------------------');
    }
    console.log(`Pass 1 completed. Merged: ${pass1Merges}, Renamed: ${pass1Renames}\n`);


    // ----------------------------------------------------------------
    // PASS 2: Detect via chats table & resolved display names scan
    // ----------------------------------------------------------------
    console.log('🔍 [PASS 2] Scanning chats table for candidates via resolved display name matching...');
    
    // Fetch all active chats with their resolved names
    const allChatsRes = await client.query(`
      SELECT ch.id, ch.wa_chat_id, ch.session_id, ch.org_id, ch.unread_count, ch.last_message_at, ch.last_message_preview,
             COALESCE(con.display_name, con.push_name, ch.name) AS resolved_name
      FROM chats ch
      LEFT JOIN contacts con ON ch.session_id = con.session_id AND ch.wa_chat_id = con.wa_id
    `);

    const allChats = allChatsRes.rows;
    
    // Group chats by session_id
    const chatsBySession: Record<string, typeof allChats> = {};
    for (const chat of allChats) {
      if (!chatsBySession[chat.session_id]) {
        chatsBySession[chat.session_id] = [];
      }
      chatsBySession[chat.session_id].push(chat);
    }

    let pass2Merges = 0;
    let uncertainCount = 0;

    for (const [sessionId, sessionChats] of Object.entries(chatsBySession)) {
      const lidChats = sessionChats.filter(c => c.wa_chat_id.endsWith('@lid'));
      const phoneChats = sessionChats.filter(c => c.wa_chat_id.endsWith('@s.whatsapp.net'));

      for (const lidChat of lidChats) {
        // Skip if already processed in Pass 1
        if (processedLidChatIds.has(lidChat.id)) continue;

        const resolvedName = lidChat.resolved_name;
        if (!resolvedName || resolvedName === 'Unknown') continue;

        // Find Phone chats in the same session with the exact same display name
        const matchingPhoneChats = phoneChats.filter(c => c.resolved_name === resolvedName);

        for (const phoneChat of matchingPhoneChats) {
          // Check safety metrics
          const isLidInactive = (lidChat.unread_count || 0) === 0;
          const isNameConfident = resolvedName && resolvedName.trim().length > 0 && !resolvedName.startsWith('Unknown');
          
          const isHighConfidence = isLidInactive && isNameConfident;

          // Message counts
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

          if (isHighConfidence) {
            pass2Merges++;
            console.log(`  [PASS 2 HIGH-CONFIDENCE MERGE] Contact: "${resolvedName}" (Detected via chats table scan)`);
            console.log(`    - LID Chat ID:   ${lidChat.id} (${lidChat.wa_chat_id})`);
            console.log(`    - Phone Chat ID: ${phoneChat.id} (${phoneChat.wa_chat_id})`);
            console.log(`    - Message Stats: ${totalLidMsgs} total LID messages (${conflictMsgs} duplicates will be deleted, ${uniqueLidMsgs} unique messages will be moved)`);
            console.log(`    - Unread Badge:  LID unread count (${lidChat.unread_count}) -> Phone unread count (${phoneChat.unread_count})`);

            if (isConfirm) {
              await mergeChats(client, lidChat.org_id, lidChat, phoneChat, resolvedName);
              processedLidChatIds.add(lidChat.id);
            }
          } else {
            uncertainCount++;
            console.log(`  ⚠️ [PASS 2 UNCERTAIN MATCH - FOR REVIEW ONLY] Contact: "${resolvedName}"`);
            console.log(`    - Reason:        LID Chat has active unread badges or ambiguous name info`);
            console.log(`    - LID Chat:      ID ${lidChat.id} (${lidChat.wa_chat_id}) | Unread: ${lidChat.unread_count} | Last message: ${lidChat.last_message_at}`);
            console.log(`    - Phone Chat:    ID ${phoneChat.id} (${phoneChat.wa_chat_id}) | Unread: ${phoneChat.unread_count}`);
            
            if (isConfirm && forceUncertain) {
              console.log(`    ⚠️ FORCE CONFIRM option active: applying merge...`);
              await mergeChats(client, lidChat.org_id, lidChat, phoneChat, resolvedName);
              processedLidChatIds.add(lidChat.id);
            } else if (isConfirm) {
              console.log(`    Skipping merge for uncertain match. (Use --force-uncertain if you wish to merge this anyway)`);
            }
          }
          console.log('  --------------------------------------------------');
        }
      }
    }
    console.log(`Pass 2 completed. High-confidence merges: ${pass2Merges}, Uncertain matches flagged: ${uncertainCount}\n`);

    console.log('==================================================');
    console.log('📊 OVERALL SUMMARY:');
    console.log(`  - Pass 1 (Explicit Metadata) Merges: ${pass1Merges}`);
    console.log(`  - Pass 1 (Explicit Metadata) Renames: ${pass1Renames}`);
    console.log(`  - Pass 2 (Chats-Table Scan) Merges:  ${pass2Merges}`);
    console.log(`  - Uncertain Matches (Flagged):        ${uncertainCount}`);
    console.log(`  - Execution Mode:                    ${isConfirm ? '🔴 LIVE RUN (Applied)' : '🟢 DRY RUN (No changes made)'}`);
    console.log('==================================================');
    
    if (!isConfirm) {
      console.log('\n💡 To apply high-confidence merges, run the script with the --confirm flag:');
      console.log('   npm run db:cleanup-lid:prod -- --confirm');
      if (uncertainCount > 0) {
        console.log('\n💡 To force-merge the uncertain matches as well:');
        console.log('   npm run db:cleanup-lid:prod -- --confirm --force-uncertain');
      }
    }

  } catch (error) {
    console.error('❌ Cleanup failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// Helper to merge two chats database records
async function mergeChats(client: pg.PoolClient, orgId: string, lidChat: any, phoneChat: any, name: string) {
  await client.query('BEGIN');
  try {
    // Delete duplicate messages
    await client.query(`
      DELETE FROM messages 
      WHERE org_id = $1
        AND chat_id = $2
        AND wa_message_id IN (
          SELECT wa_message_id FROM messages WHERE org_id = $1 AND chat_id = $3
        )
    `, [orgId, lidChat.id, phoneChat.id]);

    // Move unique messages
    await client.query(`
      UPDATE messages 
      SET chat_id = $1, updated_at = NOW() 
      WHERE org_id = $2 AND chat_id = $3
    `, [phoneChat.id, orgId, lidChat.id]);

    // Merge counts and metadata
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

    // Delete the duplicate LID chat
    await client.query('DELETE FROM chats WHERE id = $1', [lidChat.id]);
    await client.query('COMMIT');
    console.log(`    ✅ Successfully merged "${name}" LID chat into Phone JID chat.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

// Helper to rename JID in place
async function renameChat(client: pg.PoolClient, chatId: string, phoneJid: string, name: string) {
  await client.query(`
    UPDATE chats 
    SET wa_chat_id = $1, updated_at = NOW() 
    WHERE id = $2
  `, [phoneJid, chatId]);
  console.log(`    ✅ Successfully renamed "${name}" LID JID to Phone JID.`);
}

main().catch(console.error);
