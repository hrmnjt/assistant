import { hashPassword } from './auth.js';
import type { Database } from './database.js';

/** Owner-run account maintenance for the two provisioned household accounts. */
export function accounts(db: Database) {
  return db.sql
    .prepare(
      `SELECT u.id, u.username, u.name, COUNT(s.token_hash) AS sessions FROM users u
      LEFT JOIN sessions s ON s.user_id=u.id AND s.expires_at>? GROUP BY u.id ORDER BY u.id`,
    )
    .all(Date.now())
    .map((row) => ({
      id: String(row.id),
      username: String(row.username),
      name: String(row.name),
      sessions: Number(row.sessions),
    }));
}
/** Resolve an account by its stable id (owner/partner) or its username. */
export function account(db: Database, name: string) {
  const found = accounts(db).find((item) => item.id === name || item.username === name);
  if (!found) throw new Error('No household account has that id or username.');
  return found;
}
/** Replace one account's password and sign out all of its sessions; other data is untouched. */
export function changePassword(db: Database, name: string, password: string) {
  if (password.length < 12 || password.length > 1024)
    throw new Error('Choose a password of 12 to 1024 characters.');
  const { id } = account(db, name);
  const hash = hashPassword(password);
  return db.transaction(() => {
    db.sql.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, id);
    return Number(db.sql.prepare('DELETE FROM sessions WHERE user_id=?').run(id).changes);
  });
}
/** Sign out one account, or both when no name is given. Returns the number of sessions ended. */
export function revokeSessions(db: Database, name?: string) {
  if (name === undefined) return Number(db.sql.prepare('DELETE FROM sessions').run().changes);
  const { id } = account(db, name);
  return Number(db.sql.prepare('DELETE FROM sessions WHERE user_id=?').run(id).changes);
}
