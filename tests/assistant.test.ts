import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { Database } from '../server/database.js';
import { provision } from '../server/auth.js';
import { Household, DomainError } from '../server/domain.js';
import { Conversations } from '../server/conversations.js';
import { LocalCredentials, chatgptModels } from '../server/ai.js';
import { recoverablePreviews } from '../server/preview-recovery.js';

function directory() {
  mkdirSync('.cache/tests', { recursive: true });
  return mkdtempSync(resolve('.cache/tests/assistant-'));
}
function fixture() {
  const path = directory(),
    db = new Database(resolve(path, 'household.sqlite'));
  provision(db, [
    { username: 'owner', name: 'Alex', password: 'Test-owner-password' },
    { username: 'partner', name: 'Sam', password: 'Test-partner-password' },
  ]);
  const household = new Household(db);
  const thread = household.confirm(
    'owner',
    household.preview('owner', { kind: 'thread.create', title: 'Home', category: 'household' }).id,
  ).targetId;
  const faux = fauxProvider(),
    models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
  return {
    path,
    db,
    household,
    thread,
    faux,
    options: { models, model, household },
    close() {
      db.close();
      rmSync(path, { recursive: true, force: true });
    },
  };
}
async function finished(conversations: Conversations, thread: string) {
  for (let i = 0; i < 300; i++) {
    if (!conversations.status(thread).running && !conversations.status(thread).queued) return;
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
  const f = fixture();
  let conversations = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'), f.options);
  const request = randomUUID();
  f.faux.setResponses([
    (context) => {
      const tools = context.messages
        .filter((message) => message.role === 'system')
        .flatMap((message) => (message.role === 'system' ? (message.toolsAdded ?? []) : []));
      assert.deepEqual(tools.map((tool) => tool.name).sort(), ['prepare_change', 'read_household']);
      return fauxAssistantMessage(fauxToolCall('read_household', {}), { stopReason: 'toolUse' });
    },
    (context) => {
      const result = context.messages.findLast((message) => message.role === 'toolResult');
      const first = result?.role === 'toolResult' ? result.content[0] : undefined;
      assert.equal(first?.type === 'text' ? JSON.parse(first.text).actorId : undefined, 'owner');
      return fauxAssistantMessage(fauxToolCall('prepare_change', { change }), {
        stopReason: 'toolUse',
      });
    },
    fauxAssistantMessage('I prepared a task for Sam. Review the change to confirm it.'),
  ]);
  try {
    await conversations.send(f.thread, 'owner', 'Add buy milk for Sam', request);
    await finished(conversations, f.thread);
    assert.equal(conversations.status(f.thread).error, null);
    assert.equal(f.household.tasks().length, 0);
    const proposal = conversations.status(f.thread).previews[0];
    assert.equal(proposal.actorId, 'owner');
    assert.deepEqual(
      recoverablePreviews(f.db, 'owner').map((p) => p.id),
      [proposal.preview.id],
    );
    assert.deepEqual(recoverablePreviews(f.db, 'partner'), []);
    assert.throws(() => f.household.confirm('partner', proposal.preview.id), DomainError);
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
    conversations = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'), f.options);
    await conversations.send(f.thread, 'owner', 'Add buy milk for Sam', request);
    assert.equal(f.faux.state.callCount, 3);
    assert.deepEqual(
      recoverablePreviews(f.db, 'owner').map((p) => p.id),
      [proposal.preview.id],
    );
    f.household.confirm('owner', proposal.preview.id);
    assert.equal(f.household.tasks()[0].ownerId, 'partner');
    assert.equal(conversations.status(f.thread).previews.length, 0);
  } finally {
    await conversations.close();
    f.close();
  }
});

test('messages queue while the assistant works without changing the requesting actor', async () => {
  const f = fixture();
  const conversations = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'), f.options);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.faux.setResponses([
    async () => {
      await gate;
      return fauxAssistantMessage('Hello Alex');
    },
    fauxAssistantMessage(fauxToolCall('prepare_change', { change }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Ready for review'),
  ]);
  try {
    const request = randomUUID();
    await conversations.send(f.thread, 'owner', 'Hello', request);
    const partnerRequest = randomUUID();
    await conversations.send(f.thread, 'partner', 'Add milk', partnerRequest);
    await conversations.send(f.thread, 'partner', 'Add milk', partnerRequest);
    assert.equal(conversations.status(f.thread).queued, 1);
    assert.equal(conversations.status(f.thread).running, true);
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

    assert.equal(conversations.status(f.thread).previews[0].actorId, 'partner');
    assert.equal(f.household.tasks().length, 0);
  } finally {
    release();
    await conversations.close();
    f.close();
  }
});

test('ordinary shared-channel messages do not call the model, and the next assistant request can see them', async () => {
  const f = fixture();
  const conversations = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'), f.options);
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
    assert.equal(conversations.status(f.thread).error, null);
    assert.equal(f.faux.state.callCount, 1);
  } finally {
    await conversations.close();
    f.close();
  }
});

test('queued requests resume after restart with their own authors and without resubmission', async () => {
  const f = fixture();
  const passive = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'));
  await passive.close();
  const request = randomUUID();
  f.db.sql
    .prepare('INSERT INTO assistant_runs VALUES (?,?,?,?,?,?,?,NULL)')
    .run(
      f.thread,
      `partner:${request}`,
      'partner',
      'Add milk',
      randomUUID(),
      new Date().toISOString(),
      'queued',
    );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('prepare_change', { change }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Prepared'),
  ]);
  const conversations = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'), f.options);
  try {
    await finished(conversations, f.thread);
    assert.equal(conversations.status(f.thread).previews[0].actorId, 'partner');
    await conversations.send(f.thread, 'partner', 'Add milk', request);
    assert.equal(f.faux.state.callCount, 2);
  } finally {
    await conversations.close();
    f.close();
  }
});

test('an unsupported confirmation tool cannot bypass human confirmation', async () => {
  const f = fixture();
  const conversations = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'), f.options);
  const preview = f.household.preview('owner', change);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('confirm_change', { id: preview.id }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('Use the app confirmation button.'),
  ]);
  try {
    await conversations.send(f.thread, 'owner', 'Yes confirm it', randomUUID());
    await finished(conversations, f.thread);
    assert.equal(f.household.tasks().length, 0);
  } finally {
    await conversations.close();
    f.close();
  }
});

test('provider failure is visible without exposing provider error text or silently using another provider', async () => {
  const f = fixture();
  const conversations = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'), f.options);
  f.faux.setResponses([
    fauxAssistantMessage('partial', {
      stopReason: 'error',
      errorMessage: 'secret-provider-detail',
    }),
  ]);
  try {
    await conversations.send(f.thread, 'owner', 'Hello', randomUUID());
    await finished(conversations, f.thread);
    assert.ok(conversations.status(f.thread).error);
    assert.equal(
      JSON.stringify(conversations.status(f.thread)).includes('secret-provider-detail'),
      false,
    );
    assert.equal(
      (await conversations.messages(f.thread)).some((message) => message.text === 'partial'),
      false,
    );
    assert.equal(f.faux.state.callCount, 1);
  } finally {
    await conversations.close();
    f.close();
  }
});

test('assistant requests stop at the bounded model-turn limit', async () => {
  const f = fixture();
  const conversations = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'), f.options);
  f.faux.setResponses(
    Array.from({ length: 12 }, () =>
      fauxAssistantMessage(fauxToolCall('read_household', {}), { stopReason: 'toolUse' }),
    ),
  );
  try {
    await conversations.send(f.thread, 'owner', 'Read things forever', randomUUID());
    await finished(conversations, f.thread);
    assert.ok(conversations.status(f.thread).error);
    assert.equal(f.faux.state.callCount, 8);
  } finally {
    await conversations.close();
    f.close();
  }
});

test('startup recovers a persisted request before Pi admission and keeps its actor and message identity', async () => {
  const f = fixture();
  const passive = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'));
  await passive.close();
  const request = randomUUID(),
    messageId = randomUUID();
  f.db.sql
    .prepare('INSERT INTO assistant_runs VALUES (?,?,?,?,?,?,?,NULL)')
    .run(
      f.thread,
      `partner:${request}`,
      'partner',
      'Buy milk',
      messageId,
      new Date().toISOString(),
      'running',
    );
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('prepare_change', { change }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Prepared for review.'),
  ]);
  const conversations = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'), f.options);
  try {
    await finished(conversations, f.thread);
    assert.equal(conversations.status(f.thread).previews[0].actorId, 'partner');
    const messages = await conversations.messages(f.thread);
    assert.equal(messages.filter((message) => message.id === messageId).length, 1);
    await conversations.send(f.thread, 'partner', 'Buy milk', request);
    assert.equal(f.faux.state.callCount, 2);
    assert.equal(f.household.tasks().length, 0);
  } finally {
    await conversations.close();
    f.close();
  }
});

test('repository-local OAuth store serializes refreshes, protects files and rejects API credentials', async () => {
  const path = directory(),
    a = new LocalCredentials(path),
    b = new LocalCredentials(path);
  try {
    await a.modify('openai', async () => ({
      type: 'oauth',
      access: 'synthetic-access',
      refresh: 'synthetic-refresh',
      expires: Date.now() + 3600000,
      counter: 0,
    }));
    await Promise.all(
      [a, b].map((store) =>
        store.modify('openai', async (current) => {
          await pause(10);
          return {
            ...current!,
            counter: Number((current as unknown as { counter: number }).counter) + 1,
          };
        }),
      ),
    );
    assert.equal(((await a.read('openai')) as unknown as { counter: unknown }).counter, 2);
    assert.equal(statSync(resolve(path, 'chatgpt-auth.json')).mode & 0o777, 0o600);
    assert.deepEqual(await a.list(), [{ providerId: 'openai', type: 'oauth' }]);
    await assert.rejects(
      a.modify('openai', async () => ({ type: 'api_key', key: 'never-use-this' })),
    );
    await b.delete('openai');
    assert.equal(await a.read('openai'), undefined);
    assert.equal(await chatgptModels(a).getAuth('openai'), undefined);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('ChatGPT uses the public streaming Responses endpoint without storage and rejects incomplete responses', async () => {
  const path = directory(),
    credentials = new LocalCredentials(path),
    originalFetch = globalThis.fetch;
  try {
    await credentials.modify('openai', async () => ({
      type: 'oauth',
      access: 'synthetic-wire-token',
      refresh: 'unused',
      expires: Date.now() + 3600000,
    }));
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
    assert.equal(
      readFileSync(resolve(path, 'chatgpt-auth.json'), 'utf8').includes('synthetic-wire-token'),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(path, { recursive: true, force: true });
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
  const f = fixture();
  const passive = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'));
  const request = randomUUID();
  f.db.sql
    .prepare('INSERT INTO assistant_runs VALUES (?,?,?,?,?,?,?,NULL)')
    .run(
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
    assert.match(passive.status(f.thread).error ?? '', /paused/);
    assert.equal(passive.status(f.thread).queued, 1);
  } finally {
    await passive.close();
  }
  f.faux.setResponses([
    (context) => {
      assert.ok(JSON.stringify(context.messages).includes('I can cook on Friday'));
      return fauxAssistantMessage('Friday dinner sounds good.');
    },
  ]);
  const conversations = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'), f.options);
  try {
    await finished(conversations, f.thread);
    assert.equal(conversations.status(f.thread).error, null);
    assert.equal(f.faux.state.callCount, 1);
    const messages = await conversations.messages(f.thread);
    assert.deepEqual(
      messages.map((message) => message.authorId),
      ['owner', 'partner', 'assistant'],
    );
  } finally {
    await conversations.close();
    f.close();
  }
});

test('human messages are saved while an admitted request is paused mid-run', async () => {
  const f = fixture();
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  f.faux.setResponses([
    (_context, options) =>
      new Promise((_, reject) => {
        started();
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  ]);
  let conversations = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'), f.options);
  await conversations.send(f.thread, 'owner', 'Plan the week', randomUUID());
  await within(running, 'The first model call');
  await conversations.close();
  conversations = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'));
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
  }
  f.faux.setResponses([fauxAssistantMessage('Here is the week.')]);
  conversations = await Conversations.open(f.db, resolve(f.path, 'pi.sqlite'), f.options);
  try {
    await finished(conversations, f.thread);
    assert.equal(conversations.status(f.thread).error, null);
    // The interrupted call plus exactly one resumed call.
    assert.equal(f.faux.state.callCount, 2);
    const messages = await conversations.messages(f.thread);
    assert.equal(messages.filter((message) => message.text === 'Plan the week').length, 1);
    assert.equal(messages.filter((message) => message.text === 'Remember the dentist').length, 1);
    assert.equal(messages.filter((message) => message.authorId === 'assistant').length, 1);
  } finally {
    await conversations.close();
    f.close();
  }
});
