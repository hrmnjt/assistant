import { test as base, expect, type Page } from '@playwright/test';
import { DateTime } from 'luxon';
import type {
  Snapshot,
  Message,
  ChatStatus,
  Mutation,
  Preview,
  CalendarOutcome,
} from '../../src/types';

export function snapshot(): Snapshot {
  const date = DateTime.now().setZone('Asia/Dubai');
  return {
    me: { id: 'owner', name: 'Alex', username: 'alex@example.com' },
    people: [
      { id: 'owner', name: 'Alex', username: 'alex@example.com' },
      { id: 'partner', name: 'Sam', username: 'sam@example.com' },
    ],
    signIn: 'cloudflare-access',
    preferences: {
      revision: 1,
      timezone: 'Asia/Dubai',
      morning: { enabled: true, time: '08:00' },
      evening: { enabled: true, time: '18:00' },
    },
    previews: [],
    tasks: [
      {
        id: 'task-1',
        title: 'Water the plants',
        notes: 'Balcony and kitchen',
        ownerId: 'owner',
        category: 'household',
        dueAt: date.minus({ days: 1 }).toISO(),
        schedule: { frequency: 'daily', timezone: 'Asia/Dubai' },
        revision: 1,
        status: 'open',
        completedAt: null,
        completedBy: null,
        missedDates: [date.minus({ days: 2 }).toISO()!, date.minus({ days: 3 }).toISO()!],
      },
      {
        id: 'task-2',
        title: 'Book the car service',
        notes: '',
        ownerId: 'partner',
        category: 'household',
        dueAt: null,
        schedule: null,
        revision: 1,
        status: 'open',
        completedAt: null,
        completedBy: null,
        missedDates: [],
      },
    ],
    threads: [
      {
        id: 'assistant-owner',
        title: 'Your assistant',
        category: 'personal',
        createdAt: date.toISO()!,
        assistantFor: 'owner',
      },
      { id: 'shared', title: 'Weekend plans', category: 'household', createdAt: date.toISO()! },
    ],
    presence: [{ userId: 'partner', threadId: 'shared', typing: true }],
    notices: [
      {
        id: 'notice',
        title: 'Sam updated a task',
        body: 'Book the car service is ready to review.',
        createdAt: date.toISO()!,
        targetKind: 'task',
        targetId: 'task-2',
      },
    ],
    integrations: { ai: 'not-connected', calendar: 'connected' },
    calendar: {
      status: 'connected',
      name: 'Household',
      syncedAt: date.toISO(),
      error: null,
      months: {
        first: date.minus({ months: 1 }).toFormat('yyyy-MM'),
        last: date.plus({ months: 2 }).toFormat('yyyy-MM'),
      },
      events: [
        {
          id: 'event-1',
          uid: 'event-1',
          etag: 'v1',
          title: 'Dinner together',
          location: 'Our favourite place',
          notes: 'Bring a little room for dessert.',
          start: date.set({ hour: 19, minute: 0 }).toISO()!,
          end: date.set({ hour: 20, minute: 0 }).toISO()!,
          allDay: false,
          reminderMinutes: 30,
          recurring: false,
          readOnlyReason: null,
        },
      ],
    },
  };
}

export class HouseholdFixture {
  state = snapshot();
  signedIn = true;
  offline = false;
  /** Before the admin has added the two people. */
  notSetUp = false;
  /** The admin page's side: its sign-in and the settings the admin makes. */
  admin = {
    token: 'fixture-admin-token-0123456789-abcdefgh',
    signedIn: false,
    development: false,
    unavailable: null as string | null,
    access: 'alex@example.com' as string | null,
    accessToken: true,
    people: [
      { id: 'owner', name: 'Alex', email: 'alex@example.com' },
      { id: 'partner', name: 'Sam', email: 'sam@example.com' },
    ],
    calendar: {
      status: 'not-connected',
      name: null as string | null,
      account: null as string | null,
      error: null as string | null,
    },
    ai: { connected: true, model: null as string | null },
  };
  confirmationError = '';
  confirmationStatus = 409;
  calendarOutcome?: CalendarOutcome;
  status: ChatStatus = { running: false, error: null, previews: [] };
  messages: Record<string, Message[]> = {
    'assistant-owner': [],
    shared: [
      {
        id: 'message',
        threadId: 'shared',
        authorId: 'partner',
        text: 'Shall we make time for a walk?',
        createdAt: new Date().toISOString(),
      },
    ],
  };
  calls: { path: string; body: any; method: string }[] = [];
  proposals = new Map<string, Mutation>();

  async install(page: Page) {
    await page.route('**/api/**', async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname.slice(4);
      const body = request.postDataJSON();
      this.calls.push({ path, body, method: request.method() });
      const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
      if (path.startsWith('/admin/')) return this.adminRoute(path, request.method(), body, json);
      if (this.notSetUp)
        return json(
          {
            error:
              'The assistant isn’t set up yet: the admin adds the two of you on the admin page.',
          },
          503,
        );
      if (path === '/state')
        return this.offline
          ? json({ error: 'Offline' }, 503)
          : this.signedIn
            ? json(this.state)
            : json(
                {
                  error:
                    'Sign in through Cloudflare Access with one of the two emails set for this assistant. If Cloudflare didn’t ask for your email first, turn on Access for the Worker on Cloudflare (Settings → Domains & Routes).',
                },
                401,
              );
      if (path === '/presence' || path === '/notices/read') return json({ ok: true });
      if (path.endsWith('/assistant')) return json(this.status);
      if (path.endsWith('/messages')) {
        const threadId = path.split('/')[2];
        if (request.method() === 'POST')
          (this.messages[threadId] ??= []).push({
            id: crypto.randomUUID(),
            threadId,
            authorId: 'owner',
            text: body.text,
            createdAt: new Date().toISOString(),
          });
        return json(this.messages[threadId] ?? []);
      }
      if (path.startsWith('/tasks/') && path.endsWith('/history')) return json([]);
      if (path === '/previews') {
        if (request.method() === 'GET') return json(this.state.previews);
        // Like the server, reject proposals built from an outdated record.
        if (body.kind === 'task.update' || body.kind === 'task.delete') {
          const task = this.state.tasks.find((item) => item.id === body.id);
          if (!task) return json({ error: 'This task no longer exists.' }, 404);
          if (task.revision !== body.revision)
            return json({ error: 'This task changed. Refresh it and review a new preview.' }, 409);
        }
        if (body.kind === 'calendar.update' || body.kind === 'calendar.delete') {
          const event = this.state.calendar.events.find((item) => item.id === body.id);
          if (!event || event.etag !== body.etag)
            return json(
              { error: 'This appointment changed in iCloud. Refresh and review a new preview.' },
              409,
            );
        }
        const id = crypto.randomUUID();
        this.proposals.set(id, body);
        const preview: Preview = {
          id,
          title: 'Review household change',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          details: Object.entries(
            body.task ?? body.event ?? body.preferences ?? { Change: body.kind },
          )
            .filter(([, v]) => v !== '')
            .map(([key, value]) => ({
              label:
                (
                  {
                    title: 'Task',
                    notes: 'Notes',
                    ownerId: 'Who follows up',
                    category: 'Space',
                    dueAt: 'Due',
                    schedule: 'Repeat',
                  } as Record<string, string>
                )[key] ?? key,
              after:
                value === null
                  ? key === 'schedule'
                    ? 'Just this once'
                    : 'Not set'
                  : key === 'ownerId'
                    ? (this.state.people.find((p) => p.id === value)?.name ?? String(value))
                    : typeof value === 'object'
                      ? JSON.stringify(value)
                      : String(value),
            })),
        };
        this.state.previews.push(preview);
        return json(preview);
      }
      if (path.startsWith('/previews/')) {
        const id = path.split('/')[2],
          mutation = this.proposals.get(id)!;
        if (request.method() === 'DELETE') {
          this.state.previews = this.state.previews.filter((preview) => preview.id !== id);
          this.proposals.delete(id);
          return json({ ok: true });
        }
        if (path.endsWith('/dismiss')) {
          this.state.previews = this.state.previews.filter((preview) => preview.id !== id);
          this.proposals.delete(id);
          return json({ ok: true });
        }
        if (this.confirmationError) {
          const pending = this.state.previews.find((preview) => preview.id === id);
          if (pending && this.calendarOutcome) pending.calendarOutcome = this.calendarOutcome;
          return json(
            { error: this.confirmationError, calendarOutcome: this.calendarOutcome },
            this.confirmationStatus,
          );
        }
        if (mutation.kind === 'task.create')
          this.state.tasks.push({
            ...mutation.task,
            id,
            revision: 1,
            status: 'open',
            completedAt: null,
            completedBy: null,
            missedDates: [],
          });
        if (mutation.kind === 'task.complete')
          this.state.tasks.find((t) => t.id === mutation.id)!.status = 'completed';
        if (mutation.kind === 'preferences.update')
          this.state.preferences = {
            ...mutation.preferences,
            revision: this.state.preferences.revision + 1,
          };
        if (mutation.kind === 'thread.create')
          this.state.threads.push({
            id,
            title: mutation.title,
            category: mutation.category,
            createdAt: new Date().toISOString(),
          });
        this.state.previews = this.state.previews.filter((preview) => preview.id !== id);
        return json({ ok: true, targetId: id });
      }
      if (path === '/calendar/refresh') return json(this.state.calendar);
      return json({ error: 'Unhandled fixture request: ' + path }, 500);
    });
  }

  private adminRoute(
    path: string,
    method: string,
    body: any,
    json: (value: unknown, status?: number) => Promise<void>,
  ) {
    const admin = this.admin;
    if (path === '/admin/session') {
      if (method === 'GET')
        return json({
          signedIn: admin.signedIn,
          development: admin.development,
          unavailable: admin.unavailable,
        });
      if (method === 'DELETE') {
        admin.signedIn = false;
        return json({ ok: true });
      }
      if (body.token !== admin.token) return json({ error: 'That admin token is not right.' }, 401);
      admin.signedIn = true;
      return json({ ok: true });
    }
    if (!admin.signedIn) return json({ error: 'Sign in as the admin first.' }, 401);
    if (path === '/admin/state')
      return json({
        people: admin.people,
        access: admin.access,
        accessToken: admin.accessToken,
        ai: admin.ai,
        calendar: admin.calendar,
      });
    if (path === '/admin/people') {
      const [first, second] = body.people;
      if (first.email === second.email)
        return json({ error: 'Use a different email for each person.' }, 400);
      admin.people = admin.people.map((person, index) => ({ ...person, ...body.people[index] }));
      return json({ ok: true });
    }
    if (path === '/admin/calendar' && method === 'DELETE') {
      admin.calendar = { status: 'not-connected', name: null, account: null, error: null };
      return json({ ok: true });
    }
    if (path === '/admin/calendar') {
      if (body.password !== 'abcd-efgh-ijkl-mnop')
        return json(
          {
            error:
              'iCloud did not accept that Apple ID and app-specific password, or could not be reached. Check them and try again.',
          },
          400,
        );
      const calendars = [
        { name: 'Personal', url: 'https://caldav.icloud.com/1/calendars/mine/' },
        { name: 'Household', url: 'https://caldav.icloud.com/1/calendars/home/' },
      ];
      if (!body.calendarUrl) return json({ calendars });
      const chosen = calendars.find((calendar) => calendar.url === body.calendarUrl)!;
      admin.calendar = {
        status: 'connected',
        name: chosen.name,
        account: body.username,
        error: null,
      };
      return json({ ok: true });
    }
    if (path === '/admin/chatgpt/start')
      return json({
        url: 'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=fixture-state',
      });
    if (path === '/admin/chatgpt/finish') {
      if (!body.address.includes('state=fixture-state'))
        return json(
          { error: 'That address is not from this sign-in. Start again to try once more.' },
          400,
        );
      admin.ai = { connected: true, model: null };
      return json({ ok: true });
    }
    if (path === '/admin/chatgpt' && method === 'DELETE') {
      admin.ai = { connected: false, model: null };
      return json({ ok: true });
    }
    if (path === '/admin/models')
      return json({
        current: admin.ai.model,
        models: [
          { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
          { id: 'gpt-6.1-mini', name: 'GPT-6.1 Mini' },
        ],
      });
    if (path === '/admin/model') {
      admin.ai.model = body.id;
      return json({ ok: true });
    }
    return json({ error: 'Unhandled fixture request: ' + path }, 500);
  }
}

export const test = base.extend<{ household: HouseholdFixture }>({
  household: [
    async ({ page }, use) => {
      const household = new HouseholdFixture();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await household.install(page);
      await use(household);
      expect(errors, 'No uncaught browser errors').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

/** Open a view the way a person would: the panel's tabs, else the sidebar (or the phone menu). */
export async function navigate(page: Page, name: 'Today' | 'Tasks' | 'Calendar' | 'Settings') {
  const tabs = page.getByRole('group', { name: 'Views' });
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const menu = page.getByRole('button', { name: 'Open menu' });
  const back = page.getByRole('button', { name: 'Back to chat' });
  // Wait for the app to show one of its ways in.
  await expect(nav.or(menu).or(tabs).or(back).first()).toBeVisible();
  if (name !== 'Settings' && (await tabs.isVisible())) {
    await tabs.getByRole('button', { name, exact: true }).click();
    return;
  }
  if (!(await nav.isVisible())) {
    if (await back.isVisible()) await back.click();
    await menu.click();
  }
  await nav.getByRole('button', { name, exact: true }).click();
}
