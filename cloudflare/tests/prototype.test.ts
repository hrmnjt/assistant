import { env } from 'cloudflare:workers';
import {
  runInDurableObject,
  runDurableObjectAlarm,
  reset,
  abortAllDurableObjects,
} from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker, { type Env } from '../worker.js';
const bindings = env as unknown as Env;
const origin = 'https://prototype.test';
const stub = () => bindings.HOUSEHOLD.getByName('household-prototype-v1');
function request(path: string, value?: unknown, cookie = '', extra: Record<string, string> = {}) {
  return worker.fetch(
    new Request(`${origin}/api/${path}`, {
      method: value ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Household-Client': '1',
        Origin: origin,
        Cookie: cookie,
        ...extra,
      },
      ...(value ? { body: JSON.stringify(value) } : {}),
    }),
    bindings,
  );
}
async function login(username = 'owner') {
  const response = await request('login', {
    username,
    password: username === 'owner' ? 'Owner-test-password-123' : 'Partner-test-password-123',
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  return response.headers.get('set-cookie')!.split(';')[0];
}
async function state(cookie: string) {
  return (await (await request('state', undefined, cookie)).json()) as any;
}
async function due(id: string) {
  await runInDurableObject(stub(), async (_instance, ctx) => {
    ctx.storage.sql.exec('UPDATE prototype_jobs SET due_at=? WHERE id=?', Date.now() - 1, id);
    await ctx.storage.setAlarm(Date.now() + 60000);
  });
}

describe('Cloudflare household compatibility prototype', () => {
  beforeEach(async () => {
    await reset();
  });
  it('requires login, guards origins, enforces real body size, and revokes sessions', async () => {
    expect((await request('state')).status).toBe(401);
    const cookie = await login();
    expect(
      (
        await request('jobs', { id: crypto.randomUUID(), kind: 'reminder', seconds: 10 }, cookie, {
          Origin: 'https://attacker.test',
        })
      ).status,
    ).toBe(403);
    expect((await request('jobs', { text: 'a'.repeat(17000) }, cookie)).status).toBe(413);
    expect((await request('logout', {}, cookie)).status).toBe(200);
    expect((await request('state', undefined, cookie)).status).toBe(401);
  });
  it('persists a Pi conversation; retried and replayed jobs do not duplicate entries', async () => {
    const cookie = await login();
    const input = { id: crypto.randomUUID(), kind: 'chat', text: 'Keep this note across restarts' };
    expect((await request('jobs', input, cookie)).status).toBe(202);
    expect((await request('jobs', input, cookie)).status).toBe(202);
    expect((await request('jobs', { ...input, text: 'different input' }, cookie)).status).toBe(409);
    await runDurableObjectAlarm(stub());
    const first = await state(cookie);
    expect(first.jobs.find((job: any) => job.id === input.id).status).toBe('done');
    expect(first.replies.at(-1).text).toContain('Fixture response');
    const replies = first.replies.length;
    // Simulate failure after Pi committed but before the host marked the job done.
    await runInDurableObject(stub(), async (_instance, ctx) => {
      ctx.storage.sql.exec("UPDATE prototype_jobs SET status='running' WHERE id=?", input.id);
      await ctx.storage.setAlarm(Date.now() + 60000);
    });
    await abortAllDurableObjects();
    const reopened = await state(cookie);
    expect(reopened.bootId).not.toBe(first.bootId);
    await runDurableObjectAlarm(stub());
    const replayed = await state(cookie);
    expect(replayed.replies.length).toBe(replies);
    expect(replayed.jobs.filter((job: any) => job.id === input.id)).toHaveLength(1);
    expect(replayed.jobs.find((job: any) => job.id === input.id).status).toBe('done');
    expect((await state(await login('partner'))).replies).toEqual(replayed.replies);
  });
  it('does not fire future reminders early; fires due reminders once and drains alarms', async () => {
    const cookie = await login();
    const id = crypto.randomUUID();
    await request('jobs', { id, kind: 'reminder', seconds: 300 }, cookie);
    await runDurableObjectAlarm(stub());
    expect((await state(cookie)).jobs.find((job: any) => job.id === id).status).toBe('queued');
    await due(id);
    await runDurableObjectAlarm(stub());
    const result = await state(cookie);
    expect(result.jobs.find((job: any) => job.id === id).status).toBe('done');
    expect(result.jobs.find((job: any) => job.id === id).result).toContain('Alarm fired');
    expect(result.lastAlarm).toBeTruthy();
    expect(result.alarm).toBeNull();
    expect(await runDurableObjectAlarm(stub())).toBe(false);
  });
  it('keeps the earliest alarm when a later job is admitted and repairs missing alarms on retry', async () => {
    const cookie = await login();
    const earlier = { id: crypto.randomUUID(), kind: 'reminder', seconds: 60 };
    await request('jobs', earlier, cookie);
    const alarm = (await state(cookie)).alarm;
    await request('jobs', { id: crypto.randomUUID(), kind: 'reminder', seconds: 300 }, cookie);
    expect((await state(cookie)).alarm).toBe(alarm);
    await runInDurableObject(stub(), async (_instance, ctx) => {
      await ctx.storage.deleteAlarm();
    });
    await request('jobs', earlier, cookie);
    expect((await state(cookie)).alarm).toBe(alarm);
  });
  it('retries failed reminder probes with backoff and stops after three attempts', async () => {
    const cookie = await login();
    const id = crypto.randomUUID();
    await request('jobs', { id, kind: 'reminder', seconds: 5 }, cookie);
    await runInDurableObject(stub(), async (_instance, ctx) => {
      // A broken stored subscription makes encryption fail before any network request.
      ctx.storage.sql.exec(
        "INSERT INTO prototype_subscriptions VALUES ('https://push.apple.com/broken','owner','{}')",
      );
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await due(id);
      await runDurableObjectAlarm(stub());
      const result = await state(cookie);
      const job = result.jobs.find((job: any) => job.id === id);
      expect(job.attempts).toBe(attempt);
      expect(job.status).toBe(attempt < 3 ? 'queued' : 'error');
      if (attempt < 3) expect(result.alarm).toBeGreaterThan(Date.now());
      else expect(result.alarm).toBeNull();
    }
  });
  it('handles simultaneous retries of the same request without extra jobs or conflicts', async () => {
    const cookie = await login();
    const input = { id: crypto.randomUUID(), kind: 'reminder', seconds: 300 };
    const responses = await Promise.all([
      request('jobs', input, cookie),
      request('jobs', input, cookie),
    ]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect((await state(cookie)).jobs).toHaveLength(1);
  });
  it('rejects unconfigured integrations instead of reporting fake success', async () => {
    const cookie = await login();
    expect(
      (await request('jobs', { id: crypto.randomUUID(), kind: 'calendar' }, cookie)).status,
    ).toBe(503);
    expect((await request('push', {}, cookie)).status).toBe(503);
    expect((await state(cookie)).mode).toBe('fixture');
  });
  it('persists sign-in throttling and queue limits under concurrent admission', async () => {
    const cookie = await login();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        request('jobs', { id: crypto.randomUUID(), kind: 'reminder', seconds: 300 }, cookie),
      ),
    );
    expect(responses.filter((response) => response.status === 202)).toHaveLength(10);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(2);
    for (let attempt = 0; attempt < 10; attempt++)
      expect(
        (
          await request('login', { username: 'owner', password: 'wrong' }, '', {
            'CF-Connecting-IP': '203.0.113.9',
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await request('login', { username: 'owner', password: 'Owner-test-password-123' }, '', {
          'CF-Connecting-IP': '203.0.113.9',
        })
      ).status,
    ).toBe(429);
  });
});
