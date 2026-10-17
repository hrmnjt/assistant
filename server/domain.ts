import { randomUUID } from 'node:crypto';
import { DateTime, IANAZone } from 'luxon';
import { z } from 'zod';
import { notifyPartner } from './changes.js';
import type { Database } from './database.js';
import type {
  HouseholdMutation as Mutation,
  Person,
  Preferences,
  Preview,
  Schedule,
  Task,
  Thread,
} from '../src/types.js';

export class DomainError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
const category = z.enum(['household', 'work', 'personal']);
const timezone = z
  .string()
  .refine((value) => IANAZone.isValidZone(value), 'Choose a valid time zone.');
const datetime = z
  .string()
  .datetime({ offset: true })
  .refine((value) => {
    const date = DateTime.fromISO(value);
    return date.isValid && date.year >= 2000 && date.year <= 2100;
  }, 'Choose a date between 2000 and 2100.');
const schedule = z
  .object({ frequency: z.enum(['daily', 'weekly']), timezone })
  .strict()
  .nullable();
const taskFields = z
  .object({
    title: z.string().trim().min(1).max(200),
    notes: z.string().max(5000),
    category,
    ownerId: z.string().min(1).max(100),
    dueAt: datetime.nullable(),
    schedule,
  })
  .strict();
const revision = z.number().int().positive();
const id = z.string().uuid();
const summary = z
  .object({ enabled: z.boolean(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) })
  .strict();
const settings = z.object({ timezone, morning: summary, evening: summary }).strict();
export const mutationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task.create'), task: taskFields }).strict(),
  z.object({ kind: z.literal('task.update'), id, revision, task: taskFields }).strict(),
  z.object({ kind: z.literal('task.complete'), id, revision }).strict(),
  z.object({ kind: z.literal('task.delete'), id, revision }).strict(),
  z.object({ kind: z.literal('preferences.update'), revision, preferences: settings }).strict(),
  z
    .object({
      kind: z.literal('thread.create'),
      title: z.string().trim().min(1).max(120),
      category,
    })
    .strict(),
]);

export function recurrenceDates(dueAt: string, recurrence: Schedule, now: Date) {
  let cursor = DateTime.fromISO(dueAt, { zone: recurrence.timezone });
  const until = DateTime.fromJSDate(now);
  const elapsed: string[] = [];
  const step = recurrence.frequency === 'daily' ? { days: 1 } : { weeks: 1 };
  // Calendar arithmetic preserves local wall-clock time across daylight-saving changes.
  while (cursor.plus(step) <= until) {
    elapsed.push(cursor.toUTC().toISO()!);
    cursor = cursor.plus(step);
  }
  return {
    missed: elapsed,
    current: cursor.toUTC().toISO()!,
    next: cursor.plus(step).toUTC().toISO()!,
  };
}

export class Household {
  constructor(
    readonly db: Database,
    readonly clock: () => Date = () => new Date(),
  ) {}
  people(): Person[] {
    return this.db.sql
      .prepare('SELECT id, username, name FROM users ORDER BY id')
      .all() as unknown as Person[];
  }
  ensureSpaces() {
    this.db.transaction(() => {
      for (const person of this.people())
        this.ensureSpace(`assistant:${person.id}`, `${person.name}'s assistant`, 'personal');
      this.ensureSpace('household', 'household', 'household');
    });
  }
  private ensureSpace(key: string, title: string, category: 'personal' | 'household') {
    if (this.db.sql.prepare('SELECT 1 FROM thread_spaces WHERE key=?').get(key)) return;
    const id = randomUUID();
    this.db.sql
      .prepare('INSERT INTO threads VALUES (?,?,?,?)')
      .run(id, title, category, this.clock().toISOString());
    this.db.sql.prepare('INSERT INTO thread_spaces VALUES (?,?)').run(key, id);
  }
  preferences(userId: string): Preferences {
    const row = this.db.sql.prepare('SELECT * FROM preferences WHERE user_id=?').get(userId);
    if (!row) throw new DomainError('Account not found.', 404);
    return { ...JSON.parse(String(row.value)), revision: Number(row.revision) };
  }
  tasks(): Task[] {
    return this.db.sql
      .prepare('SELECT value, revision FROM tasks ORDER BY rowid DESC')
      .all()
      .map((row) => this.decorate(JSON.parse(String(row.value))));
  }
  task(taskId: string): Task {
    const row = this.db.sql.prepare('SELECT value FROM tasks WHERE id=?').get(taskId);
    if (!row) throw new DomainError('This task no longer exists.', 404);
    return this.decorate(JSON.parse(String(row.value)));
  }
  private decorate(task: Task): Task {
    const historic = this.db.sql
      .prepare(
        "SELECT due_at FROM task_history WHERE task_id=? AND outcome='missed' ORDER BY due_at",
      )
      .all(task.id)
      .map((row) => String(row.due_at));
    const pending =
      task.status === 'open' && task.dueAt && task.schedule
        ? recurrenceDates(task.dueAt, task.schedule, this.clock()).missed
        : [];
    return { ...task, missedDates: [...new Set([...historic, ...pending])] };
  }
  threads(): Thread[] {
    return this.db.sql
      .prepare(
        `SELECT t.id,t.title,t.category,t.created_at AS createdAt,
        CASE WHEN s.key LIKE 'assistant:%' THEN substr(s.key,11) ELSE NULL END AS assistantFor
        FROM threads t LEFT JOIN thread_spaces s ON s.thread_id=t.id ORDER BY t.created_at`,
      )
      .all() as unknown as Thread[];
  }
  private validate(mutation: Mutation, actorId: string) {
    if (mutation.kind === 'task.create' || mutation.kind === 'task.update') {
      if (!this.people().some((person) => person.id === mutation.task.ownerId))
        throw new DomainError('Choose a household member as the owner.');
      if (mutation.task.schedule && !mutation.task.dueAt)
        throw new DomainError('A recurring task needs its first due date.');
    }
    if ('id' in mutation) {
      const task = this.task(mutation.id);
      if (task.revision !== mutation.revision)
        throw new DomainError('This task changed. Refresh it and review a new preview.', 409);
      if (task.status === 'completed' && mutation.kind === 'task.complete')
        throw new DomainError('This task is already complete.', 409);
    }
    if (
      mutation.kind === 'preferences.update' &&
      mutation.revision !== this.preferences(actorId).revision
    ) {
      throw new DomainError('Your settings changed. Review a new preview.', 409);
    }
  }
  preview(actorId: string, input: unknown): Preview {
    const parsed = mutationSchema.safeParse(input);
    if (!parsed.success)
      throw new DomainError(parsed.error.issues.map((issue) => issue.message).join(' '));
    const mutation: Mutation = parsed.data;
    this.validate(mutation, actorId);
    const view: Preview = {
      id: randomUUID(),
      title: '',
      details: [],
      expiresAt: new Date(this.clock().getTime() + 600_000).toISOString(),
    };
    const detail = (label: string, after: string, before?: string) =>
      view.details.push({ label, after, ...(before !== undefined ? { before } : {}) });
    const personName = (userId: string) =>
      this.people().find((person) => person.id === userId)?.name ?? userId;
    if (mutation.kind === 'task.create' || mutation.kind === 'task.update') {
      view.title = mutation.kind === 'task.create' ? 'Create this task?' : 'Save these changes?';
      const prior = mutation.kind === 'task.update' ? this.task(mutation.id) : undefined;
      detail('Task', mutation.task.title, prior?.title);
      detail(
        'Follow-up owner',
        personName(mutation.task.ownerId),
        prior && personName(prior.ownerId),
      );
      detail('Space', mutation.task.category, prior?.category);
      detail(
        'Due',
        mutation.task.dueAt ?? 'No deadline',
        prior ? (prior.dueAt ?? 'No deadline') : undefined,
      );
      detail(
        'Repeats',
        mutation.task.schedule
          ? `${mutation.task.schedule.frequency} (${mutation.task.schedule.timezone})`
          : 'Once',
        prior
          ? prior.schedule
            ? `${prior.schedule.frequency} (${prior.schedule.timezone})`
            : 'Once'
          : undefined,
      );
      detail('Notes', mutation.task.notes || 'None', prior ? prior.notes || 'None' : undefined);
    } else if (mutation.kind === 'task.complete') {
      const task = this.task(mutation.id);
      view.title = 'Mark this task complete?';
      detail('Task', task.title);
      detail('Completed by', personName(actorId));
      if (task.schedule && task.dueAt) {
        const future = recurrenceDates(task.dueAt, task.schedule, this.clock());
        detail('Next due', future.next);
        detail(
          'Missed history',
          `${task.missedDates.length} missed occurrences will remain in history`,
        );
      }
    } else if (mutation.kind === 'task.delete') {
      view.title = 'Delete this task?';
      detail('Task', this.task(mutation.id).title);
      detail('Result', 'Removes the task and its history for both of you.');
    } else if (mutation.kind === 'thread.create') {
      view.title = 'Create this channel?';
      detail('Channel', mutation.title);
      detail('Space', mutation.category);
    } else {
      view.title = 'Save your summary settings?';
      const prior = this.preferences(actorId);
      detail('Time zone', mutation.preferences.timezone, prior.timezone);
      for (const key of ['morning', 'evening'] as const) {
        const value = mutation.preferences[key];
        const old = prior[key];
        detail(
          key === 'morning' ? 'Morning summary' : 'Evening summary',
          value.enabled ? value.time : 'Off',
          old.enabled ? old.time : 'Off',
        );
      }
    }
    this.db.sql
      .prepare(
        'INSERT INTO previews(id, user_id, mutation, view, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        view.id,
        actorId,
        JSON.stringify(mutation),
        JSON.stringify(view),
        Date.parse(view.expiresAt),
      );
    return view;
  }
  cancel(actorId: string, previewId: string) {
    this.db.sql
      .prepare('DELETE FROM previews WHERE id=? AND user_id=? AND applied_at IS NULL')
      .run(previewId, actorId);
  }
  confirm(actorId: string, previewId: string) {
    return this.db.transaction(() => {
      const row = this.db.sql
        .prepare('SELECT * FROM previews WHERE id=? AND user_id=?')
        .get(previewId, actorId);
      if (!row) throw new DomainError('This preview is unavailable. Make a new one.', 404);
      if (row.applied_at !== null) return JSON.parse(String(row.result));
      if (Number(row.expires_at) <= this.clock().getTime())
        throw new DomainError('This preview expired. Review a new preview.', 409);
      const mutation: Mutation = JSON.parse(String(row.mutation));
      this.validate(mutation, actorId);
      const changedTitle =
        mutation.kind === 'task.create' || mutation.kind === 'task.update'
          ? mutation.task.title
          : mutation.kind === 'task.complete' || mutation.kind === 'task.delete'
            ? this.task(mutation.id).title
            : null;
      let targetId = 'id' in mutation ? mutation.id : randomUUID();
      if (mutation.kind === 'task.create') {
        const task: Task = {
          ...mutation.task,
          id: targetId,
          dueAt: mutation.task.dueAt
            ? DateTime.fromISO(mutation.task.dueAt).toUTC().toISO()!
            : null,
          status: 'open',
          revision: 1,
          completedBy: null,
          completedAt: null,
          missedDates: [],
        };
        this.db.sql
          .prepare('INSERT INTO tasks VALUES (?, ?, ?)')
          .run(task.id, JSON.stringify(task), task.revision);
      } else if (mutation.kind === 'task.update' || mutation.kind === 'task.complete') {
        const task = this.task(mutation.id);
        if (mutation.kind === 'task.update') {
          if (task.schedule && task.dueAt) {
            for (const dueAt of recurrenceDates(task.dueAt, task.schedule, this.clock()).missed) {
              this.db.sql
                .prepare('INSERT OR IGNORE INTO task_history VALUES (?, ?, ?, NULL)')
                .run(task.id, dueAt, 'missed');
            }
          }
          Object.assign(task, mutation.task, {
            dueAt: mutation.task.dueAt
              ? DateTime.fromISO(mutation.task.dueAt).toUTC().toISO()!
              : null,
          });
        } else if (task.schedule && task.dueAt) {
          const dates = recurrenceDates(task.dueAt, task.schedule, this.clock());
          const preview: Preview = JSON.parse(String(row.view));
          if (preview.details.find((detail) => detail.label === 'Next due')?.after !== dates.next) {
            throw new DomainError('The recurring schedule advanced. Review a new preview.', 409);
          }
          for (const dueAt of dates.missed)
            this.db.sql
              .prepare('INSERT OR IGNORE INTO task_history VALUES (?, ?, ?, NULL)')
              .run(task.id, dueAt, 'missed');
          this.db.sql
            .prepare('INSERT INTO task_history VALUES (?, ?, ?, ?)')
            .run(task.id, dates.current, 'completed', actorId);
          task.dueAt = dates.next;
          task.completedAt = null;
          task.completedBy = null;
        } else {
          task.status = 'completed';
          task.completedBy = actorId;
          task.completedAt = this.clock().toISOString();
        }
        task.revision += 1;
        this.db.sql
          .prepare('UPDATE tasks SET value=?, revision=? WHERE id=?')
          .run(JSON.stringify(task), task.revision, task.id);
      } else if (mutation.kind === 'task.delete') {
        this.db.sql.prepare('DELETE FROM task_history WHERE task_id=?').run(mutation.id);
        this.db.sql.prepare('DELETE FROM tasks WHERE id=?').run(mutation.id);
      } else if (mutation.kind === 'preferences.update') {
        targetId = actorId;
        this.db.sql
          .prepare('UPDATE preferences SET value=?, revision=revision+1 WHERE user_id=?')
          .run(JSON.stringify(mutation.preferences), actorId);
      } else {
        this.db.sql
          .prepare('INSERT INTO threads VALUES (?, ?, ?, ?)')
          .run(targetId, mutation.title, mutation.category, this.clock().toISOString());
      }
      const result = { ok: true, targetId };
      this.db.sql
        .prepare('UPDATE previews SET applied_at=?, result=? WHERE id=?')
        .run(this.clock().getTime(), JSON.stringify(result), previewId);
      this.db.sql
        .prepare('INSERT INTO audit(actor_id,kind,target_id,created_at) VALUES (?,?,?,?)')
        .run(actorId, mutation.kind, targetId, this.clock().toISOString());
      if (changedTitle)
        notifyPartner(
          this.db,
          actorId,
          previewId,
          mutation.kind,
          targetId,
          changedTitle,
          this.clock().toISOString(),
        );
      return result;
    });
  }
}
