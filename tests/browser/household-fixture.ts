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
    me: { id: 'owner', name: 'Alex', username: 'owner' },
    people: [
      { id: 'owner', name: 'Alex', username: 'owner' },
      { id: 'partner', name: 'Sam', username: 'partner' },
    ],
    preferences: {
      revision: 1,
      timezone: 'Asia/Dubai',
      morning: { enabled: true, time: '08:00' },
      evening: { enabled: true, time: '18:00' },
    },
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
  confirmationError = '';
  confirmationStatus = 409;
  calendarOutcome?: CalendarOutcome;
  loginError = '';
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
      if (path === '/state')
        return this.offline
          ? json({ error: 'Offline' }, 503)
          : this.signedIn
            ? json(this.state)
            : json({ error: 'Sign in' }, 401);
      if (path === '/login') {
        if (this.loginError) return json({ error: this.loginError }, 401);
        this.signedIn = true;
        return json({ ok: true });
      }
      if (path === '/logout') {
        this.signedIn = false;
        return json({ ok: true });
      }
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
      if (path === '/previews') {
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
                    ownerId: 'Follow-up owner',
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
        return json(preview);
      }
      if (path.startsWith('/previews/')) {
        const id = path.split('/')[2],
          mutation = this.proposals.get(id)!;
        if (request.method() === 'DELETE') {
          this.proposals.delete(id);
          return json({ ok: true });
        }
        if (path.endsWith('/dismiss')) {
          this.proposals.delete(id);
          return json({ ok: true });
        }
        if (this.confirmationError)
          return json(
            { error: this.confirmationError, calendarOutcome: this.calendarOutcome },
            this.confirmationStatus,
          );
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
        return json({ targetId: id });
      }
      if (path === '/calendar/refresh') return json(this.state.calendar);
      return json({ error: 'Unhandled fixture request: ' + path }, 500);
    });
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
