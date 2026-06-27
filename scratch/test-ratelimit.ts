import axios from 'axios';
import { redis } from '../src/config/redis.js';
import { getEnv } from '../src/config/env.js';

const env = getEnv();
const API_URL = `http://localhost:${env.PORT || 3000}`;

async function main() {
  console.log('Using API URL:', API_URL);

  const email = process.argv[2] || 'max@salahsoft.com';
  const password = process.argv[3] || 'password123'; // Fallback default test password

  // Clear existing ratelimit keys in Redis
  try {
    const oldKeys = await redis.keys('ratelimit:*');
    if (oldKeys.length > 0) {
      await redis.del(...oldKeys);
    }
  } catch (err) {
    console.warn('Failed to clear old ratelimit keys in Redis:', (err as Error).message);
  }

  // 1. Perform a real login to get a fully valid server-signed JWT token
  console.log(`\nStep 1: Performing real login for user "${email}"...`);
  let token = '';
  let orgId = '';
  let userId = '';

  try {
    const loginRes = await axios.post(`${API_URL}/api/auth/login`, {
      email,
      password,
    }, {
      validateStatus: () => true,
      timeout: 5000,
    });

    if (loginRes.status !== 200) {
      console.error(`\nFAILURE: Login failed with status ${loginRes.status}:`, loginRes.data);
      console.log('\nUsage Note: If you are using custom credentials, please run the script with them as arguments:');
      console.log('  npx tsx --env-file=.env scratch/test-ratelimit.ts <email> <password>');
      await redis.quit();
      process.exit(1);
    }

    token = loginRes.data.tokens.accessToken;
    orgId = loginRes.data.user.orgId;
    userId = loginRes.data.user.id;

    console.log(`Login successful! Resolves to user: ${email} (ID: ${userId}, Org: ${orgId})`);
  } catch (err) {
    console.error('\nFAILURE: Failed to communicate with the API server for login.', (err as Error).message);
    console.log('Make sure the API server is running on the host first!');
    await redis.quit();
    process.exit(1);
  }

  console.log('\n--- TEST 1: User-Scoped Rate Limiter Verification ---');
  console.log('Sending authenticated request to /api/auth/me...');
  try {
    const res = await axios.get(`${API_URL}/api/auth/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      validateStatus: () => true,
      timeout: 5000,
    });

    console.log(`Response Status: ${res.status}`);
    
    // Inspect Redis to see what key was created
    const keys = await redis.keys('ratelimit:api:*');
    console.log('Ratelimit keys found in Redis:', keys);

    const userKeyPrefix = `ratelimit:api:${orgId}:${userId}`;
    const userKeyExists = keys.some(k => k.includes(userKeyPrefix));
    const ipKeyExists = keys.some(k => !k.includes(orgId) && k.includes('ratelimit:api:'));

    if (userKeyExists && !ipKeyExists) {
      console.log(`SUCCESS: Rate limit key is correctly user-scoped! (Found key containing: ${userKeyPrefix})`);
    } else {
      console.log('FAILURE: Rate limit key is NOT user-scoped (or IP fallback key was created instead).');
    }
  } catch (err) {
    console.error('Test 1 failed to verify rate-limiter keys:', (err as Error).message);
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
        timeout: 5000,
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

  // Gracefully quit Redis connection and exit
  await redis.quit();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Unhandled test execution error:', err);
  try {
    await redis.quit();
  } catch {}
  process.exit(1);
});
