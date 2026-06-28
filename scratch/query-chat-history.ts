import { db } from '../src/config/database.js';
import { chats, messages } from '../src/db/schema.js';
import { eq, like, desc, asc, sql } from 'drizzle-orm';

async function main() {
  console.log('Searching for chat containing "Abd Alrhman Abdeen"...');

  const matchedChats = await db
    .select({
      id: chats.id,
      waChatId: chats.waChatId,
      name: chats.name,
      lastMessageAt: chats.lastMessageAt,
    })
    .from(chats)
    .where(like(chats.name, '%Abd Alrhman Abdeen%'))
    .limit(5);

  if (matchedChats.length === 0) {
    console.log('No chat found matching "Abd Alrhman Abdeen". Querying all private chats with history...');
    const sampleChats = await db
      .select({
        id: chats.id,
        waChatId: chats.waChatId,
        name: chats.name,
        lastMessageAt: chats.lastMessageAt,
      })
      .from(chats)
      .where(eq(chats.chatType, 'private'))
      .orderBy(desc(chats.lastMessageAt))
      .limit(10);
    console.table(sampleChats);
    process.exit(0);
  }

  console.log('\n--- MATCHED CHATS ---');
  console.table(matchedChats);

  for (const chat of matchedChats) {
    console.log(`\nAnalyzing chat: ${chat.name} (JID: ${chat.waChatId}, DB ID: ${chat.id})`);

    const [countResult] = await db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(messages)
      .where(eq(messages.chatId, chat.id));

    const [oldest] = await db
      .select({
        waMessageId: messages.waMessageId,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.chatId, chat.id))
      .orderBy(asc(messages.createdAt))
      .limit(1);

    const [newest] = await db
      .select({
        waMessageId: messages.waMessageId,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.chatId, chat.id))
      .orderBy(desc(messages.createdAt))
      .limit(1);

    console.log(`- Total Messages Stored Locally: ${countResult?.count ?? 0}`);
    if (oldest) {
      console.log(`- Oldest Message Timestamp: ${oldest.createdAt.toISOString()} ("${oldest.content ?? '[No text]'}")`);
    }
    if (newest) {
      console.log(`- Newest Message Timestamp: ${newest.createdAt.toISOString()} ("${newest.content ?? '[No text]'}")`);
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
