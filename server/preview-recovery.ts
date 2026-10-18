import type { Database } from './database.js';
import type { ConfirmationResult, Preview } from '../src/types.js';

// A read model only: expiry revokes authorization for new writes, not the need
// to resolve an attempted write. Never expose mutation payloads or remote URLs.
export function recoverablePreviews(db: Database, actorId: string, now = new Date()): Preview[] {
  const hasCalendar = Boolean(
    db.sql
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='calendar_operations'")
      .get(),
  );
  const rows = db.sql
    .prepare(
      `
    SELECT p.view,p.expires_at,p.result,${hasCalendar ? 'COALESCE(c.attempted,0)' : '0'} AS attempted
    FROM previews p ${hasCalendar ? 'LEFT JOIN calendar_operations c ON c.preview_id=p.id' : ''}
    WHERE p.user_id=? AND p.applied_at IS NULL ORDER BY p.expires_at,p.id
  `,
    )
    .all(actorId);
  return rows.flatMap((row) => {
    const result: ConfirmationResult | null = row.result ? JSON.parse(String(row.result)) : null;
    if (result?.dismissedAt) return [];
    const attempted = Boolean(row.attempted);
    const outcome =
      result?.calendarOutcome ??
      (attempted
        ? {
            status: 'unknown' as const,
            message:
              'A write was attempted before this session. Check its result (read only); expiry does not establish whether it succeeded.',
          }
        : undefined);
    if (!attempted && !outcome && Number(row.expires_at) <= now.getTime()) return [];
    const preview: Preview = JSON.parse(String(row.view));
    return [{ ...preview, ...(outcome ? { calendarOutcome: outcome } : {}) }];
  });
}
