import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Database } from '../server/database.js';
import { digest, provision, verifyPassword } from '../server/auth.js';
import { accounts, changePassword, revokeSessions } from '../server/accounts.js';

const people = [
  { username: 'alex', name: 'Alex', password: 'Accounts-owner-password' },
  { username: 'sam', name: 'Sam', password: 'Accounts-partner-password' },
];
function fixture(path = ':memory:') {
  const db = new Database(path);
  provision(db, people);
  for (const [token, user] of [
    ['owner-phone', 'owner'],
    ['owner-laptop', 'owner'],
    ['partner-phone', 'partner'],
  ])
    db.sql
      .prepare('INSERT INTO sessions VALUES (?,?,?)')
      .run(digest(token), user, Date.now() + 86_400_000);
  return db;
}
const hash = (db: Database, id: string) =>
  String(db.sql.prepare('SELECT password_hash FROM users WHERE id=?').get(id)!.password_hash);
const sessions = (db: Database, id: string) =>
  Number(db.sql.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(id)!.n);

test('rotating one password signs that account out and preserves the other account', async () => {
  const db = fixture();
  try {
    const partnerHash = hash(db, 'partner');
    assert.equal(changePassword(db, 'alex', 'A-new-owner-password'), 2);
    assert.equal(await verifyPassword('A-new-owner-password', hash(db, 'owner')), true);
    assert.equal(await verifyPassword('Accounts-owner-password', hash(db, 'owner')), false);
    assert.equal(sessions(db, 'owner'), 0);
    assert.equal(sessions(db, 'partner'), 1);
    assert.equal(hash(db, 'partner'), partnerHash);
    assert.deepEqual(
      accounts(db).map(({ id, username }) => `${id}:${username}`),
      ['owner:alex', 'partner:sam'],
    );
    assert.throws(() => changePassword(db, 'partner', 'too-short'), /12 to 1024/);
    assert.throws(() => changePassword(db, 'someone', 'A-long-enough-password'), /No household/);
    assert.equal(hash(db, 'partner'), partnerHash);
  } finally {
    db.close();
  }
});

test('sessions can be revoked for one account or both', () => {
  const db = fixture();
  try {
    assert.equal(revokeSessions(db, 'partner'), 1);
    assert.equal(sessions(db, 'owner'), 2);
    assert.equal(revokeSessions(db), 2);
    assert.equal(sessions(db, 'owner'), 0);
  } finally {
    db.close();
  }
});

test('the account command reads the new password without printing it', async () => {
  mkdirSync('.cache/tests', { recursive: true });
  const path = mkdtempSync(resolve('.cache/tests/accounts-'));
  try {
    fixture(resolve(path, 'household.sqlite')).close();
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'scripts/accounts.ts', ...args], {
        env: { ...process.env, DATA_DIR: relative(process.cwd(), path) },
        input: 'Piped-new-partner-password\n',
        encoding: 'utf8',
      });
    const changed = run('password', 'sam');
    assert.equal(changed.status, 0, changed.stderr);
    assert.match(changed.stdout, /Ended 1 signed-in sessions/);
    assert.equal(
      `${changed.stdout}${changed.stderr}`.includes('Piped-new-partner-password'),
      false,
    );
    const listed = run('list');
    assert.match(listed.stdout, /partner: Sam \(sam\), 0 signed-in sessions/);
    assert.equal(run('password', 'nobody').status, 1);
    const db = new Database(resolve(path, 'household.sqlite'));
    assert.equal(await verifyPassword('Piped-new-partner-password', hash(db, 'partner')), true);
    db.close();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
