import { DurableObject } from 'cloudflare:workers';
import { DurableObjectSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import { handle } from '../server/api.js';
import { withAccessIdentity } from '../server/auth.js';
import { drain, json } from '../server/http.js';
import { openHousehold, type Config, type Runtime } from '../server/runtime.js';

export interface Env extends Config {
  HOUSEHOLD: DurableObjectNamespace<Household>;
  ASSETS: Fetcher;
}

/**
 * The Worker serves the built React app as static assets and sends `/api/*` to
 * the one household Durable Object, with the email Cloudflare Access verified
 * (Access does not pass its identity on to the object itself). There are no
 * caller-chosen object IDs and no public registration.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/'))
      return env.HOUSEHOLD.getByName('household').fetch(
        await withAccessIdentity(request, ctx.access),
      );
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/**
 * One household: both people, shared records, and the Pi conversations share
 * this object's SQLite storage through one serialized queue. A single alarm
 * drives calendar refresh, reminders, and recovery of unfinished assistant work.
 */
export class Household extends DurableObject<Env> {
  private runtime?: Runtime;
  private failure?: string;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      try {
        this.runtime = await openHousehold(new DurableObjectSqliteDatabase(ctx.storage), env);
        // A failed Pi store closes its harness; restart the object to reopen from committed state.
        void this.runtime.conversations.storageFailed.then((failed) => {
          if (failed) ctx.abort('Assistant storage failed.');
        });
        await this.schedule();
      } catch (error) {
        // Configuration messages are our own; never expose anything else.
        this.failure =
          error instanceof Error && /^Configure /.test(error.message)
            ? error.message
            : 'The assistant could not start. Check its configuration.';
        console.error('Household startup failed.');
      }
    });
  }
  async fetch(request: Request): Promise<Response> {
    if (!this.runtime) return json({ error: this.failure }, 503);
    const response = await handle(this.runtime, request);
    await drain(request);
    // A change can bring the next reminder, retry, or assistant step closer.
    if (request.method !== 'GET') this.ctx.waitUntil(this.schedule());
    else this.ctx.waitUntil(this.runtime.refreshIfStale());
    return response;
  }
  async alarm() {
    if (!this.runtime) return;
    // Keep a recovery wakeup armed before network work, then do this pass.
    await this.setAlarm(Date.now() + 60_000, false);
    await this.runtime.tick();
    // Stay awake while assistant work runs; it resumes on the next wake if evicted.
    if (await this.runtime.conversations.pending()) await this.runtime.conversations.settle(25_000);
    await this.setAlarm(await this.runtime.nextWake(), false);
  }
  private async schedule() {
    if (this.runtime) await this.setAlarm(await this.runtime.nextWake(), true);
  }
  /** Alarm writes share the SQL queue, so an open Pi transaction cannot roll them back. */
  private setAlarm(at: number, onlyIfEarlier: boolean) {
    return this.runtime!.db.transaction(async () => {
      const current = await this.ctx.storage.getAlarm();
      if (!onlyIfEarlier || current === null || at < current) await this.ctx.storage.setAlarm(at);
    });
  }
}
