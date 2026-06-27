import { db } from '../src/config/database.js';
import { contacts } from '../src/db/schema.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Querying contacts table state...');

  const sample = await db
    .select({
      id: contacts.id,
      waId: contacts.waId,
      pushName: contacts.pushName,
      displayName: contacts.displayName,
    })
    .from(contacts)
    .limit(20);

  console.log('\n--- SAMPLE CONTACTS (First 20) ---');
  console.table(sample);

  const stats = await db
    .select({
      total: sql<number>`count(*)`,
      hasPushName: sql<number>`count(push_name)`,
      hasDisplayName: sql<number>`count(display_name)`,
      hasBoth: sql<number>`count(case when push_name is not null and display_name is not null then 1 end)`,
    })
    .from(contacts);

  console.log('\n--- CONTACT TABLE STATISTICS ---');
  console.table(stats);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
