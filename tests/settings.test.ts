import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openHousehold } from '../server/runtime.js';
import { client, config, directory, openStore, setUp } from './support.js';

const json = async (response: Response) => (await response.json()) as any;

test('push keys are made once and kept, so phones stay subscribed', async () => {
  const path = `${directory('settings')}/household.sqlite`;
  const first = await openHousehold(openStore(path), config);
  await setUp(first.household);
  const key = (await json(await client(first).call('/api/push/key'))).publicKey;
  await first.conversations.close();
  assert.match(key, /^[A-Za-z0-9_-]{80,}$/);
  const again = await openHousehold(openStore(path), config);
  try {
    assert.equal((await json(await client(again).call('/api/push/key'))).publicKey, key);
  } finally {
    await again.conversations.close();
  }
});
