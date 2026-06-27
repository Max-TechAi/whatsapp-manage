import axios from 'axios';
import jwt from 'jsonwebtoken';
import { redis } from '../src/config/redis.js';
import { getEnv } from '../src/config/env.js';
import { db } from '../src/config/database.js';
import { users } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const env = getEnv();
const API_URL = `http://localhost:${env.PORT || 3000}`;

async function main() {
  console.log('Using API URL:', API_URL);

  // Clear existing ratelimit keys in Redis
  const oldKeys = await redis.keys('ratelimit:*');
  if (oldKeys.length > 0) {
    await redis.del(...oldKeys);
  }

  // Find a real active user from the database to bypass the authentication database-check
  console.log('Searching database for an active user...');
  const [activeUser] = await db
    .select({
      id: users.id,
      email: users.email,
      orgId: users.orgId,
      role: users.role,
    })
    .from(users)
    .where(eq(users.isActive, true))
    .limit(1);

  if (!activeUser) {
    throw new Error('No active user found in the database. Please register/create a user first.');
  }
  console.log(`Found active user: ${activeUser.email} (ID: ${activeUser.id}, Org: ${activeUser.orgId})`);

  // Generate a valid token using the JWT_SECRET from .env and the active user details
  const secret = env.JWT_SECRET;
  const payload = {
    userId: activeUser.id,
    orgId: activeUser.orgId,
    email: activeUser.email,
    role: activeUser.role as 'admin' | 'agent',
  };
  const token = jwt.sign(payload, secret, { expiresIn: '1h' });

  console.log('\n--- TEST 1: User-Scoped Rate Limiter Verification ---');
  console.log('Sending authenticated request to /api/auth/me...');
  try {
    const res = await axios.get(`${API_URL}/api/auth/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      validateStatus: () => true, // Don't throw on error codes
    });

    console.log(`Response Status: ${res.status}`);
    
    // Inspect Redis to see what key was created
    const keys = await redis.keys('ratelimit:api:*');
    console.log('Ratelimit keys found in Redis:', keys);

    const userKeyPrefix = `ratelimit:api:${activeUser.orgId}:${activeUser.id}`;
    const userKeyExists = keys.some(k => k.includes(userKeyPrefix));
    const ipKeyExists = keys.some(k => !k.includes(activeUser.orgId) && k.includes('ratelimit:api:'));

    if (userKeyExists && !ipKeyExists) {
      console.log(`SUCCESS: Rate limit key is correctly user-scoped! (Found key containing: ${userKeyPrefix})`);
    } else {
      console.log('FAILURE: Rate limit key is NOT user-scoped (or IP fallback key was created instead).');
    }
  } catch (err) {
    console.error('Test 1 failed to communicate with API server. Make sure the API server is running on the host first!', (err as Error).message);
  }

  console.log('\n--- TEST 2: Login Brute-Force Rate Limiter Verification ---');
  console.log('Sending 6 rapid login requests to /api/auth/login...');
  
  let got429 = false;
  for (let i = 1; i <= 6; i++) {
    try {
      const res = await axios.post(`${API_URL}/api/auth/login`, {
        email: 'invalid-user@test.com',
        password: 'wrongpassword',
      }, {
        validateStatus: () => true,
      });

      console.log(`Request #${i} Response Status: ${res.status}`);
      if (res.status === 429) {
        got429 = true;
        console.log('Response body:', res.data);
      }
    } catch (err) {
      console.error(`Request #${i} failed:`, (err as Error).message);
    }
  }

  if (got429) {
    console.log('\nSUCCESS: 6th request successfully returned 429 Too Many Requests (Brute-force auth limiter works)!');
  } else {
    console.log('\nFAILURE: Did not receive 429 status code on 6th attempt. Brute-force auth limiter failed.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
