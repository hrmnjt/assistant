import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { DomainError } from '../server/errors.js';
import { Conversations } from '../server/conversations.js';
import { boundedModels, dailyMaintenanceCalls } from '../server/assistant-tools.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Conversation } from '@earendil-works/pi-durable';
import { aiConnection, AssistantModel, chatgptModels, StoredCredentials } from '../server/ai.js';
import { recoverablePreviews } from '../server/preview-recovery.js';
import type { Store } from '../server/database.js';
import { directory, householdParts, householdStore, openStore, type Row } from './support.js';

/** A file-backed household store shared with Pi; closing Pi closes it, as when a runtime stops. */
async function fixture() {
  const path = directory('assistant');
  const file = resolve(path, 'household.sqlite');
  let db: Store = await householdStore(file);
  let parts = householdParts(db);
  const thread = (
    await parts.changes.confirm(
      'owner',
      (
        await parts.changes.preview('owner', {
          kind: 'thread.create',
          title: 'Home',
          category: 'household',
        })
      ).id,
    )
  ).targetId;
  const faux = fauxProvider(),
    models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
  return {
    path,
    get db() {
      return db;
    },
    get parts() {
      return parts;
    },
    thread,
    faux,
    get options() {
      return { models, model, household: parts.household, extensions: parts.extensions };
    },
    /** Open the same store again after Pi closed it. */
    reopen() {
      db = openStore(file);
      parts = householdParts(db);
    },
    async close() {
      await db.close();
      rmSync(path, { recursive: true, force: true });
    },
  };
}
async function finished(conversations: Conversations, thread: string) {
  for (let i = 0; i < 300; i++) {
    if (
      !(await conversations.status(thread)).running &&
      !(await conversations.status(thread)).queued
    )
      return;
    await pause(10);
  }
  throw new Error('Assistant did not settle.');
}
const change = {
  kind: 'task.create',
  task: {
    title: 'Buy milk',
    notes: '',
    category: 'household',
    ownerId: 'partner',
    dueAt: null,
    schedule: null,
  },
};

test('Pi tools read household state and only prepare actor-bound changes; retries and reopen do not repeat inference', async () => {
  const f = await fixture();
  let conversations = await Conversations.open(f.db, f.options);
  const request = randomUUID();
  f.faux.setResponses([
    (context) => {
      const tools = context.messages
        .filter((message) => message.role === 'system')
        .flatMap((message) => (message.role === 'system' ? (message.toolsAdded ?? []) : []));
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        'prepare_household_change',
        'prepare_task_change',
        'read_household',
        'read_tasks',
      ]);
      return fauxAssistantMessage(fauxToolCall('read_household', {}), { stopReason: 'toolUse' });
    },
    (context) => {
      const result = context.messages.findLast((message) => message.role === 'toolResult');
      const first = result?.role === 'toolResult' ? result.content[0] : undefined;
      const read = first?.type === 'text' ? JSON.parse(first.text) : undefined;
      assert.equal(read?.actorId, 'owner');
      // The model learns the two names, never their email addresses.
      assert.deepEqual(read?.people, [
        { id: 'owner', name: 'Alex' },
        { id: 'partner', name: 'Sam' },
      ]);
      assert(!first || !JSON.stringify(first).includes('@example.com'));
      return fauxAssistantMessage(fauxToolCall('prepare_task_change', { change }), {
        stopReason: 'toolUse',
      });
    },
    fauxAssistantMessage('I prepared a task for Sam. Review the change to confirm it.'),
  ]);
  try {
    await conversations.send(f.thread, 'owner', 'Add buy milk for Sam', request);
    await finished(conversations, f.thread);
    assert.equal((await conversations.status(f.thread)).error, null);
    assert.equal((await f.parts.tasks.list()).length, 0);
    const proposal = (await conversations.status(f.thread)).previews[0];
    assert.equal(proposal.actorId, 'owner');
    assert.deepEqual(
      (await recoverablePreviews(f.db, 'owner')).map((p) => p.id),
      [proposal.preview.id],
    );
    assert.deepEqual(await recoverablePreviews(f.db, 'partner'), []);
    await assert.rejects(
      async () => await f.parts.changes.confirm('partner', proposal.preview.id),
      DomainError,
    );
    const messages = await conversations.messages(f.thread);
    assert.equal(messages.filter((message) => message.authorId === 'owner').length, 1);
    assert.ok(
      messages.findIndex((message) => message.authorId === 'owner') <
        messages.findIndex((message) => message.authorId === 'assistant'),
    );
    assert.ok(
      messages.some(
        (message) => message.authorId === 'assistant' && message.text.includes('prepared'),
      ),
    );
    await conversations.send(f.thread, 'owner', 'Add buy milk for Sam', request);
    assert.equal(f.faux.state.callCount, 3);
    await conversations.close();
    f.reopen();
    conversations = await Conversations.open(f.db, f.options);
    await conversations.send(f.thread, 'owner', 'Add buy milk for Sam', request);
    assert.equal(f.faux.state.callCount, 3);
    assert.deepEqual(
      (await recoverablePreviews(f.db, 'owner')).map((p) => p.id),
      [proposal.preview.id],
    );
    await f.parts.changes.confirm('owner', proposal.preview.id);
    assert.equal((await f.parts.tasks.list())[0].ownerId, 'partner');
    assert.equal((await conversations.status(f.thread)).previews.length, 0);
  } finally {
    await conversations.close();
    await f.close();
  }
});

test('messages queue while the assistant works without changing the requesting actor', async () => {
  const f = await fixture();
  const conversations = await Conversations.open(f.db, f.options);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.faux.setResponses([
    async () => {
      await gate;
      return fauxAssistantMessage('Hello Alex');
    },
    fauxAssistantMessage(fauxToolCall('prepare_task_change', { change }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('Ready for review'),
  ]);
  try {
    const request = randomUUID();
    await conversations.send(f.thread, 'owner', 'Hello', request);
    const partnerRequest = randomUUID();
    await conversations.send(f.thread, 'partner', 'Add milk', partnerRequest);
    await conversations.send(f.thread, 'partner', 'Add milk', partnerRequest);
    assert.equal((await conversations.status(f.thread)).queued, 1);
    assert.equal((await conversations.status(f.thread)).running, true);
    assert.equal(
      (await conversations.messages(f.thread)).filter((message) => message.authorId === 'partner')
        .length,
      1,
    );
    await assert.rejects(
      conversations.send(f.thread, 'owner', 'Different text', request),
      DomainError,
    );
    release();
    await finished(conversations, f.thread);

    assert.equal((await conversations.status(f.thread)).previews[0].actorId, 'partner');
    assert.equal((await f.parts.tasks.list()).length, 0);
  } finally {
    release();
    await conversations.close();
    await f.close();
  }
});

test('ordinary shared-channel messages do not call the model, and the next assistant request can see them', async () => {
  const f = await fixture();
  const conversations = await Conversations.open(f.db, f.options);
  try {
    await conversations.send(f.thread, 'partner', 'Please bring oat milk', randomUUID(), false);
    assert.equal(f.faux.state.callCount, 0);
    f.faux.setResponses([
      (context) => {
        assert.ok(JSON.stringify(context.messages).includes('Please bring oat milk'));
        return fauxAssistantMessage('Oat milk is in the conversation.');
      },
    ]);
    await conversations.send(f.thread, 'owner', 'What did Sam ask for?', randomUUID(), true);
    await finished(conversations, f.thread);
    assert.equal((await conversations.status(f.thread)).error, null);
    assert.equal(f.faux.state.callCount, 1);
  } finally {
    await conversations.close();
    await f.close();
  }
});

test('queued requests resume after restart with their own authors and without resubmission', async () => {
  const f = await fixture();
  const passive = await Conversations.open(f.db);
  await passive.close();
  f.reopen();
  const request = randomUUID();
  await f.db.run(
    'INSERT INTO assistant_runs VALUES (?,?,?,?,?,?,?,NULL)',
    f.thread,
    `partner:${request}`,
    'partner',
    'Add milk',
    randomUUID(),
    new Date().toISOString(),
    'queued',
  );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('prepare_task_change', { change }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('Prepared'),
  ]);
  const conversations = await Conversations.open(f.db, f.options);
  try {
    await finished(conversations, f.thread);
    assert.equal((await conversations.status(f.thread)).previews[0].actorId, 'partner');
    await conversations.send(f.thread, 'partner', 'Add milk', request);
    assert.equal(f.faux.state.callCount, 2);
  } finally {
    await conversations.close();
    await f.close();
  }
});

test('an unsupported confirmation tool cannot bypass human confirmation', async () => {
  const f = await fixture();
  const conversations = await Conversations.open(f.db, f.options);
  const preview = await f.parts.changes.preview('owner', change);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('confirm_change', { id: preview.id }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('Use the app confirmation button.'),
  ]);
  try {
    await conversations.send(f.thread, 'owner', 'Yes confirm it', randomUUID());
    await finished(conversations, f.thread);
    assert.equal((await f.parts.tasks.list()).length, 0);
  } finally {
    await conversations.close();
    await f.close();
  }
});

test('provider failure is visible without exposing provider error text or silently using another provider', async () => {
  const f = await fixture();
  const conversations = await Conversations.open(f.db, f.options);
  f.faux.setResponses([
    fauxAssistantMessage('partial', {
      stopReason: 'error',
      errorMessage: 'secret-provider-detail',
    }),
  ]);
  try {
    await conversations.send(f.thread, 'owner', 'Hello', randomUUID());
    await finished(conversations, f.thread);
    assert.ok((await conversations.status(f.thread)).error);
    assert.equal(
      JSON.stringify(await conversations.status(f.thread)).includes('secret-provider-detail'),
      false,
    );
    assert.equal(
      (await conversations.messages(f.thread)).some((message) => message.text === 'partial'),
      false,
    );
    assert.equal(f.faux.state.callCount, 1);
  } finally {
    await conversations.close();
    await f.close();
  }
});

test('assistant requests stop at the bounded model-turn limit', async () => {
  const f = await fixture();
  const conversations = await Conversations.open(f.db, f.options);
  f.faux.setResponses(
    Array.from({ length: 12 }, () =>
      fauxAssistantMessage(fauxToolCall('read_household', {}), { stopReason: 'toolUse' }),
    ),
  );
  try {
    await conversations.send(f.thread, 'owner', 'Read things forever', randomUUID());
    await finished(conversations, f.thread);
    assert.ok((await conversations.status(f.thread)).error);
    assert.equal(f.faux.state.callCount, 8);
  } finally {
    await conversations.close();
    await f.close();
  }
});

test('startup recovers a persisted request before Pi admission and keeps its actor and message identity', async () => {
  const f = await fixture();
  const passive = await Conversations.open(f.db);
  await passive.close();
  f.reopen();
  const request = randomUUID(),
    messageId = randomUUID();
  await f.db.run(
    'INSERT INTO assistant_runs VALUES (?,?,?,?,?,?,?,NULL)',
    f.thread,
    `partner:${request}`,
    'partner',
    'Buy milk',
    messageId,
    new Date().toISOString(),
    'running',
  );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('prepare_task_change', { change }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('Prepared for review.'),
  ]);
  const conversations = await Conversations.open(f.db, f.options);
  try {
    await finished(conversations, f.thread);
    assert.equal((await conversations.status(f.thread)).previews[0].actorId, 'partner');
    const messages = await conversations.messages(f.thread);
    assert.equal(messages.filter((message) => message.id === messageId).length, 1);
    await conversations.send(f.thread, 'partner', 'Buy milk', request);
    assert.equal(f.faux.state.callCount, 2);
    assert.equal((await f.parts.tasks.list()).length, 0);
  } finally {
    await conversations.close();
    await f.close();
  }
});

test('the stored ChatGPT credential serializes refreshes and rejects API credentials', async () => {
  const db = await householdStore();
  const credentials = new StoredCredentials(db);
  const seed = JSON.stringify({
    type: 'oauth',
    access: 'synthetic-access',
    refresh: 'synthetic-refresh',
    expires: Date.now() + 3600000,
    counter: 0,
  });
  try {
    await credentials.seed(seed);
    await Promise.all(
      [1, 2].map(() =>
        credentials.modify('openai', async (current) => {
          await pause(10);
          return {
            ...current!,
            counter: Number((current as unknown as { counter: number }).counter) + 1,
          };
        }),
      ),
    );
    assert.equal(
      ((await credentials.read('openai')) as unknown as { counter: unknown }).counter,
      2,
    );
    // The same connection secret does not overwrite refreshed tokens on restart.
    await credentials.seed(seed);
    assert.equal(
      ((await credentials.read('openai')) as unknown as { counter: unknown }).counter,
      2,
    );
    assert.deepEqual(await credentials.list(), [{ providerId: 'openai', type: 'oauth' }]);
    await assert.rejects(
      credentials.modify('openai', async () => ({ type: 'api_key', key: 'never-use-this' })),
    );
    // A new connection replaces it; removing the secret disconnects.
    await credentials.seed(seed.replace('synthetic-access', 'reconnected-access'));
    assert.equal(
      ((await credentials.read('openai')) as unknown as { access: string }).access,
      'reconnected-access',
    );
    await credentials.seed(undefined);
    assert.equal(await credentials.read('openai'), undefined);
    assert.equal(await chatgptModels(credentials).getAuth('openai'), undefined);
  } finally {
    await db.close();
  }
});

test('the assistant is configured only by a supported CHATGPT_MODEL and a readable connection', async () => {
  const db = await householdStore();
  const credential = JSON.stringify({
    type: 'oauth',
    access: 'synthetic-access',
    refresh: 'synthetic-refresh',
    expires: Date.now() + 3600000,
  });
  try {
    assert.equal((await aiConnection(db, { CHATGPT_MODEL: 'gpt-6.1-sol' })).model, undefined);
    // Connected, but no model set yet, or one the assistant does not support.
    for (const CHATGPT_MODEL of [undefined, ' ', 'not-a-model'])
      assert.equal(
        (await aiConnection(db, { CHATGPT_CREDENTIAL_JSON: credential, CHATGPT_MODEL })).model,
        undefined,
      );
    assert.equal(
      (
        await aiConnection(db, {
          CHATGPT_CREDENTIAL_JSON: '{not json',
          CHATGPT_MODEL: 'gpt-6.1-sol',
        })
      ).model,
      undefined,
    );
    assert.deepEqual(
      (
        await aiConnection(db, {
          CHATGPT_CREDENTIAL_JSON: credential,
          CHATGPT_MODEL: ' gpt-6.1-sol ',
        })
      ).model,
      { provider: 'openai', modelId: 'gpt-6.1-sol' },
    );
  } finally {
    await db.close();
  }
});

test('the account catalog lists the supported models to set in CHATGPT_MODEL', async () => {
  const db = await householdStore();
  const { models } = await aiConnection(db, {
    CHATGPT_CREDENTIAL_JSON: JSON.stringify({
      type: 'oauth',
      access: 'synthetic-access',
      refresh: 'synthetic-refresh',
      expires: Date.now() + 3600000,
    }),
  });
  const original = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(`${String(input)} ${new Headers(init?.headers).get('authorization')}`);
    return Response.json({
      models: [
        { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
        { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' },
        { slug: 'unknown-model', display_name: 'Unknown', visibility: 'list' },
      ],
    });
  }) as typeof fetch;
  try {
    const model = new AssistantModel(db, models, 'gpt-6.1-sol');
    assert.equal(await model.connected(), true);
    assert.deepEqual(await model.catalog(), {
      current: 'gpt-6.1-sol',
      models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }],
    });
    assert.deepEqual(asked, ['https://api.openai.com/v1/models Bearer synthetic-access']);
  } finally {
    globalThis.fetch = original;
    await db.close();
  }
});

test('ChatGPT uses the public streaming Responses endpoint without storage and rejects incomplete responses', async () => {
  const db = await householdStore();
  const credentials = new StoredCredentials(db),
    originalFetch = globalThis.fetch;
  try {
    await credentials.seed(
      JSON.stringify({
        type: 'oauth',
        access: 'synthetic-wire-token',
        refresh: 'unused',
        expires: Date.now() + 3600000,
      }),
    );
    const models = chatgptModels(credentials),
      model = models.getModel('openai', 'gpt-6.1-sol')!;
    let requests = 0;
    globalThis.fetch = async (input, init) => {
      requests++;
      assert.equal(String(input), 'https://api.openai.com/v1/responses');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-wire-token');
      return new Response(
        'event: response.incomplete\ndata: ' +
          JSON.stringify({
            type: 'response.incomplete',
            response: {
              id: 'r',
              status: 'incomplete',
              incomplete_details: { reason: 'max_output_tokens' },
              output: [],
            },
          }) +
          '\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const message = await models.completeSimple(
      model,
      { messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }] },
      { maxRetries: 0 },
    );
    assert.equal(message.stopReason, 'error');
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await db.close();
  }
});

async function within<T>(work: Promise<T>, label: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle.`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('human messages are saved while a queued request waits for AI, which resumes it once', async () => {
  const f = await fixture();
  const passive = await Conversations.open(f.db);
  const request = randomUUID();
  await f.db.run(
    'INSERT INTO assistant_runs VALUES (?,?,?,?,?,?,?,NULL)',
    f.thread,
    `owner:${request}`,
    'owner',
    'Plan dinner',
    randomUUID(),
    new Date().toISOString(),
    'queued',
  );
  const human = randomUUID();
  try {
    await passive.send(f.thread, 'partner', 'I can cook on Friday', human, false);
    // Retrying the same human message does not duplicate it.
    await passive.send(f.thread, 'partner', 'I can cook on Friday', human, false);
    await assert.rejects(
      passive.send(f.thread, 'partner', 'Ask the assistant too', randomUUID(), true),
      (error: unknown) => error instanceof DomainError && error.status === 409,
    );
    assert.match((await passive.status(f.thread)).error ?? '', /paused/);
    assert.equal((await passive.status(f.thread)).queued, 1);
  } finally {
    await passive.close();
    f.reopen();
  }
  f.faux.setResponses([
    (context) => {
      assert.ok(JSON.stringify(context.messages).includes('I can cook on Friday'));
      return fauxAssistantMessage('Friday dinner sounds good.');
    },
  ]);
  const conversations = await Conversations.open(f.db, f.options);
  try {
    await finished(conversations, f.thread);
    assert.equal((await conversations.status(f.thread)).error, null);
    assert.equal(f.faux.state.callCount, 1);
    const messages = await conversations.messages(f.thread);
    assert.deepEqual(
      messages.map((message) => message.authorId),
      ['owner', 'partner', 'assistant'],
    );
  } finally {
    await conversations.close();
    await f.close();
  }
});

test('human messages are saved while an admitted request is paused mid-run', async () => {
  const f = await fixture();
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  f.faux.setResponses([
    (_context, options) =>
      new Promise((_, reject) => {
        started();
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  ]);
  let conversations = await Conversations.open(f.db, f.options);
  await conversations.send(f.thread, 'owner', 'Plan the week', randomUUID());
  await within(running, 'The first model call');
  await conversations.close();
  f.reopen();
  conversations = await Conversations.open(f.db);
  try {
    await within(
      conversations.send(f.thread, 'partner', 'Remember the dentist', randomUUID(), false),
      'A passive message',
    );
    assert.ok(
      (await conversations.messages(f.thread)).some(
        (message) => message.text === 'Remember the dentist',
      ),
    );
  } finally {
    await conversations.close();
    f.reopen();
  }
  f.faux.setResponses([fauxAssistantMessage('Here is the week.')]);
  conversations = await Conversations.open(f.db, f.options);
  try {
    await finished(conversations, f.thread);
    assert.equal((await conversations.status(f.thread)).error, null);
    // The interrupted call plus exactly one resumed call.
    assert.equal(f.faux.state.callCount, 2);
    const messages = await conversations.messages(f.thread);
    assert.equal(messages.filter((message) => message.text === 'Plan the week').length, 1);
    assert.equal(messages.filter((message) => message.text === 'Remember the dentist').length, 1);
    assert.equal(messages.filter((message) => message.authorId === 'assistant').length, 1);
  } finally {
    await conversations.close();
    await f.close();
  }
});

test('maintenance inference is metered per topic with its own daily budget', async () => {
  const f = await fixture();
  let now = Date.parse('2026-10-14T07:00:00Z');
  const models = boundedModels(f.db, f.options.models, () => now);
  const model = f.faux.getModel();
  const context = { messages: [{ role: 'user' as const, content: 'Summarize', timestamp: now }] };
  f.faux.setResponses(
    Array.from({ length: dailyMaintenanceCalls + 1 }, () => fauxAssistantMessage('Summary')),
  );
  try {
    await assert.rejects(
      models.completeSimple(model, context, { sessionId: 'unbound' }),
      /cannot be bound/,
    );
    await f.db.run('INSERT INTO assistant_sessions VALUES (?,?)', 'session-1', f.thread);
    for (let call = 0; call < dailyMaintenanceCalls; call++)
      await models.completeSimple(model, context, { sessionId: 'session-1' });
    await assert.rejects(
      models.completeSimple(model, context, { sessionId: 'session-1' }),
      /daily assistant maintenance limit/,
    );
    assert.equal(f.faux.state.callCount, dailyMaintenanceCalls);
    // Maintenance never consumes a person's request budget.
    assert.equal((await f.db.get<Row>('SELECT COUNT(*) AS n FROM assistant_model_calls'))!.n, 0);
    now += 86_400_001;
    await models.completeSimple(model, context, { sessionId: 'session-1' });
    assert.throws(() => models.complete(model, context), /Unmetered/);
    assert.throws(() => models.stream(model, context), /Unmetered/);
  } finally {
    await f.close();
  }
});

test('a Pi compaction of a topic counts as maintenance rather than request generation', async () => {
  const f = await fixture();
  const conversations = await Conversations.open(f.db, f.options);
  f.faux.setResponses([fauxAssistantMessage('Noted.'), fauxAssistantMessage('Noted again.')]);
  try {
    // Enough model-visible history for Pi to keep recent context and summarize the rest.
    for (const text of ['a'.repeat(90_000), 'b'.repeat(90_000)]) {
      await conversations.send(f.thread, 'owner', text, randomUUID());
      await finished(conversations, f.thread);
    }
    const generation = (await f.db.get<Row>('SELECT COUNT(*) AS n FROM assistant_model_calls'))!.n;
    assert.equal(generation, 2);
    f.faux.setResponses([fauxAssistantMessage('The owner shared two long notes.')]);
    const conversation = await (
      conversations as unknown as { conversation(id: string): Promise<Conversation> }
    ).conversation(f.thread);
    await conversation.compact(undefined, BACKGROUND_CONTEXT);
    await within(
      (async () => {
        while (!(await f.db.get<Row>('SELECT 1 FROM assistant_maintenance_calls'))) await pause(10);
      })(),
      'Compaction',
    );
    assert.deepEqual(
      (await f.db.all<Row>('SELECT thread_id FROM assistant_maintenance_calls')).map(
        (row) => row.thread_id,
      ),
      [f.thread],
    );
    assert.equal(
      (await f.db.get<Row>('SELECT COUNT(*) AS n FROM assistant_model_calls'))!.n,
      generation,
    );
  } finally {
    await conversations.close();
    await f.close();
  }
});
