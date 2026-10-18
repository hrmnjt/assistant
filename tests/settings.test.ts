import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHousehold } from '../server/runtime.js';
import type {
  CalendarAccount,
  CalendarConnector,
  CalendarTransport,
} from '../server/plugins/calendar/caldav.js';
import { client, config, directory, openStore, setUp, type Row } from './support.js';

const json = async (response: Response) => (await response.json()) as any;

test('push keys are made once and kept, so phones stay subscribed', async () => {
  const path = `${directory('settings')}/household.sqlite`;
  const first = await openHousehold(openStore(path), config);
  await setUp(first.household);
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

/** iCloud for tests: one account with a shared calendar and a personal one. */
function fakeICloud() {
  const opened: string[] = [];
  const valid = (account: CalendarAccount) =>
    account.username === 'family@icloud.example' && account.password === 'abcd-efgh-ijkl-mnop';
  const calendars = [
    { name: 'Household', url: 'https://caldav.icloud.com/1/calendars/home/' },
    { name: 'Personal', url: 'https://caldav.icloud.com/1/calendars/mine/' },
  ];
  const connector: CalendarConnector = {
    calendars: async (account) => {
      if (!valid(account)) throw new Error('401');
      return calendars;
    },
    open: (account): CalendarTransport => {
      opened.push(account.calendarUrl);
      const name = calendars.find((calendar) => calendar.url === account.calendarUrl)!.name;
      return {
        collection: async () => ({ name, url: account.calendarUrl }),
        list: async () => [],
        get: async () => null,
        put: async () => undefined,
        remove: async () => undefined,
      };
    },
  };
  return { connector, opened };
}

test('whoever set up connects iCloud in Settings; it is kept, private, and can be removed', async () => {
  const path = `${directory('settings')}/household.sqlite`;
  const icloud = fakeICloud();
  const app = await openHousehold(openStore(path), config, { connector: icloud.connector });
  await setUp(app.household);
  const owner = client(app, 'owner');
  const account = { username: 'family@icloud.example', password: 'abcd-efgh-ijkl-mnop' };
  try {
    assert.equal(
      (await client(app, 'partner').call('/api/calendar/connection', account)).status,
      403,
    );
    const wrong = await owner.call('/api/calendar/connection', {
      ...account,
      password: 'nope-nope',
    });
    assert.equal(wrong.status, 400);
    assert.match((await json(wrong)).error, /did not accept/);
    // Without a chosen calendar: the account's calendars to choose from; nothing is saved.
    const listed = await json(await owner.call('/api/calendar/connection', account));
    assert.deepEqual(
      listed.calendars.map((calendar: { name: string }) => calendar.name),
      ['Household', 'Personal'],
    );
    assert.equal((await app.db.all<Row>("SELECT key FROM settings WHERE key='icloud'")).length, 0);
    assert.equal(
      (
        await owner.call('/api/calendar/connection', {
          ...account,
          calendarUrl: 'https://caldav.icloud.com/1/calendars/other/',
        })
      ).status,
      400,
    );
    const connected = await owner.call('/api/calendar/connection', {
      ...account,
      calendarUrl: listed.calendars[0].url,
    });
    assert.equal(connected.status, 200);
    assert.deepEqual([(await json(connected)).status], ['connected']);
    const ownerState = await json(await owner.call('/api/state'));
    assert.equal(ownerState.calendarAccount, account.username);
    assert.equal(ownerState.calendar.name, 'Household');
    const partnerState = await json(await client(app, 'partner').call('/api/state'));
    assert.equal(partnerState.calendarAccount, undefined);
    assert.equal(partnerState.integrations.calendar, 'connected');
    for (const state of [ownerState, partnerState])
      assert(!JSON.stringify(state).includes(account.password));
  } finally {
    await app.conversations.close();
  }
  // A restart reopens the saved connection.
  const reopened = await openHousehold(openStore(path), config, { connector: icloud.connector });
  try {
    assert.deepEqual(icloud.opened, [
      'https://caldav.icloud.com/1/calendars/home/',
      'https://caldav.icloud.com/1/calendars/home/',
    ]);
    const owner = client(reopened, 'owner');
    assert.equal((await owner.call('/api/calendar/refresh', {})).status, 200);
    assert.equal((await json(await owner.call('/api/state'))).integrations.calendar, 'connected');
    assert.equal((await owner.call('/api/calendar/connection', undefined, 'DELETE')).status, 200);
    const state = await json(await owner.call('/api/state'));
    assert.deepEqual(
      [state.integrations.calendar, state.calendarAccount],
      ['not-connected', undefined],
    );
  } finally {
    await reopened.conversations.close();
  }
});

test('only whoever set up sees or chooses the assistant model', async () => {
  const app = await openHousehold(openStore(), config);
  await setUp(app.household);
  try {
    const partner = client(app, 'partner');
    assert.equal((await partner.call('/api/assistant/models')).status, 403);
    assert.equal((await partner.call('/api/assistant/model', { id: 'gpt-6.1-sol' })).status, 403);
    // Without a ChatGPT connection there is no catalog to choose from.
    const owner = client(app, 'owner');
    const missing = await owner.call('/api/assistant/models');
    assert.equal(missing.status, 409);
    assert.match((await json(missing)).error, /npm run ai:connect/);
    assert.equal((await json(await owner.call('/api/state'))).integrations.ai, 'not-connected');
  } finally {
    await app.conversations.close();
  }
});
