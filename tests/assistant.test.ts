import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import {
  boundedModels,
  dailyMaintenanceCalls,
  requestModelCalls,
} from '../server/assistant-tools.js';
import { chatgptModels, StoredCredentials } from '../server/ai.js';
import { openHousehold, type Overrides, type Runtime } from '../server/runtime.js';
import type { ChatStatus, Message, Preview, Task } from '../src/types.js';
import {
  client,
  config,
  directory,
  householdStore,
  json,
  openStore,
  people,
  setUp,
} from './support.js';

/** A faux ChatGPT answering with scripted replies, and the model the admin chose on it. */
function fauxChatgpt() {
  const faux = fauxProvider(),
    models = createModels();
  models.setProvider(faux.provider);
  return {
    faux,
    ai: { models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } },
  };
}
/** A household where the admin has added both people, and their shared chat. */
async function household(overrides: Overrides = {}, store = openStore()) {
  const app = await openHousehold(store, config, overrides);
  await setUp(app.household);
  return {
    app,
    thread: (await app.household.threads()).find((thread) => !thread.assistantFor)!.id,
  };
}
/** One person in a chat, through the API. */
function chat(app: Runtime, person: 'owner' | 'partner', thread: string) {
  const { call } = client(app, person);
  const post = (text: string, requestId: string, askAssistant: boolean) =>
    call(`/api/threads/${thread}/messages`, { text, requestId, askAssistant });
  return {
    say: (text: string, requestId = randomUUID()) => post(text, requestId, false),
    ask: (text: string, requestId = randomUUID()) => post(text, requestId, true),
    messages: async (): Promise<Message[]> => json(await call(`/api/threads/${thread}/messages`)),
    assistant: async (): Promise<ChatStatus> =>
      json(await call(`/api/threads/${thread}/assistant`)),
    previews: async (): Promise<Preview[]> => json(await call('/api/previews')),
    confirm: (previewId: string) => call(`/api/previews/${previewId}/confirm`, {}),
    tasks: async (): Promise<Task[]> => (await json(await call('/api/state'))).tasks,
  };
}
/** Wait, as the Worker does before it sleeps, until the assistant has finished every request. */
async function answered(app: Runtime) {
  const hang = Date.now() + 30_000;
  while (await app.conversations.pending()) {
    if (Date.now() > hang) throw new Error('The assistant did not finish.');
    await app.conversations.settle(30_000);
    await setImmediate();
  }
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
/** The model's reply preparing that task. */
const prepare = () =>
  fauxAssistantMessage(fauxToolCall('prepare_task_change', { change }), { stopReason: 'toolUse' });

test('asking the assistant prepares a change that only the asker can confirm, once', async () => {
  const path = `${directory('assistant')}/household.sqlite`;
  const { faux, ai } = fauxChatgpt();
  let { app, thread } = await household(ai, openStore(path));
  const lastResult = (context: TranscriptContext) => {
    const result = context.messages.findLast((message) => message.role === 'toolResult');
    const first = result?.role === 'toolResult' ? result.content[0] : undefined;
    return first?.type === 'text' ? JSON.parse(first.text) : undefined;
  };
  faux.setResponses([
    (context) => {
      const tools = context.messages.flatMap((message) =>
        message.role === 'system' ? (message.toolsAdded ?? []) : [],
      );
      const names = tools.map((tool) => tool.name);
      assert.ok(names.includes('read_household') && names.includes('prepare_task_change'));
      // The assistant can only read and prepare.
      assert.ok(names.every((name) => /^(read|prepare)_/.test(name)));
      assert.ok(JSON.stringify(context.messages).includes('Please bring oat milk'));
      return fauxAssistantMessage(fauxToolCall('read_household', {}), { stopReason: 'toolUse' });
    },
    (context) => {
      const read = lastResult(context);
      assert.equal(read.actorId, 'owner');
      // The model learns the two names, never their email addresses.
      assert.deepEqual(read.people, [
        { id: 'owner', name: people.owner.name },
        { id: 'partner', name: people.partner.name },
      ]);
      assert.ok(!JSON.stringify(read).includes(people.owner.email));
      return prepare();
    },
    // A tool the assistant does not have cannot confirm what it prepared.
    (context) =>
      fauxAssistantMessage(fauxToolCall('confirm_change', { id: lastResult(context).preview.id }), {
        stopReason: 'toolUse',
      }),
    fauxAssistantMessage('I prepared a task for Sam. Review the change to confirm it.'),
  ]);
  try {
    const sam = chat(app, 'partner', thread);
    assert.equal((await sam.say('Please bring oat milk')).status, 200);
    assert.equal(faux.state.callCount, 0);

    const request = randomUUID();
    let alex = chat(app, 'owner', thread);
    assert.equal((await alex.ask('Add buy milk for Sam', request)).status, 200);
    await answered(app);
    const status = await alex.assistant();
    assert.equal(status.error, null);
    assert.deepEqual(
      status.previews.map((proposal) => proposal.actorId),
      ['owner'],
    );
    const preview = status.previews[0].preview;
    assert.deepEqual(await alex.tasks(), []);
    assert.deepEqual(await sam.previews(), []);
    assert.equal((await sam.confirm(preview.id)).status, 404);
    const messages = await alex.messages();
    assert.equal(messages.filter((message) => message.text === 'Add buy milk for Sam').length, 1);
    assert.equal(messages.filter((message) => message.authorId === 'assistant').length, 1);

    // Retrying the request, before or after a restart, does not ask the model again.
    assert.equal((await alex.ask('Add buy milk for Sam', request)).status, 200);
    await app.conversations.close();
    app = await openHousehold(openStore(path), config, ai);
    alex = chat(app, 'owner', thread);
    assert.equal((await alex.ask('Add buy milk for Sam', request)).status, 200);
    await answered(app);
    assert.equal(faux.state.callCount, 4);
    assert.deepEqual(
      (await alex.previews()).map((item) => item.id),
      [preview.id],
    );

    assert.equal((await alex.confirm(preview.id)).status, 200);
    assert.deepEqual(
      (await alex.tasks()).map((task) => task.ownerId),
      ['partner'],
    );
    assert.deepEqual((await alex.assistant()).previews, []);
  } finally {
    await app.conversations.close();
  }
});

test('requests from both people queue, and each keeps its asker', async () => {
  const { faux, ai } = fauxChatgpt();
  const { app, thread } = await household(ai);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  faux.setResponses([
    async () => {
      await held;
      return fauxAssistantMessage('Hello Alex');
    },
    prepare,
    fauxAssistantMessage('Ready for review'),
  ]);
  try {
    const alex = chat(app, 'owner', thread),
      sam = chat(app, 'partner', thread);
    assert.equal((await alex.ask('Hello')).status, 200);
    const request = randomUUID();
    assert.equal((await sam.ask('Add milk', request)).status, 200);
    assert.equal((await sam.ask('Add milk', request)).status, 200);
    assert.equal((await sam.ask('Add oat milk', request)).status, 409);
    const waiting = await sam.assistant();
    assert.equal(waiting.running, true);
    assert.equal(waiting.queued, 1);
    assert.equal((await sam.messages()).filter((message) => message.text === 'Add milk').length, 1);

    release();
    await answered(app);
    const status = await sam.assistant();
    assert.equal(status.error, null);
    assert.deepEqual(
      status.previews.map((proposal) => proposal.actorId),
      ['partner'],
    );
    assert.deepEqual(
      (await sam.previews()).map((preview) => preview.id),
      [status.previews[0].preview.id],
    );
    assert.deepEqual(await alex.previews(), []);
    assert.equal(faux.state.callCount, 3);
  } finally {
    release();
    await app.conversations.close();
  }
});

test('an interrupted request resumes once after a restart, and messages sent meanwhile are kept', async () => {
  const path = `${directory('assistant')}/household.sqlite`;
  const { faux, ai } = fauxChatgpt();
  let interrupted!: () => void;
  const running = new Promise<void>((resolve) => (interrupted = resolve));
  faux.setResponses([
    prepare,
    (_context, options) =>
      new Promise((_, reject) => {
        interrupted();
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    fauxAssistantMessage('Milk is ready for review.'),
  ]);
  let { app, thread } = await household(ai, openStore(path));
  const request = randomUUID();
  assert.equal((await chat(app, 'partner', thread).ask('Add milk for me', request)).status, 200);
  await running;
  await app.conversations.close();

  // Without ChatGPT, both people can still talk, but the assistant waits.
  app = await openHousehold(openStore(path), config);
  try {
    const sam = chat(app, 'partner', thread);
    const note = randomUUID();
    assert.equal((await sam.say('Remember the dentist', note)).status, 200);
    assert.equal((await sam.say('Remember the dentist', note)).status, 200);
    assert.equal((await chat(app, 'owner', thread).ask('And plan dinner')).status, 409);
    assert.ok((await sam.assistant()).error);
  } finally {
    await app.conversations.close();
  }

  app = await openHousehold(openStore(path), config, ai);
  try {
    await answered(app);
    const sam = chat(app, 'partner', thread);
    // Two calls before the restart, then one to finish.
    assert.equal(faux.state.callCount, 3);
    const status = await sam.assistant();
    assert.equal(status.error, null);
    assert.deepEqual(
      status.previews.map((proposal) => proposal.actorId),
      ['partner'],
    );
    const messages = await sam.messages();
    const sent = (text: string) => messages.filter((message) => message.text === text).length;
    assert.equal(sent('Add milk for me'), 1);
    assert.equal(sent('Remember the dentist'), 1);
    assert.equal(messages.filter((message) => message.authorId === 'assistant').length, 1);
    assert.equal((await sam.ask('Add milk for me', request)).status, 200);
    await answered(app);
    assert.equal(faux.state.callCount, 3);
  } finally {
    await app.conversations.close();
  }
});

test('a failed or runaway request ends visibly and bounded, without provider details', async () => {
  const { faux, ai } = fauxChatgpt();
  const { app, thread } = await household(ai);
  const alex = chat(app, 'owner', thread);
  faux.setResponses([
    fauxAssistantMessage('partial', {
      stopReason: 'error',
      errorMessage: 'secret-provider-detail',
    }),
  ]);
  try {
    await alex.ask('Hello');
    await answered(app);
    const failed = await alex.assistant();
    assert.ok(failed.error);
    assert.ok(!JSON.stringify(failed).includes('secret-provider-detail'));
    assert.ok(!(await alex.messages()).some((message) => message.text === 'partial'));
    assert.equal(faux.state.callCount, 1);

    faux.setResponses(
      Array.from({ length: requestModelCalls + 4 }, () =>
        fauxAssistantMessage(fauxToolCall('read_household', {}), { stopReason: 'toolUse' }),
      ),
    );
    await alex.ask('Read things forever');
    await answered(app);
    assert.ok((await alex.assistant()).error);
    assert.equal(faux.state.callCount, 1 + requestModelCalls);
  } finally {
    await app.conversations.close();
  }
});

test('concurrent ChatGPT token refreshes are serialized, and API keys are refused', async () => {
  const db = await householdStore();
  const credentials = new StoredCredentials(db);
  const credential = {
    type: 'oauth' as const,
    access: 'synthetic-access',
    refresh: 'synthetic-refresh',
    expires: Date.now() + 3600000,
  };
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const refresh = () =>
    credentials.modify('openai', async (current) => {
      await held;
      return current?.type === 'oauth' ? { ...current, access: `${current.access}+` } : current;
    });
  try {
    await credentials.save(credential);
    const both = Promise.all([refresh(), refresh()]);
    await setImmediate();
    release();
    await both;
    assert.deepEqual(await credentials.read('openai'), {
      ...credential,
      access: 'synthetic-access++',
    });
    await assert.rejects(
      credentials.modify('openai', async () => ({ type: 'api_key', key: 'never-use-this' })),
    );
    await assert.rejects(credentials.save({ type: 'api_key', key: 'never-use-this' }));
    assert.equal((await credentials.read('openai'))?.type, 'oauth');
  } finally {
    release();
    await db.close();
  }
});

test('ChatGPT uses the public streaming Responses endpoint without storage and rejects incomplete responses', async () => {
  const db = await householdStore();
  const credentials = new StoredCredentials(db),
    originalFetch = globalThis.fetch;
  try {
    await credentials.save({
      type: 'oauth',
      access: 'synthetic-wire-token',
      refresh: 'unused',
      expires: Date.now() + 3600000,
    });
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

test('topic maintenance has a daily cap that resets, and unbound or unmetered calls are refused', async () => {
  const { faux, ai } = fauxChatgpt();
  const { app, thread } = await household(ai);
  // A person's request binds the provider session to its topic.
  let sessionId: string | undefined;
  faux.setResponses([
    (_context, options) => {
      sessionId = options?.sessionId;
      return fauxAssistantMessage('Noted.');
    },
  ]);
  try {
    await chat(app, 'owner', thread).ask('Note that the boiler is serviced');
    await answered(app);
    assert.ok(sessionId);

    let now = Date.parse('2026-10-14T07:00:00Z');
    const maintenance = boundedModels(app.db, ai.models, () => now);
    const model = faux.getModel();
    const context = { messages: [{ role: 'user' as const, content: 'Summarize', timestamp: now }] };
    faux.setResponses(
      Array.from({ length: dailyMaintenanceCalls + 1 }, () => fauxAssistantMessage('Summary')),
    );
    await assert.rejects(maintenance.completeSimple(model, context, { sessionId: 'unbound' }));
    for (let call = 0; call < dailyMaintenanceCalls; call++)
      await maintenance.completeSimple(model, context, { sessionId });
    await assert.rejects(maintenance.completeSimple(model, context, { sessionId }), /limit/);
    assert.equal(faux.state.callCount, 1 + dailyMaintenanceCalls);
    now += 86_400_001;
    await maintenance.completeSimple(model, context, { sessionId });
    assert.equal(faux.state.callCount, 2 + dailyMaintenanceCalls);
    assert.throws(() => maintenance.complete(model, context), /Unmetered/);
    assert.throws(() => maintenance.stream(model, context), /Unmetered/);
  } finally {
    await app.conversations.close();
  }
});
