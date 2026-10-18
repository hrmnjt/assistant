import { DateTime } from 'luxon';
import { z } from 'zod';
import { defineExtension, section } from '@earendil-works/pi-durable';
import { localChanges } from '../changes.js';
import type { Executor, Row } from '../database.js';
import { DomainError } from '../errors.js';
import { category, datetime, timezone } from '../household.js';
import { json } from '../http.js';
import type { Plugin, PluginHost } from '../plugin.js';
import type { Person, Preview, Schedule, Task, TaskOccurrence } from '../../src/types.js';

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
export const taskChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task.create'), task: taskFields }).strict(),
  z.object({ kind: z.literal('task.update'), id, revision, task: taskFields }).strict(),
  z.object({ kind: z.literal('task.complete'), id, revision }).strict(),
  z.object({ kind: z.literal('task.delete'), id, revision }).strict(),
]);
type TaskChange = z.infer<typeof taskChangeSchema>;
type Recorded = { dueAt: string; outcome: string };

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

const utc = (value: string | null) => (value ? DateTime.fromISO(value).toUTC().toISO()! : null);

/**
 * Tasks: one follow-up owner each, either spouse can complete them, and
 * daily/weekly chores keep every occurrence's outcome. Deadline notices go to
 * the owner.
 */
export class TasksPlugin implements Plugin {
  readonly id = 'tasks';
  readonly changes;
  readonly extension;
  readonly notices = {
    prefixes: ['task:'],
    status: async (notice: Row) =>
      (await this.deadlineCurrent(String(notice.id), String(notice.user_id))) ? 'send' : 'inbox',
  } as const;
  readonly routes = [
    {
      method: 'GET',
      path: /^\/api\/tasks\/([^/]+)\/history$/,
      handle: async (_request: Request, _me: Person, [taskId]: string[]) =>
        json(await this.history(taskId)),
    },
  ];
  private db;
  private clock;
  constructor(private host: PluginHost) {
    this.db = host.db;
    this.clock = host.clock;
    this.changes = localChanges<TaskChange>(host.db, host.clock, {
      kinds: ['task.create', 'task.update', 'task.complete', 'task.delete'],
      schema: taskChangeSchema,
      validate: (q, change) => this.validate(q, change),
      describe: (change, actorId) => this.describe(change, actorId),
      apply: (tx, change, actorId, preview) => this.apply(tx, change, actorId, preview),
    });
    const kit = host.assistant;
    this.extension = defineExtension({
      name: 'tasks',
      tools: [
        kit.read(
          'read_tasks',
          'Read the household tasks with their IDs, revisions, owners, due dates, schedules and missed occurrences.',
          async () => ({ now: this.clock().toISOString(), tasks: await this.list() }),
        ),
        kit.prepare(
          'prepare_task_change',
          'Prepare creating, updating, completing or deleting one task.',
          this.changes,
        ),
      ],
      sections: [
        section(
          'tasks',
          () =>
            `Tasks: one person owns each follow-up and either spouse can complete it. Read tasks with read_tasks before preparing a change with prepare_task_change. Daily/weekly tasks preserve local wall-clock time.`,
          { tag: false },
        ),
      ],
    });
  }
  async list(q: Executor = this.db): Promise<Task[]> {
    const rows = await q.all<Row>('SELECT value FROM household_tasks ORDER BY rowid DESC');
    const recorded = await this.allRecorded(q);
    return rows.map((row) => {
      const task: Task = JSON.parse(String(row.value));
      return this.decorate(task, recorded.get(task.id) ?? []);
    });
  }
  async get(taskId: string, q: Executor = this.db): Promise<Task> {
    const row = await q.get<Row>('SELECT value FROM household_tasks WHERE id=?', taskId);
    if (!row) throw new DomainError('This task no longer exists.', 404);
    return this.decorate(JSON.parse(String(row.value)), await this.recorded(taskId, q));
  }
  /** Occurrence outcomes, newest first, including elapsed misses not yet recorded. */
  async history(taskId: string): Promise<TaskOccurrence[]> {
    const task = await this.get(taskId);
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
  async snapshot() {
    return { tasks: await this.list() };
  }
  /** Plan a deadline notice for each owner whose open task is due. */
  async tick(now: Date) {
    const open = (await this.list()).filter((task) => task.status === 'open');
    for (const task of open) {
      if (!task.dueAt || Date.parse(task.dueAt) > now.getTime()) continue;
      const preferences = await this.host.household.preferences(task.ownerId).catch(() => null);
      if (!preferences) continue;
      const due = DateTime.fromISO(task.dueAt).setZone(preferences.timezone);
      await this.db.transaction(async (tx) => {
        const noticeId = `task:${task.id}:${task.dueAt}:${task.ownerId}`;
        await this.host.notices.insert(tx, {
          id: noticeId,
          userId: task.ownerId,
          title: task.title,
          body: `Due ${due.toFormat('d LLL, HH:mm')}${task.missedDates.length ? ` · Missed ${task.missedDates.length} times` : ''}`,
          at: now,
          // An overdue task stays in Updates, but is pushed only near its original deadline.
          pushUntil: due.plus({ hours: 2 }).toJSDate(),
        });
        await tx.run(
          'INSERT OR IGNORE INTO task_notice_deadlines VALUES (?,?,?,?)',
          noticeId,
          task.id,
          task.dueAt,
          task.ownerId,
        );
        await tx.run("INSERT OR IGNORE INTO notice_targets VALUES (?,'task',?)", noticeId, task.id);
      });
    }
  }
  async nextWake(now: Date) {
    const upcoming = (await this.list())
      .filter(
        (task) => task.status === 'open' && task.dueAt && Date.parse(task.dueAt) > now.getTime(),
      )
      .map((task) => Date.parse(task.dueAt!));
    return upcoming.length ? Math.min(...upcoming) : null;
  }
  private async deadlineCurrent(noticeId: string, recipientId: string) {
    const deadline = await this.db.get<Row>(
      'SELECT * FROM task_notice_deadlines WHERE notice_id=?',
      noticeId,
    );
    // Legacy notices lack reliable occurrence metadata: retain the inbox record,
    // but fail closed instead of guessing a task/deadline by parsing its label.
    if (!deadline || deadline.owner_id !== recipientId) return false;
    try {
      const task = await this.get(String(deadline.task_id));
      return (
        task.status === 'open' &&
        task.ownerId === recipientId &&
        task.dueAt === deadline.due_at &&
        Date.parse(task.dueAt!) <= this.clock().getTime()
      );
    } catch (error) {
      if (error instanceof DomainError && error.status === 404) return false;
      throw error;
    }
  }
  private async recorded(taskId: string, q: Executor = this.db): Promise<Recorded[]> {
    return (
      await q.all<Row>(
        'SELECT due_at, outcome FROM task_history WHERE task_id=? ORDER BY due_at',
        taskId,
      )
    ).map((row) => ({ dueAt: String(row.due_at), outcome: String(row.outcome) }));
  }
  private async allRecorded(q: Executor) {
    const byTask = new Map<string, Recorded[]>();
    for (const row of await q.all<Row>(
      'SELECT task_id, due_at, outcome FROM task_history ORDER BY due_at',
    )) {
      const list = byTask.get(String(row.task_id)) ?? [];
      list.push({ dueAt: String(row.due_at), outcome: String(row.outcome) });
      byTask.set(String(row.task_id), list);
    }
    return byTask;
  }
  private decorate(task: Task, recorded: Recorded[]): Task {
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
  private async validate(q: Executor, change: TaskChange) {
    if (change.kind === 'task.create' || change.kind === 'task.update') {
      if (
        !(await this.host.household.people(q)).some((person) => person.id === change.task.ownerId)
      )
        throw new DomainError('Choose a household member as the owner.');
      if (change.task.schedule && !change.task.dueAt)
        throw new DomainError('A recurring task needs its first due date.');
    }
    if (change.kind === 'task.create') return;
    const task = await this.get(change.id, q);
    if (task.revision !== change.revision)
      throw new DomainError('This task changed. Refresh it and review a new preview.', 409);
    if (task.status === 'completed' && change.kind === 'task.complete')
      throw new DomainError('This task is already complete.', 409);
    if (change.kind === 'task.update' && change.task.schedule && change.task.dueAt)
      await this.assertNewOccurrences(q, task, change.task.dueAt, change.task.schedule);
    if (change.kind === 'task.complete' && task.schedule && task.dueAt) {
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
  private async describe(change: TaskChange, actorId: string) {
    const details: Preview['details'] = [];
    const detail = (label: string, after: string, before?: string) =>
      details.push({ label, after, ...(before !== undefined ? { before } : {}) });
    const people = await this.host.household.people();
    const personName = (userId: string) =>
      people.find((person) => person.id === userId)?.name ?? userId;
    if (change.kind === 'task.create' || change.kind === 'task.update') {
      const prior = change.kind === 'task.update' ? await this.get(change.id) : undefined;
      detail('Task', change.task.title, prior?.title);
      detail(
        'Follow-up owner',
        personName(change.task.ownerId),
        prior && personName(prior.ownerId),
      );
      detail('Space', change.task.category, prior?.category);
      detail(
        'Due',
        change.task.dueAt ?? 'No deadline',
        prior ? (prior.dueAt ?? 'No deadline') : undefined,
      );
      const repeats = (value: Schedule | null) =>
        value ? `${value.frequency} (${value.timezone})` : 'Once';
      detail('Repeats', repeats(change.task.schedule), prior ? repeats(prior.schedule) : undefined);
      detail('Notes', change.task.notes || 'None', prior ? prior.notes || 'None' : undefined);
      return {
        title: change.kind === 'task.create' ? 'Create this task?' : 'Save these changes?',
        details,
      };
    }
    const task = await this.get(change.id);
    if (change.kind === 'task.delete') {
      detail('Task', task.title);
      detail('Result', 'Removes the task and its history for both of you.');
      return { title: 'Delete this task?', details };
    }
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
    return { title: 'Mark this task complete?', details };
  }
  private async apply(tx: Executor, change: TaskChange, actorId: string, preview: Preview) {
    if (change.kind === 'task.create') {
      const task: Task = {
        ...change.task,
        id: crypto.randomUUID(),
        dueAt: utc(change.task.dueAt),
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
      return { targetId: task.id, notice: task.title };
    }
    const task = await this.get(change.id, tx);
    if (change.kind === 'task.delete') {
      await tx.run('DELETE FROM task_history WHERE task_id=?', change.id);
      await tx.run('DELETE FROM household_tasks WHERE id=?', change.id);
      return { targetId: change.id, notice: task.title };
    }
    const missed = async (dates: string[]) => {
      for (const dueAt of dates)
        await tx.run(
          "INSERT OR IGNORE INTO task_history(task_id, due_at, outcome) VALUES (?, ?, 'missed')",
          task.id,
          dueAt,
        );
    };
    if (change.kind === 'task.update') {
      if (task.schedule && task.dueAt)
        await missed(recurrenceDates(task.dueAt, task.schedule, this.clock()).missed);
      Object.assign(task, change.task, { dueAt: utc(change.task.dueAt) });
    } else if (task.schedule && task.dueAt) {
      const dates = recurrenceDates(task.dueAt, task.schedule, this.clock());
      if (preview.details.find((detail) => detail.label === 'Next due')?.after !== dates.next)
        throw new DomainError('The recurring schedule advanced. Review a new preview.', 409);
      await missed(dates.missed);
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
    return { targetId: task.id, notice: task.title };
  }
}
