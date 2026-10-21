// The chat: threads, each with its own context, shared by the people the app lets in.
// Replies stream in as lines of JSON, and a WebSocket says when a thread changes, on
// this device or another.

const list = document.querySelector('#messages');
const problem = document.querySelector('#problem');
const title = document.querySelector('#title');
const threadList = document.querySelector('#thread-list');
const form = document.querySelector('#composer');
const input = form.elements.text;
const sendButton = form.querySelector('button');
/** The open thread, from the address (`/?t=12`); none for a new chat. */
let thread = Number(new URLSearchParams(location.search).get('t')) || null;
/** The letter on this person's messages. */
let you = null;
/** Showing the open thread, or following its reply. */
let busy = false;
/** The open thread changed while this page was busy; show it again once done. */
let stale = false;
/** A message is on its way. One can be sent while a reply streams; it then waits its turn. */
let sending = false;

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
  if (!value && stale) refresh();
}

/** Show the open thread as saved: now, or when this page is no longer busy. */
function refresh() {
  if (busy) return (stale = true);
  setBusy(true);
  load();
}

/** Show why a request failed. Without a response, the network or the Access sign-in failed. */
async function explain(response) {
  const body = await response?.json().catch(() => null);
  problem.textContent =
    body?.error ?? 'Couldn’t reach the app. Check the connection, or reload to sign in again.';
  problem.hidden = false;
}

async function fail(response) {
  await explain(response);
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
    const response = await post(`/api/threads/${thread}/retry`);
    if (!response?.ok) return fail(response);
    button.closest('article').remove();
    await follow(response);
  });
  return button;
}

function show(message) {
  const node = element('article', `message ${message.role}`);
  if (message.reasoning) node.append(reasoningBlock(message.reasoning, false));
  if (message.text) node.append(element('p', message.role === 'user' ? 'bubble' : '', message.text));
  // Each person's messages carry their letter.
  if (message.author) node.append(element('span', 'avatar', message.author));
  if (message.error) node.append(element('p', 'error', message.error));
  list.append(node);
  return node;
}

/** A message sent while the thread was replying: it goes in, and is answered, after the reply. */
function showQueued(message) {
  if (list.querySelector(`[data-queued="${message.id}"]`)) return;
  const node = show({ ...message, role: 'user' });
  node.classList.add('queued');
  node.dataset.queued = message.id;
  node.append(element('p', 'note', 'Waiting for the reply above'));
}

/** Show a reply as it streams in, then reload the thread as saved. */
async function follow(response) {
  const node = element('article', 'message assistant');
  const reasoning = reasoningBlock('', true);
  const thinking = element('p', 'thinking', 'Thinking…');
  const text = element('p');
  reasoning.hidden = true;
  node.append(reasoning, thinking, text);
  // Messages waiting for this reply stay after it.
  keepAtBottom(() => list.insertBefore(node, list.querySelector('.queued')));
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
        if (event.type === 'snapshot') {
          [reasoningText, replyText] = [event.reasoning, event.text];
          // A new chat has its thread now; keep it in the address.
          if (!thread) history.replaceState(null, '', `/?t=${(thread = event.thread)}`);
        }
        if (event.type === 'delta') {
          reasoningText += event.reasoning ?? '';
          replyText += event.text ?? '';
        }
        if (event.type === 'queued') keepAtBottom(() => showQueued(event.queued));
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
  await Promise.all([load(), showThreads()]);
}

async function load() {
  // What this fetches includes every change so far.
  stale = false;
  if (!thread) {
    list.replaceChildren(element('p', 'empty', 'Ask anything. Each chat keeps its own context.'));
    return setBusy(false);
  }
  const response = await fetch(`/api/threads/${thread}`).catch(() => null);
  if (!response?.ok) return fail(response);
  const { title: name, messages, queued, replying } = await response.json();
  title.textContent = document.title = name;
  // Showing it again keeps the reader's place, unless they were at the end.
  keepAtBottom(() => {
    list.replaceChildren();
    messages.forEach(show);
    // The last message can be answered again if its reply failed or never came.
    const last = messages.at(-1);
    if (!replying && last?.role === 'user') show({ role: 'assistant', error: 'No reply yet.' });
    if (!replying && (last?.role === 'user' || last?.error)) list.lastChild.append(retryButton());
    queued.forEach(showQueued);
  });
  if (replying) {
    const stream = await fetch(`/api/threads/${thread}/stream`).catch(() => null);
    if (stream?.status === 200) return follow(stream);
    if (stream?.status === 204) return load();
  }
  setBusy(false);
}

/** Today's chats show the time; older ones the date. */
function when(time) {
  const date = new Date(time);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

async function showThreads() {
  const response = await fetch('/api/threads').catch(() => null);
  // A failure here shows up in the conversation too, so stay quiet.
  if (!response?.ok) return;
  const body = await response.json();
  you = body.you;
  threadList.replaceChildren(
    ...body.threads.map((item) => {
      const row = element('li', item.id === thread ? 'current' : '');
      const link = element('a', '', item.title);
      link.href = `/?t=${item.id}`;
      link.append(element('small', '', when(item.updated)));
      const remove = element('button', 'plain', 'Delete');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Delete “${item.title}”`);
      remove.addEventListener('click', () => removeThread(item));
      row.append(link, remove);
      return row;
    }),
  );
}

async function removeThread(item) {
  if (!confirm(`Delete “${item.title}”? This can’t be undone.`)) return;
  // The open chat is going away: don't show it again meanwhile.
  if (item.id === thread) setBusy(true);
  const response = await fetch(`/api/threads/${item.id}`, { method: 'DELETE' }).catch(() => null);
  if (!response?.ok) return fail(response);
  if (item.id === thread) location.href = '/';
  else showThreads();
}

let socket;

/** Hear when a thread changes. A new connection catches up on what the dropped one missed. */
function listen() {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const reconnecting = Boolean(socket);
  socket = new WebSocket(`${location.origin.replace('http', 'ws')}/api/events`);
  if (reconnecting) socket.addEventListener('open', catchUp);
  socket.addEventListener('message', ({ data }) => {
    if (data === 'pong') return;
    showThreads();
    if (JSON.parse(data).thread === thread) refresh();
  });
  socket.addEventListener('close', () => setTimeout(listen, 5000));
}

function catchUp() {
  showThreads();
  refresh();
}

// Cloudflare closes a silent WebSocket; the app answers pings without waking up.
setInterval(() => socket.readyState === WebSocket.OPEN && socket.send('ping'), 30_000);
// A phone drops the socket in the background, sometimes without saying: catch up on return.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (socket.readyState === WebSocket.OPEN) catchUp();
  else listen();
});

function resize() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || sending) return;
  sending = sendButton.disabled = true;
  problem.hidden = true;
  const path = thread ? `/api/threads/${thread}/messages` : '/api/threads';
  const response = await post(path, { text });
  sending = sendButton.disabled = false;
  // On failure the message stays in the box to send again.
  if (!response?.ok) return explain(response);
  input.value = '';
  resize();
  // The thread is replying: the message waits for that reply, and any waiting before it.
  if (response.status === 202) {
    const { queued } = await response.json();
    return keepAtBottom(() => showQueued(queued));
  }
  // This page is still showing the thread: show it again after, this reply included.
  if (busy) {
    response.body.cancel();
    return refresh();
  }
  setBusy(true);
  if (!thread) {
    list.replaceChildren();
    title.textContent = document.title = text;
  }
  keepAtBottom(() => show({ role: 'user', author: you, text }));
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

const panel = (open) => document.body.classList.toggle('threads-open', open);
document.querySelector('#open-threads').addEventListener('click', () => panel(true));
document.querySelector('#close-threads').addEventListener('click', () => panel(false));

setBusy(true);
load();
showThreads();
listen();
