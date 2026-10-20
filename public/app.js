// The chat: one ongoing conversation. Replies stream in as lines of JSON.

const list = document.querySelector('#messages');
const problem = document.querySelector('#problem');
const form = document.querySelector('#composer');
const input = form.elements.text;
const sendButton = form.querySelector('button');
let busy = false;

const post = (path, body = {}) =>
  fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
}

/** Show why a request failed. Without a response, the network or the Access sign-in failed. */
async function fail(response) {
  const body = await response?.json().catch(() => null);
  problem.textContent =
    body?.error ?? 'Couldn’t reach the app. Check the connection, or reload to sign in again.';
  problem.hidden = false;
  setBusy(false);
}

/** Run an update, staying scrolled to the bottom if the reader was there. */
function keepAtBottom(update) {
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  update();
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function reasoningBlock(text, open) {
  const details = element('details', 'reasoning');
  details.open = open;
  details.append(element('summary', '', 'Reasoning'), element('p', '', text));
  return details;
}

function retryButton() {
  const button = element('button', 'secondary', 'Retry');
  button.type = 'button';
  button.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    problem.hidden = true;
    const response = await post('/api/chat/retry');
    if (!response?.ok) return fail(response);
    button.closest('article').remove();
    await follow(response);
  });
  return button;
}

function show(message) {
  const node = element('article', `message ${message.role}`);
  if (message.reasoning) node.append(reasoningBlock(message.reasoning, false));
  if (message.text) node.append(element('p', '', message.text));
  if (message.error) node.append(element('p', 'error', message.error));
  list.append(node);
  return node;
}

/** Show a reply as it streams in, then reload the conversation as saved. */
async function follow(response) {
  const node = element('article', 'message assistant');
  const reasoning = reasoningBlock('', true);
  const thinking = element('p', 'thinking', 'Thinking…');
  const text = element('p');
  reasoning.hidden = true;
  node.append(reasoning, thinking, text);
  keepAtBottom(() => list.append(node));
  let reasoningText = '';
  let replyText = '';
  try {
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.type === 'snapshot') [reasoningText, replyText] = [event.reasoning, event.text];
        if (event.type === 'delta') {
          reasoningText += event.reasoning ?? '';
          replyText += event.text ?? '';
        }
      }
      keepAtBottom(() => {
        reasoning.hidden = !reasoningText.trim();
        reasoning.lastChild.textContent = reasoningText.trim();
        thinking.hidden = Boolean(replyText);
        text.textContent = replyText;
      });
    }
  } catch {
    // The connection dropped. The reply carries on in the app; reloading picks it up.
  }
  await load();
}

async function load() {
  const response = await fetch('/api/chat').catch(() => null);
  if (!response?.ok) return fail(response);
  const { messages, replying } = await response.json();
  list.replaceChildren();
  messages.forEach(show);
  // The last message can be answered again if its reply failed or never came.
  const last = messages.at(-1);
  if (!replying && last?.role === 'user') show({ role: 'assistant', error: 'No reply yet.' });
  if (!replying && (last?.role === 'user' || last?.error)) list.lastChild.append(retryButton());
  list.scrollTop = list.scrollHeight;
  if (replying) {
    const stream = await fetch('/api/chat/stream').catch(() => null);
    if (stream?.status === 200) return follow(stream);
    if (stream?.status === 204) return load();
  }
  setBusy(false);
}

function resize() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  setBusy(true);
  problem.hidden = true;
  const response = await post('/api/chat', { text });
  // On failure the message stays in the box to send again.
  if (!response?.ok) return fail(response);
  input.value = '';
  resize();
  keepAtBottom(() => show({ role: 'user', text }));
  await follow(response);
});

input.addEventListener('input', resize);
// Enter sends on a keyboard; on a phone, Return adds a line and Send sends.
input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  if (!matchMedia('(pointer: fine)').matches) return;
  event.preventDefault();
  form.requestSubmit();
});

setBusy(true);
load();
