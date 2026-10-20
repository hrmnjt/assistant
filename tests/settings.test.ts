import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHousehold } from '../server/runtime.js';
import { ICloudTransport, type CalendarTransport } from '../server/plugins/calendar/caldav.js';
import { createEventData } from '../server/plugins/calendar/icalendar.js';
import { client, config, directory, openStore } from './support.js';

const json = async (response: Response) => (await response.json()) as any;

test('push keys are made once and kept, so phones stay subscribed', async () => {
  const path = `${directory('settings')}/household.sqlite`;
  const first = await openHousehold(openStore(path), config);
  const key = (await json(await client(first).call('/api/push/key'))).publicKey;
  await first.conversations.close();
  assert.match(key, /^[A-Za-z0-9_-]{80,}$/);
  const again = await openHousehold(openStore(path), config);
  try {
    assert.equal((await json(await client(again).call('/api/push/key'))).publicKey, key);
  } finally {
    await again.conversations.close();
  }
});

/** iCloud for tests: one calendar with one appointment tomorrow. */
const calendar = (name: string): CalendarTransport => {
  const start = new Date(Date.now() + 86_400_000);
  const data = createEventData(
    'dentist',
    {
      title: 'Dentist',
      notes: '',
      location: '',
      start: start.toISOString(),
      end: new Date(start.getTime() + 3_600_000).toISOString(),
      allDay: false,
      reminderMinutes: null,
    },
    'operation',
  );
  return {
    collection: async () => ({ name, url: 'https://caldav.icloud.com/1/calendars/home/' }),
    list: async () => [
      { url: 'https://caldav.icloud.com/1/calendars/home/dentist.ics', etag: '"1"', data },
    ],
    get: async () => null,
    put: async () => undefined,
    remove: async () => undefined,
  };
};

test('the calendar comes from the variables; another calendar drops the cached one', async () => {
  const path = `${directory('settings')}/household.sqlite`;
  const icloud = { ...config, ICLOUD_USERNAME: 'family@icloud.example', ICLOUD_CALENDAR: 'Home' };
  const open = (settings: Record<string, string>) =>
    openHousehold(openStore(path), settings, { transport: calendar(settings.ICLOUD_CALENDAR) });
  const first = await open(icloud);
  try {
    assert.equal((await client(first).call('/api/calendar/refresh', {})).status, 200);
    const state = await json(await client(first, 'partner').call('/api/state'));
    assert.deepEqual(
      [state.integrations.calendar, state.calendar.name, state.calendar.events.length],
      ['connected', 'Home', 1],
    );
    assert.equal('calendarAccount' in state, false);
    // There is nothing to connect in the app.
    const removed = await client(first).call('/api/calendar/connection', undefined, 'DELETE');
    assert.equal(removed.status, 404);
  } finally {
    await first.conversations.close();
  }
  // A restart with the same calendar shows its cached appointments until the first refresh.
  const same = await open(icloud);
  const cached = async (app: typeof same) =>
    (await json(await client(app).call('/api/state'))).calendar.events.length;
  try {
    assert.equal(await cached(same), 1);
  } finally {
    await same.conversations.close();
  }
  const other = await open({ ...icloud, ICLOUD_CALENDAR: 'Work' });
  try {
    assert.equal(await cached(other), 0);
  } finally {
    await other.conversations.close();
  }
  // Without the variables there is no calendar.
  const none = await openHousehold(openStore(path), config);
  try {
    const state = await json(await client(none).call('/api/state'));
    assert.deepEqual(
      [state.integrations.calendar, state.calendar.events.length],
      ['not-connected', 0],
    );
  } finally {
    await none.conversations.close();
  }
});

test('ICLOUD_CALENDAR picks a calendar by name, or lists the names to choose from', async () => {
  const account = (calendarName: string) => {
    const transport = new ICloudTransport({
      username: 'family@icloud.example',
      password: 'abcd-efgh-ijkl-mnop',
      calendarName,
    });
    // iCloud for tests: two event calendars and a reminders list.
    Object.assign(transport, {
      client: {
        login: async () => undefined,
        fetchCalendars: async () => [
          { displayName: 'Home', url: 'https://caldav.icloud.com/1/calendars/home/' },
          { displayName: 'Work', url: 'https://caldav.icloud.com/1/calendars/work/' },
          {
            displayName: 'Reminders',
            url: 'https://caldav.icloud.com/1/calendars/tasks/',
            components: ['VTODO'],
          },
        ],
      },
    });
    return transport;
  };
  assert.deepEqual(await account('Work').collection(), {
    name: 'Work',
    url: 'https://caldav.icloud.com/1/calendars/work/',
  });
  for (const name of ['', 'Household', 'Reminders'])
    await assert.rejects(account(name).collection(), {
      message: 'Set ICLOUD_CALENDAR to one of your iCloud calendars: Home, Work.',
    });
});

test('the model comes from CHATGPT_MODEL; the app lists the account’s models to choose from', async () => {
  const app = await openHousehold(openStore(), config);
  try {
    const partner = client(app, 'partner');
    assert.equal((await partner.call('/api/assistant/model', { id: 'gpt-6.1-sol' })).status, 404);
    // Without a ChatGPT connection there is no catalog to choose from.
    const missing = await partner.call('/api/assistant/models');
    assert.equal(missing.status, 409);
    assert.match((await json(missing)).error, /npm run ai:connect/);
    assert.equal((await json(await partner.call('/api/state'))).integrations.ai, 'not-connected');
  } finally {
    await app.conversations.close();
  }
});
