import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHousehold } from '../server/runtime.js';
import { client, config, openStore } from './support.js';

test('the conversation is the core and each feature is a plugin with its own changes and tools', async () => {
  const app = await openHousehold(openStore(), config);
  try {
    assert.deepEqual(
      app.plugins.map((plugin) => plugin.id),
      ['calendar', 'tasks', 'dashboard'],
    );
    // Every change kind has exactly one owner, so a preview always reaches one plugin.
    const kinds = [
      app.household.changes,
      ...app.plugins.flatMap((plugin) => plugin.changes ?? []),
    ].flatMap((owner) => owner.kinds);
    assert.equal(new Set(kinds).size, kinds.length);
    // Each plugin is its own Pi extension, and tool names never collide across them.
    const extensions = app.plugins.flatMap((plugin) =>
      plugin.extension ? [plugin.extension] : [],
    );
    assert.deepEqual(
      extensions.map((extension) => extension.name),
      ['calendar', 'tasks'],
    );
    const tools = extensions.flatMap((extension) => extension.tools ?? []).map((tool) => tool.name);
    assert.equal(new Set(tools).size, tools.length);

    const owner = client(app);
    await owner.login('owner', config.OWNER_PASSWORD);
    const refused = await owner.call('/api/previews', { kind: 'garden.water' });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /supported change/);
    // Plugin snapshots merge; integration statuses combine rather than replace.
    const state = (await (await owner.call('/api/state')).json()) as {
      tasks: unknown[];
      calendar: { status: string };
      integrations: { calendar: string; ai: string };
    };
    assert.deepEqual(state.tasks, []);
    assert.equal(state.calendar.status, 'not-connected');
    assert.deepEqual(state.integrations, { calendar: 'not-connected', ai: 'not-connected' });
  } finally {
    await app.conversations.close();
  }
});
