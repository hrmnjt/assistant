import { DateTime, IANAZone } from 'luxon';
import { z } from 'zod';
import { localChanges } from './changes.js';
import type { Executor, Row, Store } from './database.js';
import { DomainError } from './errors.js';
import type { ChangeOwner } from './plugin.js';
import type { Person, Preferences, Thread } from '../src/types.js';

export const category = z.enum(['household', 'work', 'personal']);
export const timezone = z
  .string()
  .refine((value) => IANAZone.isValidZone(value), 'Choose a valid time zone.');
export const datetime = z
  .string()
  .datetime({ offset: true })
  .refine((value) => {
    const date = DateTime.fromISO(value);
    return date.isValid && date.year >= 2000 && date.year <= 2100;
  }, 'Choose a date between 2000 and 2100.');
const summary = z
  .object({ enabled: z.boolean(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) })
  .strict();
const settings = z.object({ timezone, morning: summary, evening: summary }).strict();
export const householdChangeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('preferences.update'),
      revision: z.number().int().positive(),
      preferences: settings,
    })
    .strict(),
  z
    .object({
      kind: z.literal('thread.create'),
      title: z.string().trim().min(1).max(120),
      category,
    })
    .strict(),
]);
type HouseholdChange = z.infer<typeof householdChangeSchema>;

export const personName = z.string().trim().min(1, 'Enter a name.').max(60);
export const email = z.string().trim().toLowerCase().email('Enter a valid email address.');
const defaultPreferences = {
  timezone: 'Asia/Dubai',
  morning: { enabled: true, time: '08:00' },
  evening: { enabled: true, time: '18:00' },
};
/** One of the two people; a development server has no sign-in, so no emails. */
export type Member = { name: string; email?: string };

/**
 * Both people from the Worker's variables (cloudflare/.dev.vars for `npm run
 * dev`). A deployment needs both names and emails; a development server only
 * the names. Missing or invalid values stop the app with a message naming them.
 */
export function configuredPeople(
  vars: Partial<Record<string, string>>,
  development: boolean,
): [Member, Member] {
  const missing: string[] = [];
  const members = ([1, 2] as const).map((n): Member => {
    const name = personName.safeParse(vars[`PERSON_${n}_NAME`] ?? '');
    const address = email.safeParse(vars[`PERSON_${n}_EMAIL`] ?? '');
    if (!name.success) missing.push(`PERSON_${n}_NAME`);
    if (!development && !address.success) missing.push(`PERSON_${n}_EMAIL`);
    return { name: name.data ?? '', email: development ? undefined : address.data };
  });
  const where = development
    ? 'in cloudflare/.dev.vars'
    : 'in the Worker’s Settings → Variables and Secrets on Cloudflare';
  if (missing.length) throw new Error(`Configure ${missing.join(', ')} ${where}.`);
  if (members[0].email && members[0].email === members[1].email)
    throw new Error(`Configure a different email for each person ${where}.`);
  return [members[0], members[1]];
}

/**
 * The core household: the two people, their settings, and the conversations
 * (each person's assistant chat and the shared channels). Features such as
 * tasks and the calendar are plugins built on it.
 */
export class Household {
  /** Settings and channel changes, through the shared preview/confirm flow. */
  readonly changes: ChangeOwner;
  constructor(
    readonly db: Store,
    readonly clock: () => Date = () => new Date(),
  ) {
    this.changes = localChanges<HouseholdChange>(db, clock, {
      kinds: ['preferences.update', 'thread.create'],
      schema: householdChangeSchema,
      validate: async (q, change, actorId) => {
        if (
          change.kind === 'preferences.update' &&
          change.revision !== (await this.preferences(actorId, q)).revision
        )
          throw new DomainError('Your settings changed. Review a new preview.', 409);
      },
      describe: async (change, actorId) => {
        if (change.kind === 'thread.create')
          return {
            title: 'Create this channel?',
            details: [
              { label: 'Channel', after: change.title },
              { label: 'Space', after: change.category },
            ],
          };
        const prior = await this.preferences(actorId);
        return {
          title: 'Save your summary settings?',
          details: [
            { label: 'Time zone', after: change.preferences.timezone, before: prior.timezone },
            ...(['morning', 'evening'] as const).map((key) => ({
              label: key === 'morning' ? 'Morning summary' : 'Evening summary',
              after: change.preferences[key].enabled ? change.preferences[key].time : 'Off',
              before: prior[key].enabled ? prior[key].time : 'Off',
            })),
          ],
        };
      },
      apply: async (tx, change, actorId) => {
        if (change.kind === 'preferences.update') {
          await tx.run(
            'UPDATE preferences SET value=?, revision=revision+1 WHERE user_id=?',
            JSON.stringify(change.preferences),
            actorId,
          );
          return { targetId: actorId };
        }
        const targetId = crypto.randomUUID();
        await tx.run(
          'INSERT INTO threads VALUES (?, ?, ?, ?)',
          targetId,
          change.title,
          change.category,
          this.clock().toISOString(),
        );
        return { targetId };
      },
    });
  }
  /** The two people: `owner` is person 1 in the Worker's variables, `partner` person 2. */
  async people(q: Executor = this.db): Promise<Person[]> {
    return q.all<Person>(
      "SELECT id, username, name FROM users WHERE id IN ('owner','partner') ORDER BY id",
    );
  }
  /**
   * Apply both people from the Worker's variables at every start, with their
   * settings and assistant chats. Each keeps their id, so a changed name or
   * email keeps their records. Names and emails are never in the repository;
   * only these two emails are recognized.
   */
  async configure([owner, partner]: readonly [Member, Member]) {
    await this.db.transaction(async (tx) => {
      // Release both emails first, so the two can swap without a conflict.
      await tx.run("UPDATE users SET username='~'||id WHERE id IN ('owner','partner')");
      for (const [id, member] of [
        ['owner', owner],
        ['partner', partner],
      ] as const) {
        await tx.run(
          'INSERT INTO users VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,name=excluded.name',
          id,
          member.email || id,
          member.name,
        );
        await tx.run(
          'INSERT OR IGNORE INTO preferences VALUES (?, ?, 1)',
          id,
          JSON.stringify(defaultPreferences),
        );
      }
      await this.spaces(tx);
    });
  }
  private async spaces(tx: Executor) {
    for (const person of await this.people(tx))
      await this.ensureSpace(
        tx,
        `assistant:${person.id}`,
        `${person.name}'s assistant`,
        'personal',
      );
    await this.ensureSpace(tx, 'household', 'household', 'household');
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
  async threads(q: Executor = this.db): Promise<Thread[]> {
    return q.all<Thread>(
      `SELECT t.id,t.title,t.category,t.created_at AS createdAt,
      CASE WHEN s.key LIKE 'assistant:%' THEN substr(s.key,11) ELSE NULL END AS assistantFor
      FROM threads t LEFT JOIN thread_spaces s ON s.thread_id=t.id ORDER BY t.created_at`,
    );
  }
}
