// The admin page: connect ChatGPT and choose the model.

const $ = (selector) => document.querySelector(selector);
const status = $('#status');
const problem = $('#problem');
const modelList = $('#model-list');
const modelName = $('#model-name');
const modelNote = $('#model-note');

async function call(path, body) {
  const options = body && {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
  const response = await fetch(path, options).catch(() => null);
  const data = await response?.json().catch(() => null);
  if (!response?.ok)
    throw new Error(data?.error ?? 'Couldn’t reach the app. Reload to sign in again.');
  return data;
}

/** Run an action, showing its error if it fails. */
const action = (run) => async (event) => {
  event.preventDefault();
  problem.hidden = true;
  try {
    await run(event);
  } catch (error) {
    problem.textContent = error.message;
    problem.hidden = false;
  }
};

/** Pick from the account's models, or type a name if they can't be listed. */
async function showModels(current) {
  let models = [];
  try {
    ({ models } = await call('/api/admin/models'));
    modelNote.hidden = true;
  } catch (error) {
    modelNote.textContent = `${error.message} You can type a model name instead.`;
    modelNote.hidden = false;
  }
  const listed = models.length > 0;
  if (current && listed && !models.includes(current)) models.unshift(current);
  modelList.replaceChildren(
    ...(current ? [] : [new Option('Choose a model', '', true, true)]),
    ...models.map((id) => new Option(id, id, id === current, id === current)),
  );
  modelName.value = current ?? '';
  modelList.hidden = modelList.disabled = !listed;
  modelName.hidden = modelName.disabled = listed;
}

async function refresh() {
  const { connected, model } = await call('/api/admin');
  status.textContent = !connected
    ? 'ChatGPT is not connected.'
    : model
      ? `ChatGPT is connected, using ${model}.`
      : 'ChatGPT is connected. Choose a model.';
  $('#connect').hidden = connected;
  $('#connected').hidden = !connected;
  if (connected) await showModels(model);
}

$('#start').addEventListener(
  'click',
  action(async () => {
    const { url } = await call('/api/admin/connect', {});
    $('#sign-in').href = url;
    $('#sign-in').hidden = false;
    $('#finish').hidden = false;
  }),
);

$('#finish').addEventListener(
  'submit',
  action(async (event) => {
    await call('/api/admin/finish', { address: event.target.elements.address.value });
    event.target.reset();
    $('#sign-in').hidden = true;
    $('#finish').hidden = true;
    await refresh();
  }),
);

$('#model').addEventListener(
  'submit',
  action(async () => {
    const model = (modelList.disabled ? modelName : modelList).value;
    await call('/api/admin/model', { model });
    await refresh();
  }),
);

$('#disconnect').addEventListener(
  'click',
  action(async () => {
    if (!confirm('Disconnect ChatGPT? The chat stops answering until you connect again.')) return;
    await call('/api/admin/disconnect', {});
    await refresh();
  }),
);

refresh().catch((error) => {
  status.textContent = error.message;
});
