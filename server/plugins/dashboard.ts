import { DateTime } from 'luxon';
import type { Plugin, PluginHost } from '../plugin.js';
import type { CalendarPlugin } from './calendar/index.js';
import type { TasksPlugin } from './tasks.js';

/**
 * The day at a glance: each person's morning and evening summary of their
 * tasks and the shared calendar, at the times they choose. It reads the other
 * plugins rather than storing anything of its own.
 */
export class DashboardPlugin implements Plugin {
  readonly id = 'dashboard';
  constructor(
    private host: PluginHost,
    private tasks: TasksPlugin,
    private calendar?: CalendarPlugin,
  ) {}
  async tick(now: Date) {
    const open = (await this.tasks.list()).filter((task) => task.status === 'open');
    const calendar = this.calendar?.service.snapshot();
    for (const user of await this.host.household.people()) {
      const preferences = await this.host.household.preferences(user.id);
      const local = DateTime.fromJSDate(now, { zone: preferences.timezone });
      const tasks = open.filter((task) => task.ownerId === user.id);
      for (const kind of ['morning', 'evening'] as const) {
        const setting = preferences[kind];
        if (!setting.enabled) continue;
        const [hour, minute] = setting.time.split(':').map(Number);
        const scheduled = local.set({ hour, minute, second: 0, millisecond: 0 });
        // A restart catches up a summary within two hours; older summaries are skipped.
        const age = local.diff(scheduled, 'minutes').minutes;
        if (age < 0 || age > 120) continue;
        const overdue = tasks.filter(
          (task) => task.dueAt && Date.parse(task.dueAt) < now.getTime(),
        ).length;
        const today = tasks.filter(
          (task) =>
            task.dueAt &&
            DateTime.fromISO(task.dueAt).setZone(preferences.timezone).hasSame(local, 'day'),
        ).length;
        const agendaDay = kind === 'morning' ? local : local.plus({ days: 1 });
        const appointments =
          calendar?.status === 'connected'
            ? calendar.events.filter((event) =>
                DateTime.fromISO(event.start, { zone: preferences.timezone })
                  .setZone(preferences.timezone)
                  .hasSame(agendaDay, 'day'),
              ).length
            : null;
        await this.host.notices.insert(this.host.db, {
          id: `summary:${user.id}:${kind}:${local.toISODate()}`,
          userId: user.id,
          title:
            kind === 'morning' ? 'Good morning. Here’s your day.' : 'A little evening check-in.',
          body: `${appointments === null ? '' : `${appointments} appointment${appointments === 1 ? '' : 's'} ${kind === 'morning' ? 'today' : 'tomorrow'} · `}${today} task${today === 1 ? '' : 's'} due today · ${overdue} overdue. Open your tasks to review what needs attention.`,
          at: now,
          pushUntil: scheduled.plus({ hours: 2 }).toJSDate(),
        });
      }
    }
  }
  /** Each person's next enabled summary time. */
  async nextWake(now: Date) {
    const times: number[] = [];
    for (const user of await this.host.household.people()) {
      const preferences = await this.host.household.preferences(user.id);
      const local = DateTime.fromJSDate(now, { zone: preferences.timezone });
      for (const kind of ['morning', 'evening'] as const) {
        const setting = preferences[kind];
        if (!setting.enabled) continue;
        const [hour, minute] = setting.time.split(':').map(Number);
        let scheduled = local.set({ hour, minute, second: 0, millisecond: 0 });
        if (scheduled.toMillis() <= now.getTime()) scheduled = scheduled.plus({ days: 1 });
        times.push(scheduled.toMillis());
      }
    }
    return times.length ? Math.min(...times) : null;
  }
}
