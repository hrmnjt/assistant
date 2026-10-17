const $ = (id) => document.getElementById(id);
let state,
  timer,
  refreshing = false;
// Retain an ID after an uncertain network result; repeating the same action cannot duplicate it.
const pending = new Map();
async function api(path, value) {
  const response = await fetch(`/api/${path}`, {
    method: value ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Household-Client': '1' },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error);
    error.status = response.status;
    throw error;
  }
  return result;
}
function error(err) {
  $('error').textContent = err.message;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await api('state');
    $('login').hidden = true;
    $('workspace').hidden = false;
    $('account').textContent = `Signed in as ${state.user}`;
    $('mode').textContent =
      state.mode === 'fixture'
        ? 'FIXTURE MODE · NO AI PROVIDER CALLS'
        : 'CHATGPT · USES CONNECTED PLAN';
    $('model-help').textContent =
      state.mode === 'fixture'
        ? 'A fixed reply tests Pi’s storage and execution. It does not interpret your message or change household records.'
        : 'Uses your configured ChatGPT connection. Messages are shared here. This prototype has no tools that change tasks or events.';
    $('push').disabled = !state.pushKey;
    $('calendar').disabled = !state.calendarConfigured;
    $('calendar-help').textContent = state.calendarConfigured
      ? 'iCloud credentials are configured on the server.'
      : 'Add iCloud credentials to the server configuration to enable this test.';
    $('runtime').textContent =
      `Instance ${state.bootId.slice(0, 8)} · Last alarm: ${state.lastAlarm ? new Date(state.lastAlarm).toLocaleString() : 'none'} · Next: ${state.alarm ? new Date(state.alarm).toLocaleString() : 'none'}`;
    $('replies').replaceChildren(
      ...state.replies.slice(-5).map((reply) => element('div', reply.text, 'reply')),
    );
    $('jobs').replaceChildren(
      ...state.jobs.map((job) => {
        const node = element('div', '', 'job');
        const title = element('strong', `${job.user_id} · ${job.kind}`);
        title.append(element('span', job.status, 'badge'));
        node.append(title);
        const input = JSON.parse(job.payload);
        if (input.text) node.append(element('p', input.text));
        node.append(
          element('p', job.result || `Scheduled ${new Date(job.due_at).toLocaleString()}`, 'small'),
        );
        return node;
      }),
    );
    if (!timer)
      timer = setInterval(() => {
        if (!document.hidden) refresh();
      }, 3000);
  } catch (err) {
    if (err.status === 401) {
      $('login').hidden = false;
      $('workspace').hidden = true;
      clearInterval(timer);
      timer = null;
    } else error(err);
  } finally {
    refreshing = false;
  }
}
async function act(button, action) {
  button.disabled = true;
  $('error').textContent = '';
  try {
    await action();
    await refresh();
  } catch (err) {
    error(err);
  } finally {
    button.disabled = false;
  }
}
async function job(value) {
  const key = JSON.stringify(value);
  const id = pending.get(key) || crypto.randomUUID();
  pending.set(key, id);
  await api('jobs', { id, ...value });
  pending.delete(key);
}
$('login').onsubmit = (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  act(form.querySelector('button'), async () => {
    await api('login', Object.fromEntries(new FormData(form)));
    form.reset();
  });
};
$('chat').onsubmit = (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const text = new FormData(form).get('text').trim();
  if (text)
    act(form.querySelector('button'), async () => {
      await job({ kind: 'chat', text });
      form.reset();
    });
};
$('reminder').onsubmit = (event) => {
  event.preventDefault();
  act(event.currentTarget.querySelector('button'), () =>
    job({ kind: 'reminder', seconds: Number(new FormData($('reminder')).get('seconds')) }),
  );
};
$('calendar').onclick = (event) => act(event.currentTarget, () => job({ kind: 'calendar' }));
$('logout').onclick = (event) => act(event.currentTarget, () => api('logout', {}));
$('refresh').onclick = () => refresh();
$('push').onclick = (event) =>
  act(event.currentTarget, async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window))
      throw new Error(
        'This browser cannot enable push here. On iPhone, open the installed Home Screen app.',
      );
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notification permission was not granted.');
    await navigator.serviceWorker.register('/sw.js');
    const registration = await navigator.serviceWorker.ready;
    const key = state.pushKey.replace(/-/g, '+').replace(/_/g, '/');
    const applicationServerKey = Uint8Array.from(atob(key), (char) => char.charCodeAt(0));
    const subscription =
      (await registration.pushManager.getSubscription()) ||
      (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }));
    await api('push', subscription.toJSON());
  });
refresh();
