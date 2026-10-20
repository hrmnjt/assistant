import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { openHousehold, type Runtime } from '../server/runtime.js';
import type { CalendarSnapshot, Preview } from '../src/types.js';
import { client, config, directory, json, openStore, setUp } from './support.js';
import { appointment, MemoryCalendar } from './memory-calendar.js';

type Person = ReturnType<typeof client>;

const start = Date.parse('2026-10-14T07:00:00Z');
const task = {
  kind: 'task.create',
  task: {
    title: 'Saved task',
    notes: '',
    category: 'household',
    ownerId: 'owner',
    dueAt: null,
    schedule: null,
  },
};
const create = { kind: 'calendar.create', event: appointment };
const previews = async (person: Person): Promise<Preview[]> =>
  await json(await person.call('/api/previews'));
const ids = async (person: Person) => (await previews(person)).map((preview) => preview.id).sort();
async function propose(person: Person, change: unknown): Promise<Preview> {
  const response = await person.call('/api/previews', change);
  assert.equal(response.status, 201);
  return await json(response);
}
const confirm = (person: Person, id: string) => person.call(`/api/previews/${id}/confirm`, {});
const dismiss = (person: Person, id: string, body: unknown = { acknowledgeUncertain: true }) =>
  person.call(`/api/previews/${id}/dismiss`, body);

test('saved changes come back only to their author, and never show the operation behind them', async (t) => {
  const calendar = new MemoryCalendar();
  let now = start;
  const app = await openHousehold(openStore(), config, {
    transport: calendar,
    clock: () => new Date(now),
  });
  t.after(() => app.conversations.close());
  await setUp(app.household);
  const alex = client(app);
  const sam = client(app, 'partner');
  const direct = await propose(alex, task);
  const cancelled = await propose(alex, task);
  const confirmed = await propose(alex, task);
  const samsOwn = await propose(sam, task);
  const uncertain = await propose(alex, create);
  calendar.lose = 'response';
  assert.equal((await confirm(alex, uncertain.id)).status, 503);
  assert.equal((await alex.call(`/api/previews/${cancelled.id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await confirm(alex, confirmed.id)).status, 200);

  assert.deepEqual(await ids(alex), [direct.id, uncertain.id].sort());
  const listed = await previews(alex);
  assert.deepEqual((await json(await alex.call('/api/state'))).previews, listed);
  assert.equal(listed.find((item) => item.id === uncertain.id)?.calendarOutcome?.status, 'unknown');
  assert(listed.every((preview) => !('mutation' in preview) && !('operation' in preview)));
  assert(!JSON.stringify(listed).includes(calendar.base));
  // Sam sees only his own, and cannot act on Alex's.
  assert.deepEqual(await ids(sam), [samsOwn.id]);
  assert.deepEqual((await json(await sam.call('/api/state'))).previews, await previews(sam));
  assert.equal((await confirm(sam, direct.id)).status, 404);
  assert.equal((await confirm(sam, uncertain.id)).status, 404);
  assert.equal((await dismiss(sam, uncertain.id)).status, 404);
  // After ten minutes the direct previews expire; the uncertain calendar result stays.
  now += 10 * 60_000;
  assert.deepEqual(await ids(alex), [uncertain.id]);
  assert.deepEqual(await ids(sam), []);
  assert.equal(calendar.writes, 1);
});

test('an uncertain calendar result survives restarts, and stays dismissed', async () => {
  const path = directory('previews');
  const calendar = new MemoryCalendar();
  let now = start;
  let app: Runtime | undefined;
  /** Stop the household as an evicted Durable Object does, and start it again. */
  const restart = async (transport?: MemoryCalendar) => {
    if (app) {
      await app.conversations.close();
      await app.db.close();
    }
    app = await openHousehold(openStore(resolve(path, 'household.sqlite')), config, {
      transport,
      clock: () => new Date(now),
    });
    return { alex: client(app), sam: client(app, 'partner') };
  };
  try {
    let { alex, sam } = await restart(calendar);
    await setUp(app!.household);
    const { id } = await propose(alex, create);
    // The PUT lands, but the household stops before its response comes back.
    const response = calendar.hold('response');
    void confirm(alex, id);
    await response.reached;
    ({ alex } = await restart());
    const [url] = calendar.resources.keys();
    calendar.rewrite(url, 'Keep this human edit');
    now += 60 * 60_000;
    // Restarted without the calendar: still listed, but it cannot be checked.
    const [listed] = await previews(alex);
    assert.deepEqual([listed.id, listed.calendarOutcome?.status], [id, 'unknown']);
    assert.equal((await confirm(alex, id)).status, 503);
    // With the calendar again, checking finds no proof and sends nothing.
    ({ alex, sam } = await restart(calendar));
    const check = await confirm(alex, id);
    assert.equal(check.status, 200);
    assert.equal((await json(check)).calendarOutcome.status, 'unknown');
    assert.equal((await dismiss(alex, id, {})).status, 400);
    assert.equal((await dismiss(sam, id)).status, 404);
    assert.equal((await dismiss(alex, id)).status, 200);
    assert.equal((await dismiss(alex, id)).status, 200);
    assert.equal((await confirm(alex, id)).status, 409);
    ({ alex } = await restart(calendar));
    assert.deepEqual(await previews(alex), []);
    assert.equal(calendar.writes, 1);
    const synced: CalendarSnapshot = await json(await alex.call('/api/calendar/refresh', {}));
    assert.deepEqual(
      synced.events.map((event) => event.title),
      ['Keep this human edit'],
    );
  } finally {
    await app?.conversations.close();
    await app?.db.close();
    rmSync(path, { recursive: true, force: true });
  }
});
