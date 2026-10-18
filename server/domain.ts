import { DateTime, IANAZone } from 'luxon';
import { z } from 'zod';
import { notifyPartner } from './changes.js';
import type { Executor, Row, Store } from './database.js';
import type {
  HouseholdMutation as Mutation,
  Person,
  Preferences,
  Preview,
  Schedule,
  Task,
  TaskOccurrence,
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

const recurrenceStep = (recurrence: Schedule) =>
  recurrence.frequency === 'daily' ? { days: 1 } : { weeks: 1 };
export function recurrenceDates(dueAt: string, recurrence: Schedule, now: Date) {
  let cursor = DateTime.fromISO(dueAt, { zone: recurrence.timezone });
  const until = DateTime.fromJSDate(now);
  const elapsed: string[] = [];
  const step = recurrenceStep(recurrence);
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

/**
 * The earliest recorded occurrence that this schedule would make active again,
 * now or later. Elapsed occurrences keep their recorded outcome; only the active
 * occurrence is ever completed, so a recorded one must never become active.
 */
export function repeatedOccurrence(
  dueAt: string,
  recurrence: Schedule,
  now: Date,
  recorded: Iterable<string>,
) {
  const { current } = recurrenceDates(dueAt, recurrence, now);
  const keys = [...new Set([...recorded].map(Date.parse))]
    .filter((key) => key >= Date.parse(current))
    .sort((a, b) => a - b);
  // Continue the same calendar stepping as recurrenceDates from its active occurrence.
  let cursor = DateTime.fromISO(current, { zone: recurrence.timezone });
  for (const key of keys) {
    while (cursor.toMillis() < key) cursor = cursor.plus(recurrenceStep(recurrence));
    if (cursor.toMillis() === key) return cursor.toUTC().toISO()!;
  }
  return null;
}

export class Household {
  constructor(
    readonly db: Store,
    readonly clock: () => Date = () => new Date(),
  ) {}
  async people(q: Executor = this.db): Promise<Person[]> {
    return q.all<Person>('SELECT id, username, name FROM users ORDER BY id');
  }
  async ensureSpaces() {
    await this.db.transaction(async (tx) => {
      for (const person of await this.people(tx))
        await this.ensureSpace(
          tx,
          `assistant:${person.id}`,
          `${person.name}'s assistant`,
          'personal',
        );
      await this.ensureSpace(tx, 'household', 'household', 'household');
    });
  }
  private async ensureSpace(
    q: Executor,
    key: string,
    title: string,
    category: 'personal' | 'household',
  ) {
    if (await q.get('SELECT 1 AS found FROM thread_spaces WHERE key=?', key)) return;
    const id = crypto.randomUUID();
    await q.run(
      'INSERT INTO threads VALUES (?,?,?,?)',
      id,
      title,
      category,
      this.clock().toISOString(),
    );
    await q.run('INSERT INTO thread_spaces VALUES (?,?)', key, id);
  }
  async preferences(userId: string, q: Executor = this.db): Promise<Preferences> {
    const row = await q.get<Row>('SELECT * FROM preferences WHERE user_id=?', userId);
    if (!row) throw new DomainError('Account not found.', 404);
    return { ...JSON.parse(String(row.value)), revision: Number(row.revision) };
  }
  async tasks(q: Executor = this.db): Promise<Task[]> {
    const rows = await q.all<Row>('SELECT value FROM household_tasks ORDER BY rowid DESC');
    const recorded = await this.allRecorded(q);
    return rows.map((row) => {
      const task: Task = JSON.parse(String(row.value));
      return this.decorate(task, recorded.get(task.id) ?? []);
    });
  }
  async task(taskId: string, q: Executor = this.db): Promise<Task> {
    const row = await q.get<Row>('SELECT value FROM household_tasks WHERE id=?', taskId);
    if (!row) throw new DomainError('This task no longer exists.', 404);
    return this.decorate(JSON.parse(String(row.value)), await this.recorded(taskId, q));
  }
  /** Occurrence outcomes, newest first, including elapsed misses not yet recorded. */
  async history(taskId: string): Promise<TaskOccurrence[]> {
    const task = await this.task(taskId);
    const recorded = (
      await this.db.all<Row>(
        'SELECT due_at, outcome, completed_by, completed_at FROM task_history WHERE task_id=?',
        taskId,
      )
    ).map((row): TaskOccurrence => ({
      dueAt: String(row.due_at),
      outcome: row.outcome === 'completed' ? 'completed' : 'missed',
      completedBy: row.completed_by === null ? null : String(row.completed_by),
      completedAt: row.completed_at === null ? null : String(row.completed_at),
    }));
    const known = new Set(recorded.map((row) => Date.parse(row.dueAt!)));
    const pending = task.missedDates
      .filter((dueAt) => !known.has(Date.parse(dueAt)))
      .map((dueAt): TaskOccurrence => ({
        dueAt,
        outcome: 'missed',
        completedBy: null,
        completedAt: null,
      }));
    // A one-off task records its single completion on the task itself.
    const once: TaskOccurrence[] =
      task.status === 'completed'
        ? [
            {
              dueAt: task.dueAt,
              outcome: 'completed',
              completedBy: task.completedBy,
              completedAt: task.completedAt,
            },
          ]
        : [];
    const at = (occurrence: TaskOccurrence) =>
      Date.parse(occurrence.dueAt ?? occurrence.completedAt!);
    return [...recorded, ...pending, ...once].sort((a, b) => at(b) - at(a));
  }
  private async recorded(taskId: string, q: Executor = this.db) {
    return (
      await q.all<Row>(
        'SELECT due_at, outcome FROM task_history WHERE task_id=? ORDER BY due_at',
        taskId,
      )
    ).map((row) => ({ dueAt: String(row.due_at), outcome: String(row.outcome) }));
  }
  private async allRecorded(q: Executor) {
    const byTask = new Map<string, { dueAt: string; outcome: string }[]>();
    for (const row of await q.all<Row>(
      'SELECT task_id, due_at, outcome FROM task_history ORDER BY due_at',
    )) {
      const list = byTask.get(String(row.task_id)) ?? [];
      list.push({ dueAt: String(row.due_at), outcome: String(row.outcome) });
      byTask.set(String(row.task_id), list);
    }
    return byTask;
  }
  private decorate(task: Task, recorded: { dueAt: string; outcome: string }[]): Task {
    const historic = recorded.filter((row) => row.outcome === 'missed').map((row) => row.dueAt);
    // An elapsed date that was already completed keeps that outcome after a reschedule.
    const completed = new Set(
      recorded.filter((row) => row.outcome === 'completed').map((row) => Date.parse(row.dueAt)),
    );
    const pending =
      task.status === 'open' && task.dueAt && task.schedule
        ? recurrenceDates(task.dueAt, task.schedule, this.clock()).missed.filter(
            (dueAt) => !completed.has(Date.parse(dueAt)),
          )
        : [];
    const missedDates = [...new Set([...historic, ...pending])].sort(
      (a, b) => Date.parse(a) - Date.parse(b),
    );
    return { ...task, missedDates };
  }
  /** Reject schedules whose active occurrence would repeat a recorded outcome. */
  private async assertNewOccurrences(q: Executor, task: Task, dueAt: string, recurrence: Schedule) {
    const recorded = (await this.recorded(task.id, q)).map((row) => row.dueAt);
    // Confirming an update first records the old schedule's elapsed dates as missed.
    if (task.status === 'open' && task.schedule && task.dueAt)
      recorded.push(...recurrenceDates(task.dueAt, task.schedule, this.clock()).missed);
    const repeated = repeatedOccurrence(dueAt, recurrence, this.clock(), recorded);
    if (repeated)
      throw new DomainError(
        `This schedule would repeat the ${DateTime.fromISO(repeated, { zone: recurrence.timezone }).toFormat('d LLL yyyy, HH:mm')} occurrence, which is already in this task's history. Choose a due date after it.`,
        409,
      );
  }
  async threads(q: Executor = this.db): Promise<Thread[]> {
    return q.all<Thread>(
      `SELECT t.id,t.title,t.category,t.created_at AS createdAt,
      CASE WHEN s.key LIKE 'assistant:%' THEN substr(s.key,11) ELSE NULL END AS assistantFor
      FROM threads t LEFT JOIN thread_spaces s ON s.thread_id=t.id ORDER BY t.created_at`,
    );
  }
  private async validate(q: Executor, mutation: Mutation, actorId: string) {
    if (mutation.kind === 'task.create' || mutation.kind === 'task.update') {
      if (!(await this.people(q)).some((person) => person.id === mutation.task.ownerId))
        throw new DomainError('Choose a household member as the owner.');
      if (mutation.task.schedule && !mutation.task.dueAt)
        throw new DomainError('A recurring task needs its first due date.');
    }
    if ('id' in mutation) {
      const task = await this.task(mutation.id, q);
      if (task.revision !== mutation.revision)
        throw new DomainError('This task changed. Refresh it and review a new preview.', 409);
      if (task.status === 'completed' && mutation.kind === 'task.complete')
        throw new DomainError('This task is already complete.', 409);
      if (mutation.kind === 'task.update' && mutation.task.schedule && mutation.task.dueAt)
        await this.assertNewOccurrences(q, task, mutation.task.dueAt, mutation.task.schedule);
      if (mutation.kind === 'task.complete' && task.schedule && task.dueAt) {
        // Older data may already hold such a state; never preview a completion that cannot apply.
        const { current } = recurrenceDates(task.dueAt, task.schedule, this.clock());
        if (
          (await this.recorded(task.id, q)).some(
            (row) => Date.parse(row.dueAt) === Date.parse(current),
          )
        )
          throw new DomainError(
            "This occurrence is already in the task's history. Edit its due date to a later occurrence first.",
            409,
          );
      }
    }
    if (
      mutation.kind === 'preferences.update' &&
      mutation.revision !== (await this.preferences(actorId, q)).revision
    ) {
      throw new DomainError('Your settings changed. Review a new preview.', 409);
    }
  }
  async preview(actorId: string, input: unknown): Promise<Preview> {
    const parsed = mutationSchema.safeParse(input);
    if (!parsed.success)
      throw new DomainError(parsed.error.issues.map((issue) => issue.message).join(' '));
    const mutation: Mutation = parsed.data;
    await this.validate(this.db, mutation, actorId);
    const view: Preview = {
      id: crypto.randomUUID(),
      title: '',
      details: [],
      expiresAt: new Date(this.clock().getTime() + 600_000).toISOString(),
    };
    const detail = (label: string, after: string, before?: string) =>
      view.details.push({ label, after, ...(before !== undefined ? { before } : {}) });
    const people = await this.people();
    const personName = (userId: string) =>
      people.find((person) => person.id === userId)?.name ?? userId;
    if (mutation.kind === 'task.create' || mutation.kind === 'task.update') {
      view.title = mutation.kind === 'task.create' ? 'Create this task?' : 'Save these changes?';
      const prior = mutation.kind === 'task.update' ? await this.task(mutation.id) : undefined;
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
      const task = await this.task(mutation.id);
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
      detail('Task', (await this.task(mutation.id)).title);
      detail('Result', 'Removes the task and its history for both of you.');
    } else if (mutation.kind === 'thread.create') {
      view.title = 'Create this channel?';
      detail('Channel', mutation.title);
      detail('Space', mutation.category);
    } else {
      view.title = 'Save your summary settings?';
      const prior = await this.preferences(actorId);
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
    await this.db.run(
      'INSERT INTO previews(id, user_id, mutation, view, expires_at) VALUES (?, ?, ?, ?, ?)',
      view.id,
      actorId,
      JSON.stringify(mutation),
      JSON.stringify(view),
      Date.parse(view.expiresAt),
    );
    return view;
  }
  async cancel(actorId: string, previewId: string) {
    await this.db.run(
      'DELETE FROM previews WHERE id=? AND user_id=? AND applied_at IS NULL',
      previewId,
      actorId,
    );
  }
  confirm(actorId: string, previewId: string): Promise<{ ok: boolean; targetId: string }> {
    return this.db.transaction(async (tx) => {
      const row = await tx.get<Row>(
        'SELECT * FROM previews WHERE id=? AND user_id=?',
        previewId,
        actorId,
      );
      if (!row) throw new DomainError('This preview is unavailable. Make a new one.', 404);
      if (row.applied_at !== null) return JSON.parse(String(row.result));
      if (Number(row.expires_at) <= this.clock().getTime())
        throw new DomainError('This preview expired. Review a new preview.', 409);
      const mutation: Mutation = JSON.parse(String(row.mutation));
      await this.validate(tx, mutation, actorId);
      const changedTitle =
        mutation.kind === 'task.create' || mutation.kind === 'task.update'
          ? mutation.task.title
          : mutation.kind === 'task.complete' || mutation.kind === 'task.delete'
            ? (await this.task(mutation.id, tx)).title
            : null;
      let targetId = 'id' in mutation ? mutation.id : crypto.randomUUID();
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
        await tx.run(
          'INSERT INTO household_tasks VALUES (?, ?, ?)',
          task.id,
          JSON.stringify(task),
          task.revision,
        );
      } else if (mutation.kind === 'task.update' || mutation.kind === 'task.complete') {
        const task = await this.task(mutation.id, tx);
        if (mutation.kind === 'task.update') {
          if (task.schedule && task.dueAt) {
            for (const dueAt of recurrenceDates(task.dueAt, task.schedule, this.clock()).missed)
              await tx.run(
                "INSERT OR IGNORE INTO task_history(task_id, due_at, outcome) VALUES (?, ?, 'missed')",
                task.id,
                dueAt,
              );
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
            await tx.run(
              "INSERT OR IGNORE INTO task_history(task_id, due_at, outcome) VALUES (?, ?, 'missed')",
              task.id,
              dueAt,
            );
          await tx.run(
            "INSERT INTO task_history(task_id, due_at, outcome, completed_by, completed_at) VALUES (?, ?, 'completed', ?, ?)",
            task.id,
            dates.current,
            actorId,
            this.clock().toISOString(),
          );
          task.dueAt = dates.next;
          task.completedAt = null;
          task.completedBy = null;
        } else {
          task.status = 'completed';
          task.completedBy = actorId;
          task.completedAt = this.clock().toISOString();
        }
        task.revision += 1;
        await tx.run(
          'UPDATE household_tasks SET value=?, revision=? WHERE id=?',
          JSON.stringify(task),
          task.revision,
          task.id,
        );
      } else if (mutation.kind === 'task.delete') {
        await tx.run('DELETE FROM task_history WHERE task_id=?', mutation.id);
        await tx.run('DELETE FROM household_tasks WHERE id=?', mutation.id);
      } else if (mutation.kind === 'preferences.update') {
        targetId = actorId;
        await tx.run(
          'UPDATE preferences SET value=?, revision=revision+1 WHERE user_id=?',
          JSON.stringify(mutation.preferences),
          actorId,
        );
      } else {
        await tx.run(
          'INSERT INTO threads VALUES (?, ?, ?, ?)',
          targetId,
          mutation.title,
          mutation.category,
          this.clock().toISOString(),
        );
      }
      const result = { ok: true, targetId };
      await tx.run(
        'UPDATE previews SET applied_at=?, result=? WHERE id=?',
        this.clock().getTime(),
        JSON.stringify(result),
        previewId,
      );
      await tx.run(
        'INSERT INTO audit(actor_id,kind,target_id,created_at) VALUES (?,?,?,?)',
        actorId,
        mutation.kind,
        targetId,
        this.clock().toISOString(),
      );
      if (changedTitle)
        await notifyPartner(
          tx,
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
