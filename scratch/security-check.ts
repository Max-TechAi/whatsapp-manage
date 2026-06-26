import { db } from '../src/config/database.js';
import { organizations, users, sessions, chats } from '../src/db/schema.js';
import { generateTokens } from '../src/modules/auth/auth.service.js';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'ws';

async function runTests() {
  console.log('=== STARTING MULTI-TENANT SECURITY INTEGRATION TEST ===');

  // 1. Create two test organizations
  const orgAId = uuidv4();
  const orgBId = uuidv4();
  
  await db.insert(organizations).values([
    { id: orgAId, name: 'Org A Security Test', slug: `org-a-${Date.now()}`, plan: 'free' },
    { id: orgBId, name: 'Org B Security Test', slug: `org-b-${Date.now()}`, plan: 'free' }
  ]);

  // 2. Create users under both organizations
  const userAId = uuidv4(); // Org A Admin
  const userBId = uuidv4(); // Org B Admin
  const userBAgentId = uuidv4(); // Org B Agent (hasAllSessionsAccess = true)
  const userBAgentRestrictedId = uuidv4(); // Org B Agent (hasAllSessionsAccess = false)

  await db.insert(users).values([
    {
      id: userAId,
      orgId: orgAId,
      email: `admin-a-${Date.now()}@test.com`,
      displayName: 'Admin A',
      passwordHash: 'dummy',
      role: 'admin',
      hasAllSessionsAccess: true
    },
    {
      id: userBId,
      orgId: orgBId,
      email: `admin-b-${Date.now()}@test.com`,
      displayName: 'Admin B',
      passwordHash: 'dummy',
      role: 'admin',
      hasAllSessionsAccess: true
    },
    {
      id: userBAgentId,
      orgId: orgBId,
      email: `agent-b-all-${Date.now()}@test.com`,
      displayName: 'Agent B All',
      passwordHash: 'dummy',
      role: 'agent',
      hasAllSessionsAccess: true
    },
    {
      id: userBAgentRestrictedId,
      orgId: orgBId,
      email: `agent-b-restricted-${Date.now()}@test.com`,
      displayName: 'Agent B Restricted',
      passwordHash: 'dummy',
      role: 'agent',
      hasAllSessionsAccess: false
    }
  ]);

  // 3. Create a session in each org
  const sessionAId = uuidv4();
  const sessionBId = uuidv4();

  await db.insert(sessions).values([
    {
      id: sessionAId,
      orgId: orgAId,
      userId: userAId,
      sessionName: 'Session A',
      status: 'initializing'
    },
    {
      id: sessionBId,
      orgId: orgBId,
      userId: userBId,
      sessionName: 'Session B',
      status: 'initializing'
    }
  ]);

  // 4. Create a chat in each session
  const chatAId = uuidv4();
  const chatBId = uuidv4();

  await db.insert(chats).values([
    {
      id: chatAId,
      orgId: orgAId,
      sessionId: sessionAId,
      waChatId: '12345@s.whatsapp.net',
      chatType: 'private'
    },
    {
      id: chatBId,
      orgId: orgBId,
      sessionId: sessionBId,
      waChatId: '67890@s.whatsapp.net',
      chatType: 'private'
    }
  ]);

  console.log('Seeded database with mock orgs, users, sessions, and chats.');

  // Generate tokens
  const tokenA = generateTokens({
    userId: userAId,
    orgId: orgAId,
    email: 'admin-a@test.com',
    role: 'admin',
    hasAllSessionsAccess: true,
    emailVerified: true
  }).accessToken;

  const tokenB = generateTokens({
    userId: userBId,
    orgId: orgBId,
    email: 'admin-b@test.com',
    role: 'admin',
    hasAllSessionsAccess: true,
    emailVerified: true
  }).accessToken;

  const tokenBAgentAll = generateTokens({
    userId: userBAgentId,
    orgId: orgBId,
    email: 'agent-b-all@test.com',
    role: 'agent',
    hasAllSessionsAccess: true,
    emailVerified: true
  }).accessToken;

  const tokenBAgentRestricted = generateTokens({
    userId: userBAgentRestrictedId,
    orgId: orgBId,
    email: 'agent-b-restricted@test.com',
    role: 'agent',
    hasAllSessionsAccess: false,
    emailVerified: true
  }).accessToken;

  // Let's import the server components and start them
  process.env.PORT = '4000';
  process.env.WS_PORT = '4001';

  // Dynamic import of index/wsServer to run the server
  const { wsServer } = await import('../src/websocket/ws-server.js');
  
  // Let's override starting workers to avoid starting real whatsapp and queue logic
  // We can just start the wsServer and http server
  await wsServer.start();
  
  // Wait a moment for server to listen
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log('Server started on PORT 4000 and WS_PORT 4001.');

  let success = true;

  // -------------------------------------------------------------
  // Test 1: HTTP API isolation checks
  // -------------------------------------------------------------
  console.log('\n--- Running Test 1: HTTP API Cross-Tenant Isolation ---');
  
  // Org B Admin fetching Org A's chat list
  try {
    const res = await fetch(`http://localhost:4000/api/chats?sessionId=${sessionAId}`, {
      headers: { 'Authorization': `Bearer ${tokenB}` }
    });
    console.log(`Org B Admin GET Org A chats status: ${res.status} (Expected: 403 or 404 or 401 depending on route protection)`);
    const body = await res.json();
    console.log('Response body:', body);
    if (res.status !== 403 && res.status !== 404 && res.status !== 401) {
      console.error('❌ SECURITY FAILURE: Org B Admin could access Org A chat list HTTP endpoint!');
      success = false;
    } else {
      console.log('✅ Success: Org B Admin HTTP access to Org A chats is blocked.');
    }
  } catch (err) {
    console.log('Error fetching:', err);
    success = false;
  }

  // Org B Admin fetching Org A's chat detail directly
  try {
    const res = await fetch(`http://localhost:4000/api/chats/${chatAId}`, {
      headers: { 'Authorization': `Bearer ${tokenB}` }
    });
    console.log(`Org B Admin GET Org A chat detail status: ${res.status} (Expected: 404)`);
    const body = await res.json();
    console.log('Response body:', body);
    if (res.status !== 404) {
      console.error('❌ SECURITY FAILURE: Org B Admin could access Org A chat detail HTTP endpoint!');
      success = false;
    } else {
      console.log('✅ Success: Org B Admin HTTP access to Org A chat details is blocked.');
    }
  } catch (err) {
    console.log('Error fetching:', err);
    success = false;
  }

  // -------------------------------------------------------------
  // Test 2: WebSocket Subscription Isolation
  // -------------------------------------------------------------
  console.log('\n--- Running Test 2: WebSocket Cross-Tenant Subscription Isolation ---');

  const wsB = new WebSocket(`ws://localhost:4001/ws?token=${tokenB}`);
  
  let wsBSubscribed = false;
  let subConfirmation: any = null;

  await new Promise<void>((resolve) => {
    wsB.on('open', () => {
      console.log('WebSocket connection B established.');
    });

    wsB.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log('WS B Received:', msg);
      if (msg.type === 'connected') {
        // Attempt to subscribe to Org A's session channel (sessionAId) and Org B's session channel (sessionBId)
        wsB.send(JSON.stringify({
          type: 'subscribe',
          channels: [`session:${sessionAId}`, `session:${sessionBId}`, `chat:${chatAId}`, `chat:${chatBId}`]
        }));
      } else if (msg.type === 'subscribed') {
        wsBSubscribed = true;
        subConfirmation = msg.channels;
        wsB.close();
        resolve();
      }
    });

    wsB.on('error', (err) => {
      console.error('WS B Error:', err);
      wsB.close();
      resolve();
    });
  });

  console.log('Subscription confirmation channels:', subConfirmation);
  
  if (!subConfirmation) {
    console.error('❌ FAILURE: Did not receive subscription confirmation.');
    success = false;
  } else {
    const hasSessionA = subConfirmation.includes(`session:${sessionAId}`);
    const hasChatA = subConfirmation.includes(`chat:${chatAId}`);
    const hasSessionB = subConfirmation.includes(`session:${sessionBId}`);
    const hasChatB = subConfirmation.includes(`chat:${chatBId}`);

    console.log(`Org B subscribed to Org A session: ${hasSessionA} (Expected: false)`);
    console.log(`Org B subscribed to Org A chat: ${hasChatA} (Expected: false)`);
    console.log(`Org B subscribed to Org B session: ${hasSessionB} (Expected: true)`);
    console.log(`Org B subscribed to Org B chat: ${hasChatB} (Expected: true)`);

    if (hasSessionA || hasChatA) {
      console.error('❌ SECURITY FAILURE: Org B was able to subscribe to Org A channels!');
      success = false;
    } else if (!hasSessionB || !hasChatB) {
      console.error('❌ FUNCTIONAL FAILURE: Org B was NOT able to subscribe to its own channels!');
      success = false;
    } else {
      console.log('✅ SECURITY SUCCESS: Cross-tenant WebSocket subscriptions are blocked!');
    }
  }

  // -------------------------------------------------------------
  // Clean up
  // -------------------------------------------------------------
  console.log('\nCleaning up seeded test database records...');
  try {
    await db.delete(chats).where(and(eq(chats.orgId, orgAId), eq(chats.id, chatAId)));
    await db.delete(chats).where(and(eq(chats.orgId, orgBId), eq(chats.id, chatBId)));
    await db.delete(sessions).where(and(eq(sessions.orgId, orgAId), eq(sessions.id, sessionAId)));
    await db.delete(sessions).where(and(eq(sessions.orgId, orgBId), eq(sessions.id, sessionBId)));
    await db.delete(users).where(eq(users.orgId, orgAId));
    await db.delete(users).where(eq(users.orgId, orgBId));
    await db.delete(organizations).where(eq(organizations.id, orgAId));
    await db.delete(organizations).where(eq(organizations.id, orgBId));
    console.log('Cleanup complete.');
  } catch (err) {
    console.error('Error during cleanup:', err);
  }

  // Close the server and databases
  console.log('Shutting down server...');
  try {
    await wsServer.close();
  } catch (err) {
    console.error('Error closing wsServer:', err);
  }

  const { closePool } = await import('../src/config/database.js');
  const { closeRedis } = await import('../src/config/redis.js');
  await closePool();
  await closeRedis();

  if (success) {
    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! ✅');
    process.exit(0);
  } else {
    console.error('\n❌ SOME TESTS FAILED! ❌');
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test run failed with error:', err);
  process.exit(1);
});
