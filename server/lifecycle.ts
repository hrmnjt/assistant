import type { Server } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';

/**
 * Orderly, bounded shutdown: stop timers and new connections, let in-flight
 * requests and then background work settle, and only then close storage.
 * After the deadline, remaining connections are dropped and storage closes;
 * Pi keeps interrupted assistant work pending for the next start.
 */
export function shutdown(options: {
  server: Server;
  timers: NodeJS.Timeout[];
  /** Background work in progress, read once requests have drained. */
  idle: () => Promise<unknown>[];
  close: () => Promise<void>;
  timeoutMs?: number;
}) {
  let closing: Promise<void> | undefined;
  return () =>
    (closing ??= (async () => {
      for (const timer of options.timers) clearInterval(timer);
      const drained = new Promise<void>((done) => options.server.close(() => done()));
      options.server.closeIdleConnections();
      const settled = drained.then(() => Promise.allSettled(options.idle()));
      const deadline = pause(options.timeoutMs ?? 10_000, 'timeout' as const, { ref: false });
      if ((await Promise.race([settled, deadline])) === 'timeout') {
        console.error('Shutdown waited too long; unfinished requests were closed.');
        options.server.closeAllConnections();
      }
      await options.close();
    })());
}
