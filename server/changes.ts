import type { Database } from './database.js';

/** Called in the same local transaction as a confirmed change. A retry reuses the operation ID. */
export function notifyPartner(
  db: Database,
  actorId: string,
  operationId: string,
  kind: string,
  targetId: string,
  label: string,
  at: string,
) {
  const actor = db.sql.prepare('SELECT name FROM users WHERE id=?').get(actorId);
  const action = kind.endsWith('.create')
    ? 'added'
    : kind.endsWith('.delete')
      ? 'deleted'
      : kind.endsWith('.complete')
        ? 'completed'
        : 'updated';
  const targetKind = kind.startsWith('task.') ? 'task' : 'calendar';
  for (const person of db.sql.prepare('SELECT id FROM users WHERE id<>?').all(actorId)) {
    const id = `change:${operationId}:${person.id}`;
    db.sql
      .prepare(
        'INSERT OR IGNORE INTO notices(id,user_id,title,body,created_at,push_until) VALUES (?,?,?,?,?,?)',
      )
      .run(
        id,
        String(person.id),
        `${actor?.name ?? 'Your partner'} ${action} ${targetKind === 'task' ? 'a task' : 'an appointment'}`,
        label,
        at,
        // A partner-change push is useful for two hours after the change.
        new Date(Date.parse(at) + 7200_000).toISOString(),
      );
    db.sql
      .prepare('INSERT OR IGNORE INTO notice_targets VALUES (?,?,?)')
      .run(id, targetKind, targetId);
  }
}
