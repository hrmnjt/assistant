// Isolated test host: no dotenv, production credentials, live model or calendar.
import express from 'express';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from '../../server/database.js';
import { provision } from '../../server/auth.js';
import { Household } from '../../server/domain.js';
import { CalendarOutcomeError, CalendarService } from '../../server/calendar.js';
import { Conversations } from '../../server/conversations.js';
import { Reminders } from '../../server/reminders.js';
import { createApp } from '../../server/app.js';
import { updateEventData } from '../../server/icalendar.js';
import type { CalendarResource, CalendarTransport } from '../../server/caldav.js';

if (process.env.HOUSEHOLD_BROWSER_TEST !== '1') throw new Error('Use npm run test:browser.');
mkdirSync('.cache/tests', { recursive: true });
const path = mkdtempSync(resolve('.cache/tests/browser-'));
const db = new Database(resolve(path, 'household.sqlite'));
provision(db, [
  { username: 'owner', name: 'Alex', password: 'Browser-test-owner-password' },
  { username: 'partner', name: 'Sam', password: 'Browser-test-partner-password' },
]);
const household = new Household(db);
let resource: CalendarResource | null = null;
const transport: CalendarTransport = {
  async collection() {
    return { name: 'Household', url: 'https://calendar.invalid/household/' };
  },
  async list() {
    return resource ? [resource] : [];
  },
  async get() {
    return resource;
  },
  async put(url, data) {
    resource = { url, data, etag: '"initial"' };
    throw new Error('Simulate response lost after remote acceptance');
  },
  async remove() {
    throw new Error('No delete expected in this fixture');
  },
};
const fields = {
  title: 'Uncertain browser appointment',
  notes: '',
  location: '',
  allDay: false,
  reminderMinutes: 30,
  start: new Date(Date.now() + 3_600_000).toISOString(),
  end: new Date(Date.now() + 7_200_000).toISOString(),
};
const calendar = new CalendarService(db, transport);
async function reset() {
  // Each test/project starts with isolated fixture state, even on repeated runs.
  // This host never loads .env and its database path is always freshly generated.
  db.transaction(() => {
    for (const table of [
      'sessions',
      'presence',
      'notices',
      'task_history',
      'tasks',
      'previews',
      'audit',
    ])
      db.sql.exec(`DELETE FROM ${table}`);
  });
  resource = null;
  const earlier = new CalendarService(db, transport, () => new Date(Date.now() - 1_200_000));
  const pending = await earlier.preview('owner', { kind: 'calendar.create', event: fields });
  await assert.rejects(
    earlier.confirm('owner', pending.id),
    (error) => error instanceof CalendarOutcomeError && error.calendarOutcome.status === 'unknown',
  );
  const old = await transport.get('https://calendar.invalid/household/');
  if (!old) throw new Error('Test setup failed');
  resource = {
    ...old,
    etag: '"human"',
    data: updateEventData(old, { ...fields, title: 'Later human calendar edit' }, 'human-edit'),
  };
  await calendar.sync();
}
await reset();
const conversations = await Conversations.open(db, resolve(path, 'pi.sqlite'));
const reminders = new Reminders(db, household, path);
const app = createApp(db, household, conversations, reminders, 'http://127.0.0.1:4173', calendar);
// Test-only fixture reset, never mounted by server/index.ts or a deployed Worker.
app.post('/__test/reset', async (req, res) => {
  if (req.headers['x-household-test'] !== 'reset') {
    res.sendStatus(403);
    return;
  }
  await reset();
  res.sendStatus(204);
});
app.use(express.static(resolve('dist')));
app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
const server = app.listen(4173, '127.0.0.1');
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise<void>((done) => server.close(() => done()));
  await conversations.close();
  db.close();
  rmSync(path, { recursive: true, force: true });
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
