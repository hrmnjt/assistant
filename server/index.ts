import 'dotenv/config';
import { resolve, relative, isAbsolute } from 'node:path';
import { chmodSync, mkdirSync, existsSync } from 'node:fs';
import express from 'express';
import { Database } from './database.js';
import { provision } from './auth.js';
import { Household } from './domain.js';
import { Conversations } from './conversations.js';
import { Reminders } from './reminders.js';
import { createApp } from './app.js';
import { ICloudTransport } from './caldav.js';
import { CalendarService } from './calendar.js';
import { openAIConnection } from './ai.js';
import { shutdown } from './lifecycle.js';

process.umask(0o077);
const project = process.cwd();
const dataDir = resolve(process.env.DATA_DIR || './data');
const inside = relative(project, dataDir);
if (inside.startsWith('..') || isAbsolute(inside))
  throw new Error('DATA_DIR must be inside this repository.');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
const db = new Database(resolve(dataDir, 'household.sqlite'));
provision(db, [
  {
    username: process.env.OWNER_USERNAME || 'owner',
    name: process.env.OWNER_NAME || 'You',
    password: process.env.OWNER_PASSWORD || '',
  },
  {
    username: process.env.PARTNER_USERNAME || 'partner',
    name: process.env.PARTNER_NAME || 'Partner',
    password: process.env.PARTNER_PASSWORD || '',
  },
]);
const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:5173').origin;
const household = new Household(db);
const calendar = new CalendarService(
  db,
  process.env.ICLOUD_USERNAME && process.env.ICLOUD_APP_PASSWORD
    ? new ICloudTransport({
        username: process.env.ICLOUD_USERNAME,
        password: process.env.ICLOUD_APP_PASSWORD,
        calendarName: process.env.ICLOUD_CALENDAR_NAME || 'Household',
        calendarUrl: process.env.ICLOUD_CALENDAR_URL || undefined,
      })
    : undefined,
);
const connection = await openAIConnection(dataDir);
const conversations = await Conversations.open(db, resolve(dataDir, 'conversations.sqlite'), {
  ...connection,
  household,
  calendar,
});
const reminders = new Reminders(
  db,
  household,
  dataDir,
  process.env.PUSH_CONTACT || (origin.startsWith('https:') ? origin : undefined),
  () => calendar.snapshot(),
);
const app = createApp(db, household, conversations, reminders, origin, calendar);
void calendar.sync();
const calendarTimer = setInterval(() => void calendar.sync(), 60_000);
if (existsSync(resolve(project, 'dist/index.html'))) {
  app.use(express.static(resolve(project, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(project, 'dist/index.html')));
}
const tick = () => {
  try {
    reminders.plan();
    void reminders.deliver().catch(() => console.error('Notification delivery will be retried.'));
  } catch {
    console.error('Reminder planning failed; will retry.');
  }
};
tick();
const timer = setInterval(tick, 30_000);
const server = app.listen(Number(process.env.PORT || 3000), '127.0.0.1', () =>
  console.log(`Household server: http://127.0.0.1:${process.env.PORT || 3000}`),
);
const close = shutdown({
  server,
  timers: [timer, calendarTimer],
  idle: () => [calendar.idle(), reminders.idle()],
  async close() {
    await conversations.close();
    db.close();
  },
});
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
// A failed Pi store closes its harness. Exit non-zero so a supervisor restarts
// the host, which resumes pending assistant work from committed state.
void conversations.storageFailed.then((failed) => {
  if (!failed) return;
  console.error('Assistant storage failed; stopping so the household server can restart.');
  process.exitCode = 1;
  void close();
});
