import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityHeader } from '../server/auth.js';
import { openHousehold, type Runtime } from '../server/runtime.js';
import type {
  CalendarAccount,
  CalendarConnector,
  CalendarTransport,
} from '../server/plugins/calendar/caldav.js';
import {
  adminToken,
  client,
  config,
  deployment,
  directory,
  openStore,
  origin,
  people,
  setUp,
  type Row,
} from './support.js';

const json = async (response: Response) => (await response.json()) as any;
const base = 'https://assistant.example.workers.dev';

/** The admin page's requests, keeping its session cookie as a browser does. */
function admin(app: Runtime, headers: Record<string, string> = {}, at = base) {
  let cookie = '';
  const call = async (
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
  ) => {
    const response = await client(app, null, at).call(path, body, method, {
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return response;
  };
  return {
    call,
    signIn: (token = adminToken) => call('/api/admin/session', { token }),
    get cookie() {
      return cookie;
    },
  };
}

test('the admin signs in with ADMIN_TOKEN, separately from the two people', async () => {
  const app = await openHousehold(openStore(), deployment);
  try {
    const page = admin(app);
    assert.deepEqual(await json(await page.call('/api/admin/session')), {
      signedIn: false,
      development: false,
      unavailable: null,
    });
    assert.equal((await page.call('/api/admin/state')).status, 401);
    assert.equal((await page.signIn('not the token')).status, 401);
    const signedIn = await page.signIn();
    assert.equal(signedIn.status, 200);
    const cookie = signedIn.headers.get('set-cookie')!;
    for (const part of [
      'Path=/api/admin',
      'HttpOnly',
      'SameSite=Strict',
      'Secure',
      'Max-Age=43200',
    ])
      assert(cookie.includes(part), part);
    assert.equal((await json(await page.call('/api/admin/session'))).signedIn, true);
    // The admin's session is not a person's sign-in, and a person's is not the admin's.
    await setUp(app.household);
    assert.equal((await page.call('/api/state')).status, 401);
    assert.equal((await client(app, 'owner', base).call('/api/admin/state')).status, 401);
    // Signing out ends the session.
    assert.equal((await page.call('/api/admin/session', undefined, 'DELETE')).status, 200);
    assert.equal(page.cookie, 'assistant-admin=');
    assert.equal((await page.call('/api/admin/state')).status, 401);
  } finally {
    await app.conversations.close();
  }
});

test('admin sign-in is off without a long ADMIN_TOKEN, locks after five wrong tokens, and ends with a new token', async () => {
  for (const ADMIN_TOKEN of [undefined, 'too-short'] as const) {
    const app = await openHousehold(openStore(), { ADMIN_TOKEN });
    try {
      const page = admin(app);
      assert.match((await json(await page.call('/api/admin/session'))).unavailable, /ADMIN_TOKEN/);
      assert.equal((await page.signIn('too-short')).status, 503);
    } finally {
      await app.conversations.close();
    }
  }
  const path = `${directory('admin')}/household.sqlite`;
  const first = await openHousehold(openStore(path), deployment);
  const page = admin(first);
  try {
    for (let attempt = 0; attempt < 5; attempt++)
      assert.equal((await page.signIn(`wrong-${attempt}`)).status, 401);
    const locked = await page.signIn();
    assert.equal(locked.status, 429);
    assert.match((await json(locked)).error, /Try again in 15 minutes/);
  } finally {
    await first.conversations.close();
  }
  // After the lock (here: a clock 16 minutes on), the right token works again.
  const later = await openHousehold(openStore(path), deployment, {
    clock: () => new Date(Date.now() + 16 * 60_000),
  });
  const again = admin(later);
  try {
    assert.equal((await again.signIn()).status, 200);
  } finally {
    await later.conversations.close();
  }
  // A new ADMIN_TOKEN ends the sessions made with the old one.
  const rotated = await openHousehold(openStore(path), {
    ADMIN_TOKEN: 'a-new-admin-token-0123456789-abcdefghij',
  });
  try {
    const response = await client(rotated, null, base).call('/api/admin/state', undefined, 'GET', {
      Cookie: again.cookie,
    });
    assert.equal(response.status, 401);
  } finally {
    await rotated.conversations.close();
  }
});

test('the admin adds the two people; a changed name or email keeps their records', async () => {
  const app = await openHousehold(openStore(), deployment);
  try {
    const page = admin(app);
    await page.signIn();
    const invalid = [
      [{ name: 'Alex', email: 'alex@example.com' }],
      [
        { name: 'Alex', email: 'alex@example.com' },
        { name: 'Sam', email: 'ALEX@example.com' },
      ],
      [
        { name: ' ', email: 'alex@example.com' },
        { name: 'Sam', email: 'sam@example.com' },
      ],
      // A deployment needs both emails.
      [{ name: 'Alex', email: 'alex@example.com' }, { name: 'Sam' }],
    ];
    for (const value of invalid)
      assert.equal(
        (await page.call('/api/admin/people', { people: value }, 'PUT')).status,
        400,
        JSON.stringify(value),
      );
    const added = await page.call(
      '/api/admin/people',
      { people: [people.owner, { name: 'Sam', email: 'Sam@Example.com' }] },
      'PUT',
    );
    assert.equal(added.status, 200);
    const sam = client(app, 'partner', base);
    assert.equal((await json(await sam.call('/api/state'))).me.name, 'Sam');
    await sam.call('/api/previews', {
      kind: 'thread.create',
      title: 'Holiday',
      category: 'household',
    });
    // Sam is renamed and moves email; Alex takes Sam's old address.
    await page.call(
      '/api/admin/people',
      {
        people: [
          { name: 'Alex', email: people.partner.email },
          { name: 'Sammy', email: 'sam@new.example' },
        ],
      },
      'PUT',
    );
    const signedIn = (email: string) =>
      app.auth.caller(new Request(`${base}/api/state`, { headers: { [identityHeader]: email } }));
    assert.equal(await signedIn(people.owner.email), null);
    assert.equal((await signedIn(people.partner.email))?.id, 'owner');
    const moved = await signedIn('sam@new.example');
    assert.deepEqual([moved?.id, moved?.name], ['partner', 'Sammy']);
    const previews = await json(
      await client(app, null, base).call('/api/previews', undefined, 'GET', {
        [identityHeader]: 'sam@new.example',
      }),
    );
    assert.equal(previews.length, 1);
    const state = await json(await page.call('/api/admin/state'));
    assert.deepEqual(state.people, [
      { id: 'owner', name: 'Alex', email: people.partner.email },
      { id: 'partner', name: 'Sammy', email: 'sam@new.example' },
    ]);
  } finally {
    await app.conversations.close();
  }
});

test('the admin page shows the email Cloudflare Access verified for this request', async () => {
  const app = await openHousehold(openStore(), deployment);
  try {
    const page = admin(app, { [identityHeader]: 'someone@example.com' });
    await page.signIn();
    assert.equal((await json(await page.call('/api/admin/state'))).access, 'someone@example.com');
    const without = admin(app);
    await without.signIn();
    assert.equal((await json(await without.call('/api/admin/state'))).access, null);
  } finally {
    await app.conversations.close();
  }
});

test('a development server needs no admin token, and emails are optional there', async () => {
  const app = await openHousehold(openStore(), config);
  try {
    const page = admin(app, {}, origin);
    assert.equal((await json(await page.call('/api/admin/session'))).signedIn, true);
    const added = await page.call(
      '/api/admin/people',
      { people: [{ name: 'Alex' }, { name: 'Sam' }] },
      'PUT',
    );
    assert.equal(added.status, 200);
    assert.equal((await json(await client(app, 'partner').call('/api/state'))).me.name, 'Sam');
  } finally {
    await app.conversations.close();
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

test('the admin connects iCloud; it is kept, private, and can be removed', async () => {
  const path = `${directory('admin')}/household.sqlite`;
  const icloud = fakeICloud();
  const app = await openHousehold(openStore(path), deployment, { connector: icloud.connector });
  await setUp(app.household);
  const page = admin(app);
  await page.signIn();
  const account = { username: 'family@icloud.example', password: 'abcd-efgh-ijkl-mnop' };
  try {
    assert.equal(
      (await client(app, 'owner', base).call('/api/admin/calendar', account)).status,
      401,
    );
    const wrong = await page.call('/api/admin/calendar', { ...account, password: 'nope-nope' });
    assert.equal(wrong.status, 400);
    assert.match((await json(wrong)).error, /did not accept/);
    // Without a chosen calendar: the account's calendars to choose from; nothing is saved.
    const listed = await json(await page.call('/api/admin/calendar', account));
    assert.deepEqual(
      listed.calendars.map((calendar: { name: string }) => calendar.name),
      ['Household', 'Personal'],
    );
    assert.equal((await app.db.all<Row>("SELECT key FROM settings WHERE key='icloud'")).length, 0);
    const other = { ...account, calendarUrl: 'https://caldav.icloud.com/1/calendars/other/' };
    assert.equal((await page.call('/api/admin/calendar', other)).status, 400);
    const connected = await page.call('/api/admin/calendar', {
      ...account,
      calendarUrl: listed.calendars[0].url,
    });
    assert.equal(connected.status, 200);
    const adminState = await json(await page.call('/api/admin/state'));
    assert.deepEqual(adminState.calendar, {
      status: 'connected',
      name: 'Household',
      account: account.username,
      error: null,
    });
    const personState = await json(await client(app, 'partner', base).call('/api/state'));
    assert.equal(personState.integrations.calendar, 'connected');
    for (const state of [adminState, personState])
      assert(!JSON.stringify(state).includes(account.password));
  } finally {
    await app.conversations.close();
  }
  // A restart reopens the saved connection.
  const reopened = await openHousehold(openStore(path), deployment, {
    connector: icloud.connector,
  });
  try {
    assert.deepEqual(icloud.opened, [
      'https://caldav.icloud.com/1/calendars/home/',
      'https://caldav.icloud.com/1/calendars/home/',
    ]);
    const owner = client(reopened, 'owner', base);
    assert.equal((await owner.call('/api/calendar/refresh', {})).status, 200);
    assert.equal((await json(await owner.call('/api/state'))).integrations.calendar, 'connected');
    const page = admin(reopened);
    await page.signIn();
    assert.equal((await page.call('/api/admin/calendar', undefined, 'DELETE')).status, 200);
    assert.equal(
      (await json(await owner.call('/api/state'))).integrations.calendar,
      'not-connected',
    );
    assert.equal((await json(await page.call('/api/admin/state'))).calendar.account, null);
  } finally {
    await reopened.conversations.close();
  }
});

test('only the admin sees or chooses the assistant model', async () => {
  const app = await openHousehold(openStore(), deployment);
  await setUp(app.household);
  try {
    const owner = client(app, 'owner', base);
    assert.equal((await owner.call('/api/admin/models')).status, 401);
    assert.equal((await owner.call('/api/admin/model', { id: 'gpt-6.1-sol' })).status, 401);
    // Without a ChatGPT connection there is no catalog to choose from.
    const page = admin(app);
    await page.signIn();
    assert.equal((await page.call('/api/admin/models')).status, 409);
    assert.deepEqual((await json(await page.call('/api/admin/state'))).ai, {
      connected: false,
      model: null,
    });
    assert.equal((await json(await owner.call('/api/state'))).integrations.ai, 'not-connected');
  } finally {
    await app.conversations.close();
  }
});
