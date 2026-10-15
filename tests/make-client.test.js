import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { MakeClient } from '../src/make-client.js';
import { makeWorkspace } from '../src/make-workspace.js';

const hash = (content) => createHash('sha256').update(content).digest('hex');

// Execute the production page expressions against a small observed-DOM fixture.
// Tree enumeration/selection, CodeMirror guards and the filesystem bridge remain
// real code in these tests. `extraFolders` nests the file deeper under src/.
function fixture(options = {}) {
  const extra = options.extraFolders || [];
  const original = 'export const original = true;\n';
  const path = ['src', ...extra, options.rowName || 'App.tsx'].join('/');
  const state = {
    content: original, code: false, selected: false,
    key: 'ExactKey', readonly: false, editable: true, busy: false, offline: false,
    rowName: 'App.tsx', heading: 'App.tsx', level: 2 + extra.length, top: 32 * (1 + extra.length),
    folderName: 'src', folderTop: 0, folderLevel: 1, folderHeight: 32,
    folderExpanded: true, folderPresent: true, folderVisible: true,
    editorCount: 1, workspace: false, filesTabs: 1, headers: 1, treeVisible: true,
    breadcrumbFolder: 'src', breadcrumbLeaf: 'App.tsx', tabClicks: 0, closeClicks: 0,
    clientHeight: 200, workspaceId: 'workspace', provisionOnFocus: true, reconnectOnClose: true, fetchOnSelect: false,
    fs: { [path]: original }, fsWrites: [], frames: [], sockets: [],
    dispatches: [], expressions: [], ...options,
  };
  state.path = path;
  // Make's saved files, served over its filesystem WebSocket protocol.
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    constructor(url = 'wss://www.figma.com/api/agentcontrol/subscribe') {
      super(); this.url = url; this.readyState = 1; state.sockets.push(this);
    }
    send(payload) { serve(this, payload); }
    close() {
      this.readyState = 3; this.dispatchEvent(new Event('close'));
      // A visible Make page reconnects its agent socket after it closes.
      if (state.focusEnabled && state.reconnectOnClose && this.url === 'wss://www.figma.com/api/agentcontrol/subscribe') provision();
    }
  }
  const deliver = (socket, data) => Promise.resolve().then(() =>
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })));
  function serve(socket, payload) {
    const message = JSON.parse(payload);
    state.frames.push(message);
    if (message.type === 'control/workspace_create') {
      socket.workspaceCreated = true;
      return deliver(socket, { type: 'control/workspace_create_ack', success: true, data: { created: true } });
    }
    if (!message.type?.startsWith('fs/')) return;
    // Observed live: an uncorrelated error, so the request itself never resolves.
    if (!socket.workspaceCreated) {
      return deliver(socket, { type: 'error', success: false, error: { message: `control/workspace_create must be sent before ${message.type}` } });
    }
    const file = message.data?.path?.replace(/^code\//, '');
    let reply;
    if (message.data?.workspaceId !== state.workspaceId) reply = { success: false };
    else if (message.type === 'fs/file/read') {
      state.beforeFsRead?.({ path: file, state });
      if (state.hangReads) return;
      reply = Object.hasOwn(state.fs, file)
        ? { success: true, data: { path: message.data.path, encoding: 'base64', content: Buffer.from(state.fs[file]).toString('base64') } }
        : { success: false };
    } else if (message.type === 'fs/file/write') {
      state.beforeFsWrite?.({ path: file, state });
      state.fsWrites.push(file);
      const written = Buffer.from(message.data.content, 'base64').toString('utf8');
      if (state.writeMode !== 'rejected') state.fs[file] = state.writeMode === 'corrupt' ? `${written}// changed` : written;
      if (state.writeMode === 'lost') { state.hangReads = true; return; }
      reply = state.writeMode === 'rejected' ? { success: false }
        : { success: true, data: { path: message.data.path, size: Buffer.byteLength(written), writtenAtMs: 1, modifiedAtMs: 2 } };
    } else if (message.type === 'fs/file/delete') {
      state.fsDeletes = [...(state.fsDeletes || []), file];
      delete state.fs[file];
      reply = { success: true, data: { path: message.data.path } };
    } else reply = { success: false };
    deliver(socket, { type: message.type, requestId: message.requestId, ...reply });
  }
  // Make's long-lived socket; it reads a file it has not cached when opened.
  state.makeSocket = new FakeSocket();
  state.makeSocket.workspaceCreated = true;
  // A reconnect provisions first and creates its workspace after the server's
  // provisioning acknowledgement (about a second later, observed live).
  const provision = () => {
    const socket = new FakeSocket(state.provisionUrl);
    socket.send(JSON.stringify({ type: 'control/provision', data: { namespace: 'namespace', workspaceId: state.workspaceId } }));
    setTimeout(() => socket.send(JSON.stringify({ type: 'control/workspace_create', data: { seeded: true } })), state.workspaceDelay ?? 20);
  };
  const listeners = new Set();
  const emit = (method, payload) => {
    for (const listener of listeners) listener({ method, params: { requestId: 'socket-id',
      response: { opcode: 1, payloadData: JSON.stringify(payload) } } });
  };
  const box = { getBoundingClientRect: () => ({ width: 300, height: 32 }), style: {} };
  const radio = { ...box, get checked() { return state.code; }, click() { state.code = true; } };
  const previewRadio = { ...box, get checked() { return !state.code; }, click() { state.code = false; } };
  const heading = { ...box, get value() { return state.heading; } };
  const view = {
    state: {
      get readOnly() { return state.readonly; },
      get values() { return state.lintValues; },
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
  const content = { style: { height: `${32 * (2 + extra.length)}px` } };
  const viewport = { get clientHeight() { return state.clientHeight; }, scrollTop: 0, style: { overflowY: 'auto' } };
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
    click: () => {
      state.selected = true;
      if (state.fetchOnSelect) state.makeSocket.send(JSON.stringify({ type: 'fs/file/read', requestId: 'make-read',
        data: { path: `code/${state.path}`, encoding: 'base64', workspaceId: state.workspaceId } }));
    },
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
  const extraRows = extra.map((name, index) => {
    const control = { getAttribute: (attribute) => ({ 'aria-label': `Folder "${name}"`, 'aria-expanded': 'true' })[attribute] ?? null };
    return { ...box, parentElement: content, style: { top: `${32 * (index + 1)}px` },
      getAttribute: (attribute) => ({ 'aria-label': name, 'aria-level': String(index + 2), 'aria-expanded': 'true' })[attribute] ?? null,
      querySelector: (selector) => selector === '[data-testid="code-file-item"]' ? null : control };
  });
  const tree = { ...box, parentElement: {}, querySelectorAll: () => [...(state.folderPresent ? [folderRow] : []), ...extraRows, fileRow] };
  viewport.parentElement = tree;
  const stop = { ...box, innerText: 'Stop', getAttribute: () => 'Stop' };
  // Each Files tab is distinct; its title is a filename (state.tabTitles), never the project name.
  const filesTabPairs = [];
  const filesTabPair = index => filesTabPairs[index] ??= (() => {
    const tab = { ...box, get innerText() { return state.tabTitles?.[index] ?? (state.selected ? state.rowName : 'Files'); },
      click() { state.tabClicks++; state.clickedTabs = [...(state.clickedTabs || []), index]; state.code = true; } };
    const close = { ...box, click() { state.closeClicks++; }, parentElement: { querySelectorAll: () => [tab, close] } };
    return [tab, close];
  })();
  const [filesTab, closeTab] = filesTabPair(0);
  const closeTabs = () => Array.from({ length: state.filesTabs }, (_, index) => filesTabPair(index)[1]);
  const browserTab = { ...box, innerText: 'Browser', click() { state.previewClicks = (state.previewClicks || 0) + 1; state.code = false; } };
  const addTab = { ...box, getAttribute: () => String(!!state.menuOpen),
    click() { state.addClicks = (state.addClicks || 0) + 1; state.menuOpen = true; } };
  const filesOption = { ...box, innerText: 'Files', getAttribute: () => state.menuDisabled ? 'true' : null,
    click() { state.filesTabs++; state.code = true; state.menuOpen = false; state.filesClicks = (state.filesClicks || 0) + 1; } };
  const menu = { ...box, querySelectorAll: () => Array(state.menuOptions ?? 1).fill(filesOption) };
  const navigation = { ...box, querySelectorAll: selector => selector === 'button[aria-label="Close Files tab"]'
    ? closeTabs() : [browserTab, filesTab, closeTab] };
  const showFiles = { ...box, click() { state.treeVisible = true; } };
  const filesHeader = { ...box, querySelectorAll: () => state.treeVisible ? [] : [showFiles] };
  const leaf = { ...box, get textContent() { return state.breadcrumbLeaf; } };
  const crumbs = { ...box, get children() { return [{ ...box, textContent: 'Test project' },
    { ...box, get textContent() { return state.breadcrumbFolder; } }, leaf]; } };
  const workspace = { ...box, getBoundingClientRect: () => ({ width: state.workspaceWidth ?? 300, height: 200 }),
    querySelectorAll: selector => document.querySelectorAll(selector) };
  const document = {
    title: 'Test Make file', body: { get innerText() { return state.offline ? "Some changes won't be synced" : ''; } },
    querySelectorAll(selector) {
      if (selector === 'nav[aria-label="Editor views"] button[aria-label="Close Files tab"]') return closeTabs();
      if (selector === 'nav[aria-label="Editor views"] button[aria-label="Add workspace tab"]') return Array(state.addControls ?? 1).fill(addTab);
      if (selector === '[role="menu"]') return state.menuOpen ? Array(state.menuCount ?? 1).fill(menu) : [];
      if (selector === 'input[type="radio"][value="code"]') return state.workspace ? [] : [radio];
      if (selector === 'input[type="radio"][value="preview"]') return state.workspace ? [] : [previewRadio];
      if (selector === '[data-testid="figmake-workspace-container"]') return state.workspace ? [workspace] : [];
      if (selector === 'nav[aria-label="Editor views"]') return [navigation];
      if (selector === '[data-testid="files-workspace-header"]') return state.code ? Array(state.headers).fill(filesHeader) : [];
      if (selector === '[data-testid="files-workspace-header"] nav[aria-label="File path"]') return state.code ? [crumbs] : [];
      if (selector === '[data-testid="files-workspace-selected-file"]') return state.code ? [leaf] : [];
      if (selector === '.cm-content') return Array(state.editorCount).fill(editor);
      if (selector === '[data-testid="code-file-item"][aria-current="page"]') return state.selected ? [fileControl] : [];
      if (selector === 'h2 input[data-testid="code-file-name-input"]') return [heading];
      if (selector === '[data-testid="virtualized-file-tree-container"][role="tree"]') return state.code && state.treeVisible ? [tree] : [];
      if (selector === 'button[aria-label="Stop"], [data-testid="code-chat-send-button"]') return state.busy ? [stop] : [];
      throw new Error(`Unhandled test selector ${selector}`);
    },
  };
  const context = {
    document, URL, location: { get href() { return `https://www.figma.com/make/${state.key}/Test`; } },
    getComputedStyle: (element) => ({ display: 'block', visibility: 'visible', ...element.style }),
    // Short page waits run immediately; bridge timeouts and capture windows are
    // real but never keep the test process alive.
    setTimeout: (callback, ms) => {
      if (!(ms > 100)) { callback(); return 0; }
      const timer = setTimeout(callback, ms);
      timer.unref();
      return timer;
    },
    clearTimeout: (timer) => { if (timer) clearTimeout(timer); },
    WebSocket: FakeSocket, Event, MessageEvent, Buffer,
  };
  const objects = new Map();
  const remoteError = (error) => ({ exceptionDetails: { exception: { description: error.message } } });
  const transport = {
    target: null,
    async connect() { this.target = { fileKey: 'ExactKey' }; return this; },
    // Like the real transport, every CDP command has its own timeout.
    async send(method, params, { timeoutMs } = {}) {
      if (!timeoutMs) return this._send(method, params);
      let timer;
      try {
        return await Promise.race([this._send(method, params), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Make CDP ${method} timed out; the command was not retried`)), timeoutMs);
        })]);
      } finally { clearTimeout(timer); }
    },
    async _send(method, params) {
      state.methods = [...(state.methods || []), method];
      state.protocolCalls = [...(state.protocolCalls || []), { method, params }];
      if (method === 'Emulation.setFocusEmulationEnabled') {
        if (!params.enabled && state.hangFocusDisable) return new Promise(() => {});
        if (!params.enabled && state.focusDisableError) throw new Error('focus disable failed');
        state.focusEnabled = params.enabled;
        // A hidden Make page reconnects its agent socket when it gains focus.
        if (params.enabled && state.provisionOnFocus) provision();
        if (params.enabled && state.focusEnableError) throw new Error('focus enable reply lost');
      }
      if (method === 'Runtime.evaluate') {
        try {
          const objectId = `object-${objects.size + 1}-${Math.random()}`;
          objects.set(objectId, vm.runInNewContext(params.expression, context));
          return { result: { objectId } };
        } catch (error) { return remoteError(error); }
      }
      if (method === 'Runtime.callFunctionOn') {
        try {
          const fn = vm.runInNewContext(`(${params.functionDeclaration})`, context);
          const value = await fn.apply(objects.get(params.objectId), (params.arguments || []).map((arg) => arg.value));
          return { result: { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } };
        } catch (error) { return remoteError(error); }
      }
      if (method === 'Runtime.queryObjects') {
        const prototype = objects.get(params.prototypeObjectId);
        const objectId = `object-${objects.size + 1}-${Math.random()}`;
        objects.set(objectId, state.sockets.filter(socket => prototype.isPrototypeOf(socket)));
        return { objects: { objectId } };
      }
      if (method === 'Runtime.releaseObject') objects.delete(params.objectId);
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

// Normal operations use the production budget: Windows CI may take more than
// one second to create/flush a private backup. Timeout tests pass short budgets.
async function setup(t, options = {}, timeoutMs = 15000) {
  const f = fixture(options);
  const client = new MakeClient({ transport: f.transport, timeoutMs });
  await client.connect('ExactKey');
  const backupDir = await mkdtemp(join(tmpdir(), 'make-client-test-'));
  t.after(async () => { client.close(); await rm(backupDir, { recursive: true, force: true }); });
  return { ...f, client, backupDir };
}

test('inspect/list/read use Code and return exact saved content and hash through the filesystem bridge', async (t) => {
  const { client, state } = await setup(t);
  const info = await client.inspect();
  assert.equal(info.codeReady, true);
  assert.equal(info.fileKey, 'ExactKey');
  assert.equal(Object.hasOwn(info, 'content'), false);
  assert.deepEqual((await client.files()).map((entry) => entry.path), ['src', 'src/App.tsx']);
  assert.deepEqual(await client.read('src/App.tsx'), {
    fileKey: 'ExactKey', path: 'src/App.tsx', content: state.content, sha256: hash(state.content), source: 'filesystem',
  });
  assert.equal(state.selected, false, 'a bridge read selects no tree row');
  assert.equal(state.dispatches.length, 0);
  assert.equal(state.fsWrites.length, 0);
});

test('Files workspace opens without Code radios and reads after the tab becomes a filename', async t => {
  // Without an observable filesystem socket, read falls back to the editor.
  const { client, state } = await setup(t, { workspace: true, provisionOnFocus: false, reconnectOnClose: false });
  const info = await client.inspect();
  assert.equal(info.workspaceMode, 'files-workspace');
  assert.equal(info.codeReady, true);
  const result = await client.read('src/App.tsx');
  assert.equal(result.sha256, hash(state.content));
  assert.equal(result.source, 'editor');
  assert.equal((await client.inspect()).selectedName, 'App.tsx');
  assert.equal(state.tabClicks, 1);
  assert.equal(state.closeClicks, 0);
  assert.equal(state.dispatches.length, 0);
});

test('Files workspace reuses one visible pane among multiple tabs and reveals a hidden tree', async t => {
  for (const treeVisible of [true, false]) {
    const { client, state } = await setup(t, { workspace: true, filesTabs: 2, code: true, treeVisible });
    assert.equal((await client.read('src/App.tsx')).sha256, hash(state.content));
    assert.equal(state.tabClicks, 0);
    assert.equal(state.closeClicks, 0);
    assert.equal(state.treeVisible, true);
  }
});

test('Files workspace reuses one inactive Files tab whose title is a filename, not the project name', async t => {
  const { client, state } = await setup(t, { workspace: true, filesTabs: 1, tabTitles: ['Inputs.tsx'] });
  const info = await client.inspect();
  assert.equal(info.codeReady, true);
  assert.equal(info.workspaceMode, 'files-workspace');
  assert.equal((await client.read('src/App.tsx')).sha256, hash(state.content));
  assert.deepEqual(state.clickedTabs, [0]);
  assert.equal(state.addClicks || 0, 0);
  assert.equal(state.filesTabs, 1);
  assert.equal(state.closeClicks, 0);
  assert.equal(state.dispatches.length, 0);
});

test('several inactive Files tabs on the exact project page reuse the first in tab order', async t => {
  const { client, state } = await setup(t, { workspace: true, filesTabs: 3,
    tabTitles: ['Inputs.tsx', 'ToggleControls.d.ts', 'HInge Connector Selector'] });
  assert.equal((await client.inspect()).codeReady, true);
  assert.deepEqual((await client.files()).map(entry => entry.path), ['src', 'src/App.tsx']);
  assert.deepEqual(state.clickedTabs, [0]);
  assert.equal(state.addClicks || 0, 0);
  assert.equal(state.filesTabs, 3);
  assert.equal(state.closeClicks, 0);
  assert.equal(state.dispatches.length, 0);
});

test('inactive Files tabs on another project page are never selected', async t => {
  const { client, state } = await setup(t, { workspace: true, filesTabs: 2, tabTitles: ['App.tsx', 'Inputs.tsx'] });
  // The renderer navigated to a different project after connecting by exact key.
  state.key = 'OtherKey';
  await assert.rejects(client.inspect(), /no longer matches the requested file key/);
  await assert.rejects(client.files(), /no longer matches the requested file key/);
  assert.equal(state.tabClicks, 0);
  assert.equal(state.addClicks || 0, 0);
  assert.equal(state.filesTabs, 2);
  assert.equal(state.dispatches.length, 0);
});

test('Files workspace opens one new tab when none exists and reuses it on subsequent reads', async t => {
  const { client, state } = await setup(t, { workspace: true, filesTabs: 0 });
  assert.equal((await client.inspect()).codeReady, true);
  assert.equal((await client.read('src/App.tsx')).sha256, hash(state.content));
  assert.equal(state.addClicks, 1);
  assert.equal(state.filesClicks, 1);
  assert.equal(state.closeClicks, 0);
  assert.equal(state.dispatches.length, 0);
});

test('Files tab creation rejects unavailable, ambiguous and disabled menu controls', async t => {
  for (const options of [{ addControls: 0 }, { addControls: 2 }, { menuCount: 2 }, { menuOptions: 2 }, { menuDisabled: true }]) {
    const { client, state } = await setup(t, { workspace: true, filesTabs: 0, ...options });
    await assert.rejects(client.inspect(), /unavailable|ambiguous|disabled/);
    assert.equal(state.filesTabs, 0);
    assert.equal(state.filesClicks || 0, 0);
    assert.equal(state.closeClicks, 0);
    assert.equal(state.dispatches.length, 0);
  }
});

test('Files workspace refuses multiple visible pane headers before selecting or writing', async t => {
  const { client, state } = await setup(t, { workspace: true, code: true, headers: 2 });
  await assert.rejects(client.inspect(), /Multiple visible Make Files panes/);
  assert.equal(state.tabClicks, 0);
  assert.equal(state.dispatches.length, 0);
});

test('restored zero-size workspace reports manual readiness recovery without selecting hidden controls', async t => {
  const { client, state } = await setup(t, { workspace: true, workspaceWidth: 0 });
  await assert.rejects(client.inspect(), /Select this project tab in Figma Desktop/);
  assert.equal(state.tabClicks, 0);
  assert.equal(state.closeClicks, 0);
  assert.equal(state.dispatches.length, 0);
});

test('Files workspace replacement writes through the bridge without touching the editor or tabs', async t => {
  const { client, state, backupDir } = await setup(t, { workspace: true });
  const original = state.content;
  const result = await client.replace('src/App.tsx', 'export const changed = true;\n', {
    expectedSha256: hash(original), backupDir,
  });
  assert.equal(readFileSync(result.backupPath, 'utf8'), original);
  assert.equal(state.fs['src/App.tsx'], 'export const changed = true;\n');
  assert.equal(result.sha256, hash(state.fs['src/App.tsx']));
  assert.equal(state.dispatches.length, 0);
  assert.equal(state.selected, false);
  assert.equal(state.closeClicks, 0);
});

test('Files breadcrumb must match the full selected path for editor reads', async t => {
  for (const final of [false, true]) {
    for (const field of ['breadcrumbFolder', 'breadcrumbLeaf']) {
      const { client, state } = await setup(t, { workspace: true });
      if (final) state.beforeEvaluate = ({ expression }) => { if (expression.includes(')({"type":"read"')) state[field] = 'other'; };
      else state[field] = 'other';
      await assert.rejects(client.diagnostics('src/App.tsx'), /breadcrumb/);
      assert.equal(state.dispatches.length, 0);
    }
  }
});

test('preview selection supports Browser workspace and legacy radio without closing Files', async t => {
  for (const workspace of [false, true]) {
    const { transport, state } = await setup(t, { workspace, code: true });
    const result = await transport.evaluate(`(() => { const value = (${makeWorkspace.toString()})('ensure-preview'); return { mode: value.mode }; })()`);
    assert.equal(result.mode, workspace ? 'files-workspace' : 'legacy-code');
    assert.equal(state.code, false);
    assert.equal(state.closeClicks, 0);
    assert.equal(state.dispatches.length, 0);
  }
});

test('diagnostics reads editor ranges without changing source and distinguishes unavailable lint', async (t) => {
  const { client, state } = await setup(t, {}, 4000);
  assert.deepEqual((await client.diagnostics('src/App.tsx')).diagnostics, []);
  assert.equal((await client.diagnostics('src/App.tsx')).available, false);
  state.lintValues = [{ diagnostics: { between(_from, _to, visit) {
    const value = { spec: { diagnostics: [{ severity: 'error', message: 'Missing component type' }] } };
    visit(0, 6, value); visit(0, 6, value);
  } } }];
  const result = await client.diagnostics('src/App.tsx');
  assert.equal(result.available, true);
  assert.equal(result.sha256, hash(state.content));
  assert.deepEqual(result.diagnostics, [{ from: 0, to: 6, line: 1, severity: 'error', message: 'Missing component type' }]);
  assert.equal(state.dispatches.length, 0);
});

test('remote read returns exact saved UTF-8 including a BOM and disposes the read-only bridge', async (t) => {
  const { client, state } = await setup(t);
  const content = '\uFEFF# Kit guidance\nReadable source 😀\n';
  let disposed = false;
  client._fileBridge = async () => ({
    invoke: async (_fn, [type, data]) => {
      assert.equal(type, 'fs/file/read');
      assert.deepEqual(data, { path: 'code/src/App.tsx', encoding: 'base64' });
      return { success: true, data: { ...data, content: Buffer.from(content).toString('base64') } };
    },
    dispose: async () => { disposed = true; },
  });
  assert.deepEqual(await client.read('src/App.tsx', { remote: true }), {
    fileKey: 'ExactKey', path: 'src/App.tsx', content, sha256: hash(content), source: 'filesystem',
  });
  assert.equal(disposed, true);
  assert.equal(state.dispatches.length, 0);
});

test('remote read admits hidden package source but rejects missing project paths and traversal', async (t) => {
  const { client } = await setup(t);
  let calls = 0;
  client._fileBridge = async () => ({
    invoke: async (_fn, [type, data]) => {
      calls++;
      assert.equal(type, 'fs/file/read');
      return { success: true, data: { ...data, content: '' } };
    },
    dispose: async () => {},
  });
  const path = 'node_modules/example/guidelines/Guidelines.md';
  assert.equal((await client.read(path, { remote: true })).path, path);
  const hidden = 'src/vendor/atomic-aui/tokens/generated/.generated';
  assert.equal((await client.read(hidden, { remote: true })).path, hidden);
  await assert.rejects(client.read('missing.md', { remote: true }), /missing/);
  await assert.rejects(client.read('node_modules/../../private', { remote: true }));
  assert.equal(calls, 2);
});

test('remote read rejects mismatched identity, encoding and malformed text, always releasing the bridge', async (t) => {
  for (const data of [
    { path: 'code/other.tsx', encoding: 'base64', content: '' },
    { path: 'code/src/App.tsx', encoding: 'utf8', content: '' },
    { path: 'code/src/App.tsx', encoding: 'base64', content: 'not base64!' },
    { path: 'code/src/App.tsx', encoding: 'base64', content: Buffer.from([0xff]).toString('base64') },
  ]) {
    const { client, state } = await setup(t);
    let disposed = false;
    client._fileBridge = async () => ({
      invoke: async () => ({ success: true, data }),
      dispose: async () => { disposed = true; },
    });
    await assert.rejects(client.read('src/App.tsx', { remote: true }));
    assert.equal(disposed, true);
    assert.equal(state.dispatches.length, 0);
  }
});

test('replacement backs up the saved original before one bridge write, then verifies the acknowledgement and readback', async (t) => {
  const { client, state, backupDir } = await setup(t);
  const original = state.content;
  let backupWasPresent = false;
  state.beforeFsWrite = () => {
    // Backup completion precedes the write; no source text passes through shell interpolation.
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
  assert.equal(metadata.operation, 'replace');
  assert.equal(metadata.sha256, hash(original));
  assert.equal(metadata.replacementSha256, hash(replacement));
  // Windows access control uses ACLs; POSIX permission bits are not equivalent.
  if (process.platform !== 'win32') {
    assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(result.backupPath))).mode & 0o777, 0o700);
  }
  assert.deepEqual(state.fsWrites, ['src/App.tsx']);
  assert.equal(state.fs['src/App.tsx'], replacement);
  // Read for the hash, re-read just before the write, then read back.
  assert.deepEqual(state.frames.filter(frame => frame.type?.startsWith('fs/')).map(frame => frame.type),
    ['fs/file/read', 'fs/file/read', 'fs/file/write', 'fs/file/read']);
  assert.equal(state.dispatches.length, 0);
  assert.equal(result.sha256, hash(replacement));
  assert.equal(result.changed, true);
  // The bridge writes the session's working copy only; never claim a save.
  assert.equal(result.verification, 'session-readback-matched');
  assert.equal(result.readback, 'matched');
  assert.equal(result.persistence, 'session-only');
  assert.match(result.note, /lost when the file is reopened unless it is saved in Make/);
  assert.deepEqual(result.receipt, { path: 'src/App.tsx', bytes: Buffer.byteLength(replacement), writtenAtMs: 1, modifiedAtMs: 2 });
  assert.equal(state.methods.includes('Network.enable'), false);
  assert.equal(state.focusEnabled, false);
});

test('removal backs up the original, deletes it from the session and reports it session-only', async (t) => {
  const { client, state, backupDir } = await setup(t);
  const original = state.content;
  const result = await client.remove('src/App.tsx', { expectedSha256: hash(original), backupDir });
  assert.equal(await readFile(result.backupPath, 'utf8'), original);
  assert.deepEqual(state.fsDeletes, ['src/App.tsx']);
  assert.equal(Object.hasOwn(state.fs, 'src/App.tsx'), false);
  assert.equal(result.verification, 'session-delete-accepted');
  assert.equal(result.persistence, 'session-only');
  assert.match(result.note, /lost when the file is reopened/);
});

test('removal refuses a stale hash before any backup or delete', async (t) => {
  const { client, state, backupDir } = await setup(t);
  await assert.rejects(client.remove('src/App.tsx', { expectedSha256: hash('stale'), backupDir }), /removal refused/);
  assert.equal(state.fsDeletes, undefined);
  assert.deepEqual(await readdir(backupDir), []);
});

test('replacement works for a deeply nested file whose folder chain cannot fit in the file-tree viewport', async (t) => {
  const extraFolders = ['components', 'lib', 'forms', 'fields'];
  const { client, state, backupDir } = await setup(t, { extraFolders, rowName: 'Field.tsx', heading: 'Field.tsx', clientHeight: 64 });
  const path = 'src/components/lib/forms/fields/Field.tsx';
  assert.equal(state.path, path);
  // The editor path refuses this file: its ancestry needs 192px of a 64px tree.
  await assert.rejects(client.diagnostics(path), /cannot fit in the file-tree viewport/);
  const read = await client.read(path);
  assert.equal(read.source, 'filesystem');
  assert.equal(read.sha256, hash(state.fs[path]));
  const result = await client.replace(path, 'export const field = 1;\n', { expectedSha256: read.sha256, backupDir });
  assert.equal(result.changed, true);
  assert.equal(state.fs[path], 'export const field = 1;\n');
  assert.deepEqual(state.fsWrites, [path]);
  assert.equal(JSON.parse(await readFile(join(dirname(result.backupPath), 'metadata.json'), 'utf8')).path, path);
  assert.equal(state.dispatches.length, 0);
});

test('durable read-back of a deep unselectable file accepts three views only while the editor shows another path', async (t) => {
  const extraFolders = ['components', 'lib', 'forms', 'fields'];
  const path = 'src/components/lib/forms/fields/Field.tsx';
  const { client, state } = await setup(t, { workspace: true, extraFolders, rowName: 'Field.tsx', heading: 'Field.tsx', clientHeight: 64 });
  client._durable = async ({ path: target }) => ({ exists: Object.hasOwn(state.fs, target), content: state.fs[target] });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async (_bridge, target) => ({ content: state.fs[target] });
  const expected = state.fs[path];
  await assert.rejects(client.diagnostics(path), error => error.code === 'MAKE_TREE_VIEWPORT');
  assert.equal(await client._durableAgreement(path, expected, Date.now() + 5000), 'tree-vfs-sandbox-matched');
  Object.assign(state, { breadcrumbFolder: 'src/components/lib/forms/fields', breadcrumbLeaf: 'Field.tsx' });
  await assert.rejects(client._durableAgreement(path, expected, Date.now() + 1500), /editor unavailable/);
  state.workspace = false;
  await assert.rejects(client._durableAgreement(path, expected, Date.now() + 1500), /editor unavailable/);
  state.editorCount = 0;
  assert.equal(await client._durableAgreement(path, expected, Date.now() + 5000), 'tree-vfs-sandbox-matched');
});

test('Markdown reads through the bridge, where the editor shows no source document', async (t) => {
  const { client, state } = await setup(t, { rowName: 'Guidelines.md', heading: 'Guidelines.md', editorCount: 0 });
  const content = '# Guidelines\n\nUse the kit.\n';
  state.fs['src/Guidelines.md'] = content;
  assert.deepEqual(await client.read('src/Guidelines.md'), {
    fileKey: 'ExactKey', path: 'src/Guidelines.md', content, sha256: hash(content), source: 'filesystem',
  });
  assert.equal(state.selected, false);
});

test('bridge capture succeeds although every file is already cached by Make', async (t) => {
  // Make sends no fs/file/read when a cached file opens; the reconnect that
  // focus emulation triggers identifies the socket instead.
  const { client, state } = await setup(t, { fetchOnSelect: false });
  assert.equal((await client.read('src/App.tsx')).source, 'filesystem');
  assert.equal(state.selected, false, 'no candidate file had to be opened');
  assert.equal(state.frames.filter(frame => frame.type === 'control/provision').length, 1);
});

test('a provisioned socket is used only after Make acknowledges creating its workspace', async (t) => {
  const { client, state } = await setup(t, { workspaceDelay: 400 });
  assert.equal((await client.read('src/App.tsx')).source, 'filesystem');
  const types = state.frames.map(frame => frame.type);
  assert.ok(types.indexOf('control/workspace_create') < types.indexOf('fs/file/read'));
  assert.equal(state.frames.some(frame => frame.type === 'error'), false);
});

test('an open agent socket that provisioned unobserved is reconnected so its provisioning identifies it', async (t) => {
  const { client, state } = await setup(t, { provisionOnFocus: false });
  assert.equal((await client.read('src/App.tsx', { remote: true })).source, 'filesystem');
  assert.equal(state.makeSocket.readyState, 3, 'the unidentified socket was closed');
  assert.equal(state.selected, false, 'no file had to be opened');
  assert.equal(state.frames.filter(frame => frame.type === 'control/provision').length, 1);
  // The reconnected socket is cached, so the next operation leaves it open.
  assert.equal((await client.read('src/App.tsx', { remote: true })).source, 'filesystem');
  assert.equal(state.sockets.filter(socket => socket.readyState === 1).length, 1);
});

test('an unidentified agent socket is left open while Make is generating', async (t) => {
  const { client, state } = await setup(t, { provisionOnFocus: false, busy: true });
  await assert.rejects(client.read('src/App.tsx', { remote: true }), error => error.code === 'MAKE_FILESYSTEM_UNAVAILABLE');
  assert.equal(state.makeSocket.readyState, 1);
});

test('a captured socket is reused by later operations until it closes', async (t) => {
  const { client, state } = await setup(t);
  await client.read('src/App.tsx');
  state.provisionOnFocus = false;
  assert.equal((await client.read('src/App.tsx', { remote: true })).source, 'filesystem');
  for (const socket of state.sockets) socket.close();
  await assert.rejects(client.read('src/App.tsx', { remote: true }), error => error.code === 'MAKE_FILESYSTEM_UNAVAILABLE');
});

test('capture ignores provisioning from another host or an insecure socket', async (t) => {
  for (const change of [
    (state) => { state.provisionUrl = 'wss://evil.example/api/agentcontrol/subscribe'; },
    (state) => { state.provisionUrl = 'ws://www.figma.com/api/agentcontrol/subscribe'; },
  ]) {
    const { client, state, backupDir } = await setup(t, { provisionOnFocus: false });
    change(state);
    state.provisionOnFocus = true;
    await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir }),
      error => error.code === 'MAKE_FILESYSTEM_UNAVAILABLE' && /no files were written/.test(error.message));
    assert.deepEqual(state.fsWrites, []);
    assert.deepEqual(await readdir(backupDir), []);
  }
});

test('without a filesystem connection, read falls back to the editor but replacement writes nothing', async (t) => {
  const { client, state, backupDir } = await setup(t, { provisionOnFocus: false, reconnectOnClose: false });
  assert.equal((await client.read('src/App.tsx')).source, 'editor');
  await assert.rejects(client.read('src/App.tsx', { remote: true }), /no files were written/);
  await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir }), /no files were written/);
  assert.deepEqual(state.fsWrites, []);
  assert.deepEqual(await readdir(backupDir), []);
  assert.equal(state.dispatches.length, 0);
});

test('identical source content performs no write or backup', async (t) => {
  const { client, state, backupDir } = await setup(t);
  const result = await client.replace('src/App.tsx', state.content, { expectedSha256: hash(state.content), backupDir });
  assert.equal(result.changed, false);
  assert.equal(result.backupPath, null);
  assert.equal(result.verification, 'unchanged');
  assert.equal(result.persistence, 'unverified');
  assert.deepEqual(state.fsWrites, []);
  assert.equal(state.focusEnabled, false);
  assert.deepEqual(await readdir(backupDir), []);
});

test('missing and stale hashes never write or create a backup', async (t) => {
  const { client, state, backupDir } = await setup(t);
  await assert.rejects(client.replace('src/App.tsx', 'new', { backupDir }), /expectedSha256/);
  await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash('stale'), backupDir }), /does not match/);
  // The saved file differs from what an earlier read hashed.
  state.fs['src/App.tsx'] = 'export const collaborator = true;\n';
  await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir }), /does not match/);
  assert.deepEqual(state.fsWrites, []);
  assert.deepEqual(await readdir(backupDir), []);
});

test('replacement refuses missing files, folders and unsafe paths and never creates', async (t) => {
  const { client, state, backupDir } = await setup(t);
  for (const [path, expected] of [
    ['src/Missing.tsx', /missing/], ['src', /missing/], ['src/../App.tsx', /unambiguous/],
    ['node_modules/pkg/index.js', /missing/],
  ]) {
    await assert.rejects(client.replace(path, 'new', { expectedSha256: hash(state.content), backupDir }), expected);
  }
  // Listed in the tree but absent from saved storage: refused before any backup.
  delete state.fs['src/App.tsx'];
  await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir }), /read failed/);
  assert.deepEqual(state.fsWrites, []);
  assert.deepEqual(await readdir(backupDir), []);
});

test('replacement refuses while Make is generating, offline or read-only', async (t) => {
  for (const [change, expected] of [
    [{ busy: true }, /generating/], [{ offline: true }, /not be synced/], [{ readonly: true }, /read-only/],
  ]) {
    const { client, state, backupDir } = await setup(t, change);
    await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir }), expected);
    assert.deepEqual(state.fsWrites, []);
    assert.deepEqual(await readdir(backupDir), []);
  }
});

test('editor reads reject busy, offline, ambiguous editor, read-only, and mismatched heading states', async (t) => {
  for (const [change, expected] of [
    [{ busy: true }, /generating/], [{ offline: true }, /not be synced/],
    [{ editorCount: 2 }, /exactly one visible/], [{ readonly: true }, /read-only/],
    [{ editable: false }, /read-only/], [{ heading: 'Other.tsx' }, /heading/],
  ]) {
    const { client, state } = await setup(t, change);
    await assert.rejects(client.diagnostics('src/App.tsx'), expected);
    assert.equal(state.dispatches.length, 0);
  }
});

test('a change between the backup and the write is refused in the page without sending the write', async (t) => {
  for (const mutate of [
    (state) => { state.fs['src/App.tsx'] += '// collaborator edit'; },
    (state) => { state.key = 'OtherKey'; },
    (state) => { delete state.fs['src/App.tsx']; },
  ]) {
    const { client, state, backupDir } = await setup(t);
    let reads = 0;
    state.beforeFsRead = () => { if (++reads === 2) mutate(state); };
    let failure;
    await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir }), (error) => {
      failure = error;
      return error.outcome === 'refused' && /No write was sent/.test(error.message) && /Original backup/.test(error.message);
    });
    assert.deepEqual(state.fsWrites, []);
    assert.equal(readFileSync(failure.backupPath, 'utf8'), 'export const original = true;\n');
  }
});

test('backup failure prevents any write', async (t) => {
  const { client, state, backupDir } = await setup(t);
  await assert.rejects(client.replace('src/App.tsx', 'new', {
    expectedSha256: hash(state.content), backupDir: join(backupDir, '\0invalid'),
  }));
  assert.deepEqual(state.fsWrites, []);
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
    const { client, state } = await setup(t);
    state.beforeEvaluate = ({ expression }) => { if (expression.includes(')({"type":"read"')) mutate(state); };
    await assert.rejects(client.diagnostics('src/App.tsx'), /ancestor|ancestry/);
    assert.equal(state.dispatches.length, 0);
    assert.equal(state.rowName, 'App.tsx');
    assert.equal(state.top, 32);
  }
});

test('lost write response reports the original backup and never retries or rolls back', async (t) => {
  const { client, state, backupDir } = await setup(t, { writeMode: 'lost' }, 2000);
  let failure;
  await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir }), (error) => {
    failure = error;
    return error.outcome === 'uncertain' && /No retry or rollback/.test(error.message);
  });
  assert.equal(state.fs['src/App.tsx'], 'new');
  assert.deepEqual(state.fsWrites, ['src/App.tsx']);
  assert.equal(await readFile(failure.backupPath, 'utf8'), 'export const original = true;\n');
});

test('bounds the operation and rejects concurrent operations on the same editor', async (t) => {
  const { client, state } = await setup(t, { hang: true }, 30);
  const pending = assert.rejects(client.read('src/App.tsx'), /timed out/);
  await assert.rejects(client.files(), /already running/);
  await pending;
  assert.equal(state.dispatches.length, 0);
});

test('rejected writes and mismatched readback leave an uncertain outcome and backup, never success', async (t) => {
  for (const writeMode of ['rejected', 'corrupt']) {
    const { client, state, backupDir } = await setup(t, { writeMode });
    let failure;
    await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir }), (error) => {
      failure = error;
      return error.outcome === 'uncertain' && (writeMode === 'rejected' ? /rejected/ : /readback/).test(error.message);
    });
    assert.deepEqual(state.fsWrites, ['src/App.tsx']);
    assert.equal(await readFile(failure.backupPath, 'utf8'), 'export const original = true;\n');
  }
});

test('temporary focus emulation is restored after both successful and failed operations', async (t) => {
  for (const options of [{}, { busy: true }]) {
    const { client, state, backupDir } = await setup(t, options);
    const pending = client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir });
    if (options.busy) await assert.rejects(pending, /generating/);
    else await pending;
    assert.deepEqual(state.protocolCalls.filter(call => call.method.startsWith('Emulation.')), [
      { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } },
      { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } },
    ]);
    assert.equal(state.focusEnabled, false);
  }
});

test('failed focus enable skips editor operations and still attempts cleanup', async (t) => {
  const { client, state, backupDir } = await setup(t, { focusEnableError: true });
  await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir }), /focus enable reply lost/);
  // Only the passive capture was armed; no editor, tree or filesystem action ran.
  assert.equal(state.expressions.length, 1);
  assert.match(state.expressions[0], /figma-cli\.make\.filesystem/);
  assert.equal(state.dispatches.length, 0);
  assert.deepEqual(state.fsWrites, []);
  assert.equal(state.focusEnabled, false);
  assert.deepEqual(await readdir(backupDir), []);
  assert.deepEqual(state.protocolCalls.map((call) => call.params.enabled), [true, false]);
});

test('cleanup failure is reported without masking the original operation error', async (t) => {
  const { client, state, backupDir } = await setup(t, { busy: true, focusDisableError: true });
  await assert.rejects(client.replace('src/App.tsx', 'new', { expectedSha256: hash(state.content), backupDir }),
    /generating.*focus emulation could not be disabled/);
});

test('cleanup is bounded within the operation timeout even when the renderer does not reply', async (t) => {
  const { client } = await setup(t, { hangFocusDisable: true }, 100);
  const started = Date.now();
  await assert.rejects(client.inspect(), /focus emulation could not be disabled.*timed out/);
  assert.ok(Date.now() - started < 250, 'cleanup must not wait for the default multi-second CDP timeout');
});
