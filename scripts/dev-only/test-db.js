/**
 * Dev-only: try common local Postgres connection strings until one works.
 * Usage: node scripts/dev-only/test-db.js
 */
import pg from 'pg';

const connections = [
  'postgresql://whatsapp:secret_password@localhost:5432/whatsapp_db',
  'postgresql://postgres:secret_password@localhost:5432/whatsapp_db',
  'postgresql://postgres:postgres@localhost:5432/whatsapp_db',
  'postgresql://whatsapp:whatsapp@localhost:5432/whatsapp_db',
  'postgresql://postgres@localhost:5432/whatsapp_db',
  'postgresql://postgres:admin@localhost:5432/whatsapp_db',
];

async function run() {
  for (const conn of connections) {
    try {
      const client = new pg.Client({ connectionString: conn });
      await client.connect();
      console.log(`Success with: ${conn}`);
      const res = await client.query('SELECT current_user, current_database()');
      console.log('Result:', res.rows[0]);
      await client.end();
      return;
    } catch (err) {
      console.log(`Failed with: ${conn} - ${err.message}`);
    }
  }
}

run().catch(console.error);
