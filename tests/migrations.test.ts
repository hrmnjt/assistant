import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Database, migrations } from '../server/database.js';
import { provision } from '../server/auth.js';
import { Household } from '../server/domain.js';

function directory() {
  mkdirSync(resolve('.cache/tests'), { recursive: true });
  return mkdtempSync(resolve('.cache/tests/migrations-'));
}
const columns = (db: Database, table: string) =>
  db.sql
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row.name));
const recurring = JSON.stringify({
  id: 'b1d2c3e4-0000-4000-8000-000000000001',
  title: 'Take out recycling',
  notes: '',
  category: 'household',
  ownerId: 'owner',
  dueAt: '2026-10-15T06:00:00.000Z',
  schedule: { frequency: 'daily', timezone: 'Asia/Dubai' },
  status: 'open',
  revision: 2,
  completedBy: null,
  completedAt: null,
  missedDates: [],
});

/** A populated database as written before schema versioning existed. */
function legacy(path: string) {
  const db = new Database(path, migrations.slice(0, 1));
  provision(db, [
    { username: 'owner', name: 'Alex', password: 'Test-only-owner-password' },
    { username: 'partner', name: 'Sam', password: 'Test-only-partner-password' },
  ]);
  db.sql
    .prepare('INSERT INTO tasks VALUES (?, ?, 2)')
    .run('b1d2c3e4-0000-4000-8000-000000000001', recurring);
  db.sql
    .prepare(
      "INSERT INTO task_history VALUES (?, '2026-10-14T06:00:00.000Z', 'completed', 'partner')",
    )
    .run('b1d2c3e4-0000-4000-8000-000000000001');
  db.sql.exec('PRAGMA user_version = 0');
  db.close();
}

test('a populated pre-versioning database upgrades in place and reopens idempotently', () => {
  const path = directory();
  const file = resolve(path, 'household.sqlite');
  try {
    legacy(file);
    let db = new Database(file);
    assert.equal(db.version, migrations.length);
    assert.ok(columns(db, 'task_history').includes('completed_at'));
    let now = new Date('2026-10-15T05:00:00Z');
    const household = new Household(db, () => now);
    const [old] = household.history('b1d2c3e4-0000-4000-8000-000000000001');
    // The legacy actor survives; its unrecorded completion time stays unknown.
    assert.deepEqual(old, {
      dueAt: '2026-10-14T06:00:00.000Z',
      outcome: 'completed',
      completedBy: 'partner',
      completedAt: null,
    });
    const preview = household.preview('owner', {
      kind: 'task.complete',
      id: 'b1d2c3e4-0000-4000-8000-000000000001',
      revision: 2,
    });
    household.confirm('owner', preview.id);
    db.close();
    db = new Database(file);
    assert.equal(db.version, migrations.length);
    now = new Date('2026-10-15T06:30:00Z');
    const history = new Household(db, () => now).history('b1d2c3e4-0000-4000-8000-000000000001');
    assert.equal(history.length, 2);
    assert.equal(history[0].completedAt, '2026-10-15T05:00:00.000Z');
    assert.equal(history[0].completedBy, 'owner');
    assert.equal(db.sql.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 2);
    db.close();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('a failed migration rolls back completely and keeps the previous version', () => {
  const path = directory();
  const file = resolve(path, 'household.sqlite');
  try {
    new Database(file).close();
    const broken = [
      ...migrations,
      'CREATE TABLE half_applied (id INTEGER); INSERT INTO missing_table VALUES (1);',
    ];
    assert.throws(() => new Database(file, broken), /missing_table/);
    const db = new Database(file);
    assert.equal(db.version, migrations.length);
    assert.equal(
      db.sql.prepare("SELECT 1 FROM sqlite_master WHERE name='half_applied'").get(),
      undefined,
    );
    db.close();
    // A corrected later step applies on the next start.
    const fixed = new Database(file, [...migrations, 'CREATE TABLE half_applied (id INTEGER);']);
    assert.equal(fixed.version, migrations.length + 1);
    fixed.close();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('a database from a newer app version is refused rather than modified', () => {
  const path = directory();
  const file = resolve(path, 'household.sqlite');
  try {
    new Database(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${migrations.length + 1}`);
    raw.close();
    assert.throws(() => new Database(file), /newer app version/);
    const check = new DatabaseSync(file);
    assert.equal(
      Number(check.prepare('PRAGMA user_version').get()!.user_version),
      migrations.length + 1,
    );
    check.close();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
