import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionsAssistant } from '../src/mentions.js';

test('assistant mentions are recognized anywhere at token boundaries', () => {
  for (const text of [
    '@assistant what is on tomorrow?',
    'Could @assistant help with this?',
    'Thanks @Assistant!',
    'Ask @ASSISTANT, please',
    '(@assistant) can you add milk',
    'Over to you @assistant.',
    'Dinner plans\n@assistant: book a table',
    '¿@assistant puedes ayudar?',
  ])
    assert.equal(mentionsAssistant(text), true, text);
});

test('similar words, handles, and addresses do not invoke the assistant', () => {
  for (const text of [
    'The assistant can wait',
    'Ask the @assistants channel',
    'cc @assistant_bot',
    'Ping @assistant-two',
    'Mail me@assistant.example',
    'See assistant@home',
    'Visit @assistant.example later',
    'Hi @@assistant',
    'é@assistant',
  ])
    assert.equal(mentionsAssistant(text), false, text);
});
