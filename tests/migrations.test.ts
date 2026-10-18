import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { migrate, migrations, schemaVersion } from '../server/database.js';
import { directory, openStore, type Row } from './support.js';

test('a new store is migrated once and reopening is idempotent', async () => {
  const path = directory('migrations');
  const file = resolve(path, 'household.sqlite');
  try {
    let db = openStore(file);
    await migrate(db);
    assert.equal(await schemaVersion(db), migrations.length);
    await db.run("INSERT INTO users VALUES ('owner','owner','Alex')");
    await db.close();
    db = openStore(file);
    await migrate(db);
    assert.equal(await schemaVersion(db), migrations.length);
    assert.equal((await db.get<Row>('SELECT COUNT(*) AS n FROM users'))!.n, 1);
    await db.close();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('household tables and Pi tables share one store without name collisions', async () => {
  const db = openStore();
  await migrate(db);
  await SqliteStorage.open(db);
  const tables = (await db.all<Row>("SELECT name FROM sqlite_master WHERE type='table'")).map(
    (row) => row.name,
  );
  // Pi owns `tasks`; household tasks live in their own table.
  assert.ok(tables.includes('tasks'));
  assert.ok(tables.includes('household_tasks'));
  await migrate(db);
  await db.close();
});

test('a failed migration rolls back completely and keeps the previous version', async () => {
  const db = openStore();
  try {
    await migrate(db);
    const broken = [
      ...migrations,
      'CREATE TABLE half_applied (id INTEGER); INSERT INTO missing_table VALUES (1);',
    ];
    await assert.rejects(migrate(db, broken), /missing_table/);
    assert.equal(await schemaVersion(db), migrations.length);
    assert.equal(
      await db.get("SELECT 1 AS found FROM sqlite_master WHERE name='half_applied'"),
      undefined,
    );
    // A corrected later step applies on the next start.
    await migrate(db, [...migrations, 'CREATE TABLE half_applied (id INTEGER);']);
    assert.equal(await schemaVersion(db), migrations.length + 1);
  } finally {
    await db.close();
  }
});

test('a store from a newer app version is refused rather than modified', async () => {
  const db = openStore();
  try {
    await migrate(db);
    await db.run('UPDATE household_schema SET version=?', migrations.length + 1);
    await assert.rejects(migrate(db), /newer app version/);
    assert.equal(await schemaVersion(db), migrations.length + 1);
  } finally {
    await db.close();
  }
});
