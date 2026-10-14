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
const conversations = await Conversations.open(db, resolve(dataDir, 'conversations.sqlite'));
const reminders = new Reminders(
  db,
  household,
  dataDir,
  process.env.PUSH_CONTACT || (origin.startsWith('https:') ? origin : undefined),
);
const app = createApp(db, household, conversations, reminders, origin);
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
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  server.close();
  await conversations.close();
  db.close();
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
