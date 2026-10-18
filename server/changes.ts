import type { Executor, Row } from './database.js';

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
      `${actor?.name ?? 'Your partner'} ${action} ${targetKind === 'task' ? 'a task' : 'an appointment'}`,
      label,
      at,
      // A partner-change push is useful for two hours after the change.
      new Date(Date.parse(at) + 7200_000).toISOString(),
    );
    await db.run('INSERT OR IGNORE INTO notice_targets VALUES (?,?,?)', id, targetKind, targetId);
  }
}
