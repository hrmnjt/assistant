import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Database } from '../server/database.js';
import { auth, provision } from '../server/auth.js';

async function fixture(options: Parameters<typeof auth>[2] = {}) {
  const db = new Database(':memory:');
  provision(db, [
    { username: 'owner', name: 'Alex', password: 'Auth-test-owner-password' },
    { username: 'partner', name: 'Sam', password: 'Auth-test-partner-password' },
  ]);
  const app = express();
  // As in createApp: only the loopback tunnel may supply the forwarded client address.
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.post('/login', auth(db, 'http://localhost:5173', options).login);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const login = (client: string, password = 'wrong-password', username = 'owner') =>
    fetch(`http://127.0.0.1:${address.port}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': client },
      body: JSON.stringify({ username, password }),
    }).then(async (response) => ({ status: response.status, ...(await response.json()) }));
  return {
    login,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

test('sign-in throttling is per client and expires after its window', async () => {
  let now = Date.parse('2026-10-14T07:00:00Z');
  const f = await fixture({ now: () => now });
  try {
    for (let attempt = 0; attempt < 10; attempt++)
      assert.equal((await f.login('203.0.113.1')).status, 401);
    // The limit applies to the correct password too, and to unknown accounts alike.
    assert.equal((await f.login('203.0.113.1', 'Auth-test-owner-password')).status, 429);
    assert.equal((await f.login('203.0.113.1', 'x', 'nobody')).status, 429);
    // Another client, such as the other spouse's phone, is unaffected.
    assert.equal(
      (await f.login('203.0.113.2', 'Auth-test-partner-password', 'partner')).status,
      200,
    );
    now += 900_000;
    assert.equal((await f.login('203.0.113.1', 'Auth-test-owner-password')).status, 200);
  } finally {
    await f.close();
  }
});

test('a successful sign-in clears that client, and unknown accounts get the same answer', async () => {
  const f = await fixture();
  try {
    for (let attempt = 0; attempt < 9; attempt++) await f.login('203.0.113.5');
    assert.equal((await f.login('203.0.113.5', 'Auth-test-owner-password')).status, 200);
    for (let attempt = 0; attempt < 9; attempt++)
      assert.equal((await f.login('203.0.113.5')).status, 401);
    const unknown = await f.login('203.0.113.6', 'wrong-password', 'nobody');
    const known = await f.login('203.0.113.6', 'wrong-password', 'owner');
    assert.deepEqual(unknown, known);
  } finally {
    await f.close();
  }
});

test('throttle memory is bounded by dropping the oldest tracked client', async () => {
  const f = await fixture({ maxClients: 2 });
  try {
    for (let attempt = 0; attempt < 10; attempt++) await f.login('198.51.100.1');
    assert.equal((await f.login('198.51.100.1')).status, 429);
    await f.login('198.51.100.2');
    await f.login('198.51.100.3');
    // The first client's window was the oldest and is no longer held in memory.
    assert.equal((await f.login('198.51.100.1')).status, 401);
  } finally {
    await f.close();
  }
});

test('password checks run off the event loop with a bounded number in flight', async () => {
  const f = await fixture({ maxConcurrent: 1 });
  try {
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) => f.login(`192.0.2.${index + 1}`)),
    );
    assert.ok(results.some((result) => result.status === 401));
    // A synchronous derivation would finish before the next request is read,
    // so a busy answer shows other requests are served while one is checked.
    assert.ok(results.some((result) => result.status === 429 && /busy/.test(String(result.error))));
  } finally {
    await f.close();
  }
});

test('parallel guesses from one client share its ten-attempt limit', async () => {
  const f = await fixture({ maxConcurrent: 20 });
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => f.login('192.0.2.50')));
    assert.equal(results.filter((result) => result.status === 401).length, 10);
    assert.equal(
      results.filter((result) => result.status === 429 && /Too many/.test(String(result.error)))
        .length,
      2,
    );
  } finally {
    await f.close();
  }
});
