import type { z } from 'zod';
import type { Executor, Row, Store } from './database.js';
import { DomainError } from './errors.js';
import type { ChangeOwner } from './plugin.js';
import type { ConfirmationResult, Preview } from '../src/types.js';

/** Called in the same local transaction as a confirmed change. A retry reuses the operation ID. */
export async function notifyPartner(
  db: Executor,
  actorId: string,
  operationId: string,
  kind: string,
  targetId: string,
  label: string,
  at: string,
) {
  const actor = await db.get<Row>('SELECT name FROM users WHERE id=?', actorId);
  const action = kind.endsWith('.create')
    ? 'added'
    : kind.endsWith('.delete')
      ? 'deleted'
      : kind.endsWith('.complete')
        ? 'completed'
        : 'updated';
  const targetKind = kind.startsWith('task.') ? 'task' : 'calendar';
  for (const person of await db.all<Row>('SELECT id FROM users WHERE id<>?', actorId)) {
    const id = `change:${operationId}:${person.id}`;
    await db.run(
      'INSERT OR IGNORE INTO notices(id,user_id,title,body,created_at,push_until) VALUES (?,?,?,?,?,?)',
      id,
      String(person.id),
      `${actor?.name ?? 'Someone'} ${action} ${targetKind === 'task' ? 'a task' : 'an appointment'}`,
      label,
      at,
      // A partner-change push is useful for two hours after the change.
      new Date(Date.parse(at) + 7200_000).toISOString(),
    );
    await db.run('INSERT OR IGNORE INTO notice_targets VALUES (?,?,?)', id, targetKind, targetId);
  }
}

/** A plugin's local changes: what they mean, when they still apply, and how to apply them. */
export type ChangeHandler<Change extends { kind: string }> = {
  readonly kinds: readonly Change['kind'][];
  readonly schema: z.ZodType<Change>;
  /** Refuse a change that no longer fits current data; runs again on confirmation. */
  validate(q: Executor, change: Change, actorId: string): Promise<void>;
  describe(change: Change, actorId: string): Promise<Pick<Preview, 'title' | 'details'>>;
  /** Apply inside the confirmation transaction. `notice` labels the change for the partner. */
  apply(
    tx: Executor,
    change: Change,
    actorId: string,
    preview: Preview,
  ): Promise<{ targetId: string; notice?: string }>;
};

/**
 * The shared preview/confirm flow for changes stored in the household
 * database: a ten-minute preview bound to its actor, then one transaction that
 * re-validates, applies, audits and tells the partner. A retried confirmation
 * returns the first result instead of applying twice.
 */
export function localChanges<Change extends { kind: string }>(
  db: Store,
  clock: () => Date,
  handler: ChangeHandler<Change>,
): ChangeOwner {
  return {
    kinds: handler.kinds,
    schema: handler.schema,
    async preview(actorId, input) {
      const parsed = handler.schema.safeParse(input);
      if (!parsed.success)
        throw new DomainError(parsed.error.issues.map((issue) => issue.message).join(' '));
      const change = parsed.data;
      await handler.validate(db, change, actorId);
      const view: Preview = {
        id: crypto.randomUUID(),
        ...(await handler.describe(change, actorId)),
        expiresAt: new Date(clock().getTime() + 600_000).toISOString(),
      };
      await db.run(
        'INSERT INTO previews(id, user_id, mutation, view, expires_at) VALUES (?, ?, ?, ?, ?)',
        view.id,
        actorId,
        JSON.stringify(change),
        JSON.stringify(view),
        Date.parse(view.expiresAt),
      );
      return view;
    },
    async cancel(actorId, previewId) {
      await db.run(
        'DELETE FROM previews WHERE id=? AND user_id=? AND applied_at IS NULL',
        previewId,
        actorId,
      );
    },
    confirm(actorId, previewId) {
      return db.transaction(async (tx): Promise<ConfirmationResult> => {
        const row = await tx.get<Row>(
          'SELECT * FROM previews WHERE id=? AND user_id=?',
          previewId,
          actorId,
        );
        if (!row) throw new DomainError('This preview is unavailable. Make a new one.', 404);
        if (row.applied_at !== null) return JSON.parse(String(row.result));
        if (Number(row.expires_at) <= clock().getTime())
          throw new DomainError('This preview expired. Review a new preview.', 409);
        const change: Change = JSON.parse(String(row.mutation));
        await handler.validate(tx, change, actorId);
        const { targetId, notice } = await handler.apply(
          tx,
          change,
          actorId,
          JSON.parse(String(row.view)),
        );
        const result = { ok: true, targetId };
        const at = clock();
        await tx.run(
          'UPDATE previews SET applied_at=?, result=? WHERE id=?',
          at.getTime(),
          JSON.stringify(result),
          previewId,
        );
        await tx.run(
          'INSERT INTO audit(actor_id,kind,target_id,created_at) VALUES (?,?,?,?)',
          actorId,
          change.kind,
          targetId,
          at.toISOString(),
        );
        if (notice)
          await notifyPartner(
            tx,
            actorId,
            previewId,
            change.kind,
            targetId,
            notice,
            at.toISOString(),
          );
        return result;
      });
    },
  };
}

/** The owner of a stored preview, found by the change kind it was made for. */
export async function previewOwner(
  db: Executor,
  owners: readonly ChangeOwner[],
  actorId: string,
  previewId: string,
) {
  const row = await db.get<Row>(
    'SELECT mutation FROM previews WHERE id=? AND user_id=?',
    previewId,
    actorId,
  );
  const kind = row ? String(JSON.parse(String(row.mutation)).kind) : '';
  const owner = owners.find((item) => item.kinds.includes(kind));
  if (!owner) throw new DomainError('This preview is unavailable. Make a new one.', 404);
  return owner;
}
