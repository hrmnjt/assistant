import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import express from 'express';
import { shutdown } from '../server/lifecycle.js';
import { openAIConnection } from '../server/ai.js';
import { Database } from '../server/database.js';
import { provision } from '../server/auth.js';
import { Household } from '../server/domain.js';
import { Conversations } from '../server/conversations.js';
import { Reminders } from '../server/reminders.js';
import { createApp } from '../server/app.js';

function directory() {
  mkdirSync('.cache/tests', { recursive: true });
  return mkdtempSync(resolve('.cache/tests/lifecycle-'));
}
async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { server, base: `http://127.0.0.1:${address.port}` };
}

test('shutdown lets requests and then background work finish before storage closes', async () => {
  const events: string[] = [];
  const app = express();
  app.get('/slow', async (_req, res) => {
    await pause(150);
    events.push('request finished');
    res.json({ ok: true });
  });
  const { server, base } = await listen(app);
  const timer = setInterval(() => events.push('timer fired'), 20);
  const close = shutdown({
    server,
    timers: [timer],
    idle: () => {
      events.push('waiting for background work');
      return [pause(100).then(() => events.push('background finished'))];
    },
    close: async () => {
      events.push('storage closed');
    },
  });
  const request = fetch(`${base}/slow`);
  await pause(30);
  const count = events.length;
  await Promise.all([close(), close()]);
  assert.equal((await request).status, 200);
  assert.deepEqual(events.slice(count), [
    'request finished',
    'waiting for background work',
    'background finished',
    'storage closed',
  ]);
});

test('shutdown is bounded when a request does not finish', async () => {
  const app = express();
  app.get('/hang', () => undefined);
  const { server, base } = await listen(app);
  let closed = false;
  const close = shutdown({
    server,
    timers: [],
    idle: () => [],
    close: async () => {
      closed = true;
    },
    timeoutMs: 200,
  });
  const request = fetch(`${base}/hang`).catch(() => 'dropped');
  await pause(30);
  const started = Date.now();
  await close();
  assert.ok(Date.now() - started < 2000);
  assert.equal(closed, true);
  assert.equal(await request, 'dropped');
});

test('unreadable optional AI files leave the household app available without the assistant', async () => {
  for (const [file, value] of [
    ['chatgpt-host.json', '{not json'],
    ['chatgpt-auth.json', '{"type":"oauth"'],
  ]) {
    const path = directory();
    try {
      writeFileSync(
        resolve(path, 'chatgpt-host.json'),
        JSON.stringify({ hostId: 'h', modelId: 'm' }),
      );
      writeFileSync(resolve(path, file), value);
      const connection = await openAIConnection(path);
      assert.equal(connection.model, undefined, file);
      assert.ok(connection.models);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

test('the health endpoint reports readiness without signing in', async () => {
  const path = directory();
  const db = new Database(resolve(path, 'household.sqlite'));
  provision(db, [
    { username: 'owner', name: 'Alex', password: 'Lifecycle-owner-password' },
    { username: 'partner', name: 'Sam', password: 'Lifecycle-partner-password' },
  ]);
  const household = new Household(db);
  const conversations = await Conversations.open(db, resolve(path, 'pi.sqlite'));
  const reminders = new Reminders(db, household, path);
  const { server, base } = await listen(
    createApp(db, household, conversations, reminders, 'http://localhost:5173'),
  );
  try {
    const ready = await fetch(`${base}/api/health`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true });
    await conversations.close();
    assert.equal((await fetch(`${base}/api/health`)).status, 503);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(path, { recursive: true, force: true });
  }
});
