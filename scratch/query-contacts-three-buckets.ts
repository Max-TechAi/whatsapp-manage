import { db } from '../src/config/database.js';
import { contacts, sessions } from '../src/db/schema.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Querying sessions metadata...');
  const activeSessions = await db
    .select({
      id: sessions.id,
      sessionName: sessions.sessionName,
      phoneNumber: sessions.phoneNumber,
      status: sessions.status,
      metadata: sessions.metadata,
    })
    .from(sessions);

  console.log('\n--- ACTIVE SESSIONS ---');
  console.table(activeSessions);

  console.log('\nQuerying contacts three-bucket classification...');

  // Group contacts:
  // Bucket A: null or empty
  // Bucket B: contains the '∙' character OR matches only digits, spaces, and plus signs (phone number format)
  // Bucket C: actual names (letters, symbols, other names)
  const stats = await db
    .select({
      total: sql<number>`count(*)`,
      bucketA_nullOrEmpty: sql<number>`count(case when display_name is null or trim(display_name) = '' then 1 end)`,
      bucketB_maskedPhoneOrNumber: sql<number>`count(case when display_name is not null and (display_name like '%∙%' or display_name ~ '^[+\\d\\s]+$') then 1 end)`,
      bucketC_realName: sql<number>`count(case when display_name is not null and display_name not like '%∙%' and not (display_name ~ '^[+\\d\\s]+$') and trim(display_name) <> '' then 1 end)`,
    })
    .from(contacts);

  console.log('\n--- THREE-BUCKET CLASSIFICATION ---');
  console.table(stats);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
