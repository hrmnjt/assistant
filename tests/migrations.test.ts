import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, migrations, schemaVersion } from '../server/database.js';
import { openHousehold } from '../server/runtime.js';
import { adminToken, client, config, deployment, json, openStore, push, setUp } from './support.js';

test('a failed upgrade leaves the store as it was, and a newer store is refused untouched', async () => {
  const db = openStore();
  try {
    await migrate(db);
    const step = 'CREATE TABLE half_applied (id INTEGER);';
    await assert.rejects(
      migrate(db, [...migrations, `${step} INSERT INTO missing_table VALUES (1);`]),
    );
    assert.equal(await schemaVersion(db), migrations.length);
    assert.equal(
      await db.get("SELECT 1 AS found FROM sqlite_master WHERE name='half_applied'"),
      undefined,
    );
    // Corrected, the step applies on the next start.
    await migrate(db, [...migrations, step]);
    assert.equal(await schemaVersion(db), migrations.length + 1);
    // The app is now older than its store, so it does not start rather than change it.
    await assert.rejects(openHousehold(db, config));
    assert.equal(await schemaVersion(db), migrations.length + 1);
  } finally {
    await db.close();
  }
});

test('people and their settings from an earlier version survive the upgrade; retired settings are dropped', async () => {
  const db = openStore();
  // Earlier versions set people up at the first sign-in and kept connections in Settings.
  await migrate(db, migrations.slice(0, 3));
  await db.run("INSERT INTO users VALUES ('owner','owner','You'),('partner','partner','Partner')");
  await db.run(
    "INSERT INTO preferences VALUES ('owner', ?, 4)",
    JSON.stringify({
      timezone: 'Europe/London',
      morning: { enabled: false, time: '07:00' },
      evening: { enabled: true, time: '18:00' },
    }),
  );
  const saved = {
    icloud: { username: 'family@icloud.example', password: 'old-app-password' },
    ai_model: 'gpt-6.1-sol',
    push,
  };
  for (const [key, value] of Object.entries(saved))
    await db.run('INSERT INTO settings VALUES (?, ?)', key, JSON.stringify(value));
  const app = await openHousehold(db, deployment);
  try {
    await setUp(app.household);
    const owner = client(app, 'owner', 'https://assistant.example.workers.dev');
    const state = await json(await owner.call('/api/state'));
    assert.deepEqual(
      [state.me.id, state.me.name, state.preferences.timezone],
      ['owner', 'Alex', 'Europe/London'],
    );
    // The push keys stay, so phones keep their subscriptions; iCloud and the model are set again.
    assert.equal((await json(await owner.call('/api/push/key'))).publicKey, push.publicKey);
    const signedIn = await owner.call('/api/admin/session', { token: adminToken });
    const adminState = await json(
      await owner.call('/api/admin/state', undefined, 'GET', {
        Cookie: signedIn.headers.get('set-cookie')!.split(';')[0],
      }),
    );
    assert.deepEqual([adminState.calendar.account, adminState.ai.model], [null, null]);
  } finally {
    await app.conversations.close();
  }
});
