import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { MakeClient } from '../src/make-client.js';

const hash = (content) => createHash('sha256').update(content).digest('hex');

// Execute the production page expressions against a small observed-DOM fixture.
// Tree enumeration/selection and CodeMirror guards remain real code in these tests.
function fixture(options = {}) {
  const state = {
    content: 'export const original = true;\n', code: false, selected: false,
    key: 'ExactKey', readonly: false, editable: true, busy: false, offline: false,
    rowName: 'App.tsx', heading: 'App.tsx', level: 2, top: 32,
    folderName: 'src', folderTop: 0, folderLevel: 1, folderHeight: 32,
    folderExpanded: true, folderPresent: true, folderVisible: true,
    editorCount: 1, dispatches: [], expressions: [], ...options,
  };
  const listeners = new Set();
  const emit = (method, payload) => {
    for (const listener of listeners) listener({ method, params: { requestId: 'socket-id',
      response: { opcode: 1, payloadData: JSON.stringify(payload) } } });
  };
  const box = { getBoundingClientRect: () => ({ width: 300, height: 32 }), style: {} };
  const radio = { ...box, get checked() { return state.code; }, click() { state.code = true; } };
  const heading = { ...box, get value() { return state.heading; } };
  const view = {
    state: {
      get readOnly() { return state.readonly; },
      doc: { toString: () => state.content, get length() { return state.content.length; } },
    },
    dispatch(transaction) {
      state.beforeDispatch?.();
      state.dispatches.push(JSON.parse(JSON.stringify(transaction)));
      state.content = transaction.changes.insert;
      if (state.throwAfterDispatch) throw new Error('response lost after dispatch');
      if (state.saveMode !== 'absent') {
        emit('Network.webSocketFrameSent', { type: 'fs/file/write', requestId: 'save-id',
          data: { path: 'code/src/App.tsx', content: Buffer.from(state.content).toString('base64'), encoding: 'base64', workspaceId: 'workspace' } });
        emit('Network.webSocketFrameReceived', { type: 'fs/file/write', requestId: 'save-id',
          success: state.saveMode !== 'failed', data: { path: 'code/src/App.tsx', size: Buffer.byteLength(state.content), writtenAtMs: 1, modifiedAtMs: 1 } });
      }
    },
  };
  const editor = { ...box, cmView: { view }, getAttribute: (name) => name === 'contenteditable' ? String(state.editable) : null };
  const content = { style: { height: '64px' } };
  const viewport = { clientHeight: 200, scrollTop: 0, style: { overflowY: 'auto' } };
  content.parentElement = viewport;
  const fileRow = {
    ...box, parentElement: content,
    get style() { return { top: `${state.top}px` }; },
    getAttribute: (name) => ({ 'aria-label': state.rowName, 'aria-level': String(state.level) })[name] ?? null,
    querySelector: (selector) => selector === '[data-testid="code-file-item"]' ? fileControl : null,
  };
  const fileControl = {
    ...box,
    getAttribute: (name) => ({ 'aria-label': `File "${state.rowName}"`, 'aria-current': state.selected ? 'page' : null })[name] ?? null,
    closest: () => fileRow,
    click: () => { state.selected = true; },
  };
  const folderControl = { getAttribute: (name) => ({ 'aria-label': `Folder "${state.folderName}"`,
    'aria-expanded': String(state.folderExpanded) })[name] ?? null };
  const folderRow = {
    ...box, parentElement: content,
    get style() { return { top: `${state.folderTop}px` }; },
    getBoundingClientRect: () => ({ width: state.folderVisible ? 300 : 0, height: state.folderHeight }),
    getAttribute: (name) => ({ 'aria-label': state.folderName, 'aria-level': String(state.folderLevel),
      'aria-expanded': String(state.folderExpanded) })[name] ?? null,
    querySelector: (selector) => selector === '[data-testid="code-file-item"]' ? null : folderControl,
  };
  const tree = { ...box, parentElement: {}, querySelectorAll: () => [...(state.folderPresent ? [folderRow] : []), fileRow] };
  viewport.parentElement = tree;
  const stop = { ...box, innerText: 'Stop', getAttribute: () => 'Stop' };
  const document = {
    title: 'Test Make file', body: { get innerText() { return state.offline ? "Some changes won't be synced" : ''; } },
    querySelectorAll(selector) {
      if (selector === 'input[type="radio"][value="code"]') return [radio];
      if (selector === '.cm-content') return Array(state.editorCount).fill(editor);
      if (selector === '[data-testid="code-file-item"][aria-current="page"]') return state.selected ? [fileControl] : [];
      if (selector === 'h2 input[data-testid="code-file-name-input"]') return [heading];
      if (selector === '[data-testid="virtualized-file-tree-container"][role="tree"]') return state.code ? [tree] : [];
      if (selector === 'button[aria-label="Stop"], [data-testid="code-chat-send-button"]') return state.busy ? [stop] : [];
      throw new Error(`Unhandled test selector ${selector}`);
    },
  };
  const context = {
    document, URL, location: { get href() { return `https://www.figma.com/make/${state.key}/Test`; } },
    getComputedStyle: (element) => ({ display: 'block', visibility: 'visible', ...element.style }),
    setTimeout: (callback) => { callback(); return 1; },
  };
  const transport = {
    target: null,
    async connect() { this.target = { fileKey: 'ExactKey' }; return this; },
    async send(method, params) {
      state.methods = [...(state.methods || []), method];
      state.protocolCalls = [...(state.protocolCalls || []), { method, params }];
      if (method === 'Emulation.setFocusEmulationEnabled') {
        if (!params.enabled && state.hangFocusDisable) return new Promise(() => {});
        if (!params.enabled && state.focusDisableError) throw new Error('focus disable failed');
        state.focusEnabled = params.enabled;
        if (params.enabled && state.focusEnableError) throw new Error('focus enable reply lost');
      }
      return {};
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async evaluate(expression) {
      state.expressions.push(expression);
      const isWrite = expression.includes(')({"type":"replace"');
      state.beforeEvaluate?.({ expression, isWrite, state });
      if (state.hang || (state.hangReadback && state.dispatches.length)) return new Promise(() => {});
      const result = await vm.runInNewContext(expression, context);
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    },
    close() { state.closed = true; },
  };
  return { state, transport };
}

async function setup(t, options = {}, timeoutMs = 1000) {
  const f = fixture(options);
  const client = new MakeClient({ transport: f.transport, timeoutMs });
  await client.connect('ExactKey');
  const backupDir = await mkdtemp(join(tmpdir(), 'make-client-test-'));
  t.after(async () => { client.close(); await rm(backupDir, { recursive: true, force: true }); });
  return { ...f, client, backupDir };
}

test('inspect/list/read use Code and return exact file identity and content hash', async (t) => {
  const { client, state } = await setup(t);
  const info = await client.inspect();
  assert.equal(info.codeReady, true);
  assert.equal(info.fileKey, 'ExactKey');
  assert.equal(Object.hasOwn(info, 'content'), false);
  assert.deepEqual((await client.files()).map((entry) => entry.path), ['src', 'src/App.tsx']);
  assert.deepEqual(await client.read('src/App.tsx'), {
    fileKey: 'ExactKey', path: 'src/App.tsx', content: state.content, sha256: hash(state.content),
  });
  assert.equal(state.dispatches.length, 0);
});

test('replacement saves private original and metadata before one dispatch, then verifies its server acknowledgement', async (t) => {
  const { client, state, backupDir } = await setup(t);
  const original = state.content;
  let backupWasPresent = false;
  state.beforeDispatch = () => {
    // Backup completion precedes dispatch; no source text passes through shell interpolation.
    const directory = join(backupDir, readdirSync(backupDir)[0]);
    assert.equal(readFileSync(join(directory, 'original.txt'), 'utf8'), original);
    assert.equal(JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8')).sha256, hash(original));
    backupWasPresent = true;
  };
  const replacement = 'export const text = "`$()\\n😀";\n';
  const result = await client.replace('src/App.tsx', replacement, { expectedSha256: hash(original), backupDir });
  assert.equal(backupWasPresent, true);
  assert.equal(await readFile(result.backupPath, 'utf8'), original);
  const metadata = JSON.parse(await readFile(join(dirname(result.backupPath), 'metadata.json'), 'utf8'));
  assert.equal(metadata.path, 'src/App.tsx');
  assert.equal(metadata.fileKey, 'ExactKey');
  assert.equal(metadata.sha256, hash(original));
  assert.equal(metadata.replacementSha256, hash(replacement));
  assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(result.backupPath))).mode & 0o777, 0o700);
  assert.equal(state.dispatches.length, 1);
  assert.deepEqual(state.dispatches[0].changes, { from: 0, to: original.length, insert: replacement });
  assert.equal(result.sha256, hash(replacement));
  assert.equal(result.verification, 'server-acknowledged');
  assert.equal(result.persistence, 'acknowledged');
  assert.deepEqual(state.methods, ['Emulation.setFocusEmulationEnabled', 'Network.enable', 'Emulation.setFocusEmulationEnabled']);
  assert.equal(state.focusEnabled, false);
});

test('identical source content performs no write, save-observation setup, or backup', async (t) => {
  const { client, state, backupDir } = await setup(t);
  const result = await client.replace('src/App.tsx', state.content, { expectedSha256: hash(state.content), backupDir });
  assert.equal(result.changed, false);
  assert.equal(result.backupPath, null);
  assert.equal(result.verification, 'unchanged');
  assert.equal(result.persistence, 'unverified');
  assert.equal(state.dispatches.length, 0);
  assert.deepEqual(state.methods, ['Emulation.setFocusEmulationEnabled', 'Emulation.setFocusEmulationEnabled']);
  assert.equal(state.focusEnabled, false);
  assert.deepEqual(await readdir(backupDir), []);
});

test('missing and stale hashes never dispatch or create a backup', async (t) => {
  const { client, state, backupDir } = await setup(t);
  await assert.rejects(client.replace('src/App.tsx', 'new', { backupDir }), /expectedSha256/);
  await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash('stale'), backupDir }), /does not match/);
  assert.equal(state.dispatches.length, 0);
  assert.deepEqual(await readdir(backupDir), []);
});

test('rejects busy, offline, ambiguous editor, read-only, and mismatched heading states', async (t) => {
  for (const [change, expected] of [
    [{ busy: true }, /generating/], [{ offline: true }, /not be synced/],
    [{ editorCount: 2 }, /exactly one visible/], [{ readonly: true }, /read-only/],
    [{ editable: false }, /read-only/], [{ heading: 'Other.tsx' }, /heading/],
  ]) {
    const { client, state, backupDir } = await setup(t, change);
    await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir }), expected);
    assert.equal(state.dispatches.length, 0);
    assert.deepEqual(await readdir(backupDir), []);
  }
});

test('refuses changed file identity and changed source in the final synchronous pre-dispatch guard', async (t) => {
  for (const mutate of [
    (state) => { state.key = 'OtherKey'; },
    (state) => { state.content += '// collaborator edit'; },
    (state) => { state.top = 64; },
    (state) => { state.level = 3; },
    (state) => { state.rowName = 'Other.tsx'; },
    (state) => { state.selected = false; },
    (state) => { state.busy = true; },
    (state) => { state.offline = true; },
  ]) {
    const { client, state, backupDir } = await setup(t);
    state.beforeEvaluate = ({ isWrite }) => { if (isWrite) mutate(state); };
    let failure;
    await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir }), (error) => {
      failure = error;
      return /uncertain/.test(error.message) && /Original backup/.test(error.message);
    });
    assert.equal(state.dispatches.length, 0);
    assert.equal(readFileSync(failure.backupPath, 'utf8'), 'export const original = true;\n');
  }
});

test('backup failure prevents any mutation', async (t) => {
  const { client, state, backupDir } = await setup(t);
  await assert.rejects(client.replace('src/App.tsx', 'new', {
    expectedSha256: hash(state.content), backupDir: join(backupDir, '\0invalid'),
  }));
  assert.equal(state.dispatches.length, 0);
});

test('final ancestry guard refuses same-named, same-position, same-content leaves under changed parents', async (t) => {
  for (const mutate of [
    (state) => { state.folderName = 'other'; },
    (state) => { state.folderPresent = false; },
    (state) => { state.folderExpanded = false; },
    (state) => { state.folderTop = 1; },
    (state) => { state.folderLevel = 2; },
    (state) => { state.folderHeight = 31; },
    (state) => { state.folderVisible = false; },
  ]) {
    const { client, state, backupDir } = await setup(t);
    const original = state.content;
    state.beforeEvaluate = ({ isWrite }) => { if (isWrite) mutate(state); };
    await assert.rejects(client.replace('src/App.tsx', 'new', {
      expectedSha256: hash(original), backupDir,
    }), /ancestor|ancestry/);
    assert.equal(state.dispatches.length, 0);
    assert.equal(state.content, original);
    assert.equal(state.rowName, 'App.tsx');
    assert.equal(state.top, 32);
  }
});

test('read refuses changed parent metadata after selection', async (t) => {
  const { client, state } = await setup(t);
  state.beforeEvaluate = ({ expression }) => {
    if (expression.includes(')({"type":"read"')) state.folderName = 'other';
  };
  await assert.rejects(client.read('src/App.tsx'), /ancestor/);
  assert.equal(state.dispatches.length, 0);
});

test('lost response after dispatch reports original backup and never retries or rolls back', async (t) => {
  const { client, state, backupDir } = await setup(t, { throwAfterDispatch: true });
  let failure;
  await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir }), (error) => {
    failure = error;
    return error.outcome === 'uncertain' && /No retry or rollback/.test(error.message);
  });
  assert.equal(state.content, 'new');
  assert.equal(state.dispatches.length, 1);
  assert.equal(await readFile(failure.backupPath, 'utf8'), 'export const original = true;\n');
});

test('bounds the operation and rejects concurrent operations on the same editor', async (t) => {
  const { client, state } = await setup(t, { hang: true }, 30);
  const pending = assert.rejects(client.read('src/App.tsx'), /timed out/);
  await assert.rejects(client.files(), /already running/);
  await pending;
  assert.equal(state.dispatches.length, 0);
});

test('verification timeout after dispatch reports uncertainty without replaying the write', async (t) => {
  const { client, state, backupDir } = await setup(t, { hangReadback: true }, 100);
  await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir }), /uncertain.*timed out/);
  assert.equal(state.dispatches.length, 1);
  assert.equal(state.content, 'new');
});

test('missing or rejected save acknowledgements leave an uncertain outcome and backup, never success', async (t) => {
  for (const saveMode of ['absent', 'failed']) {
    const { client, state, backupDir } = await setup(t, { saveMode }, 100);
    let failure;
    await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir }), (error) => {
      failure = error;
      return error.outcome === 'uncertain';
    });
    assert.equal(state.dispatches.length, 1);
    assert.equal(await readFile(failure.backupPath, 'utf8'), 'export const original = true;\n');
  }
});

test('temporary focus emulation is restored after both successful and failed operations', async (t) => {
  for (const options of [{}, { busy: true }]) {
    const { client, state } = await setup(t, options);
    if (options.busy) await assert.rejects(client.read('src/App.tsx'), /generating/);
    else await client.read('src/App.tsx');
    assert.deepEqual(state.protocolCalls, [
      { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } },
      { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } },
    ]);
    assert.equal(state.focusEnabled, false);
  }
});

test('failed focus enable skips editor operations and still attempts cleanup', async (t) => {
  const { client, state, backupDir } = await setup(t, { focusEnableError: true });
  await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir }), /focus enable reply lost/);
  assert.equal(state.expressions.length, 0);
  assert.equal(state.dispatches.length, 0);
  assert.equal(state.focusEnabled, false);
  assert.deepEqual(await readdir(backupDir), []);
  assert.deepEqual(state.protocolCalls.map((call) => call.params.enabled), [true, false]);
});

test('cleanup failure is reported without masking the original operation error', async (t) => {
  const { client } = await setup(t, { busy: true, focusDisableError: true });
  await assert.rejects(client.read('src/App.tsx'), /generating.*focus emulation could not be disabled/);
});

test('cleanup is bounded within the operation timeout even when the renderer does not reply', async (t) => {
  const { client } = await setup(t, { hangFocusDisable: true }, 100);
  const started = Date.now();
  await assert.rejects(client.inspect(), /focus emulation could not be disabled.*timed out/);
  assert.ok(Date.now() - started < 250, 'cleanup must not wait for the default multi-second CDP timeout');
});
