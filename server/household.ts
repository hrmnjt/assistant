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
/** One of the two people at setup; a development server may leave emails out. */
export type Member = { name: string; email?: string };

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
  /** The two people once the household is set up: `owner` set it up, `partner` is the other. */
  async people(q: Executor = this.db): Promise<Person[]> {
    if (!(await this.setUpAt(q))) return [];
    return q.all<Person>('SELECT id, username, name FROM users ORDER BY id');
  }
  /** When the household was set up, or null before its first sign-in. */
  async setUpAt(q: Executor = this.db) {
    const row = await q.get<Row>("SELECT value FROM settings WHERE key='setup'");
    return row ? String(row.value) : null;
  }
  /**
   * First sign-in: the person setting up and the other person, with their
   * settings and assistant chats. Names and emails live only in this database;
   * afterwards only these two emails are recognized.
   */
  async setUp(owner: Member, partner: Member) {
    if (owner.email && owner.email === partner.email)
      throw new DomainError('Use a different email address for each of you.');
    await this.db.transaction(async (tx) => {
      if (await this.setUpAt(tx)) throw new DomainError('This household is already set up.', 409);
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
      await tx.run("INSERT INTO settings VALUES ('setup', ?)", this.clock().toISOString());
      await this.spaces(tx);
    });
  }
  async rename(personId: string, name: string) {
    await this.db.run('UPDATE users SET name=? WHERE id=?', personName.parse(name), personId);
  }
  /** Correct the other person's email; the person who set up keeps the one they signed in with. */
  async changeEmail(personId: 'partner', address: string) {
    const value = email.parse(address);
    await this.db.transaction(async (tx) => {
      if (await tx.get('SELECT 1 AS found FROM users WHERE username=? AND id<>?', value, personId))
        throw new DomainError('Use a different email address for each of you.');
      await tx.run('UPDATE users SET username=? WHERE id=?', value, personId);
    });
  }
  async ensureSpaces() {
    await this.db.transaction((tx) => this.spaces(tx));
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
