import { db } from '../src/config/database.js';
import { contacts } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

async function main() {
  console.log('Querying contact for JID: 905465952488@s.whatsapp.net...');

  const row = await db
    .select({
      id: contacts.id,
      waId: contacts.waId,
      pushName: contacts.pushName,
      displayName: contacts.displayName,
      avatarUrl: contacts.avatarUrl,
      updatedAt: contacts.updatedAt,
    })
    .from(contacts)
    .where(eq(contacts.waId, '905465952488@s.whatsapp.net'))
    .limit(1);

  console.log('\n--- CONTACT DATABASE ROW ---');
  console.table(row);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
