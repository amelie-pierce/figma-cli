import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MakeClient } from '../src/make-client.js';
import { makeDurablePageAction, requireExactPending, requireFirstVersionPending, requireGitMode } from '../src/make-durable.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const base = 'a'.repeat(40);
const next = 'b'.repeat(40);
const state = (paths = []) => ({ mode: 'git', hasBaseline: true, savedVersion: base,
  pendingCount: paths.length, pendingPaths: paths, isLoading: false, error: false });

function fakeClient({ original = null, paths = [], post = state(paths), version } = {}) {
  const calls = [];
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 5000 });
  client.fileKey = 'ScratchKey';
  client._operation = fn => fn(Date.now() + 5000);
  client._ensureCode = async () => ({ busy: false, offline: false, readOnly: false });
  client._driftState = async () => ({ state: post });
  client._sourceTree = async () => [{ kind: 'folder', path: 'src' }];
  client._durableAgreement = async (path, content) => calls.push(['agreement', path, content]);
  client._backup = async (path, content) => { calls.push(['backup', path, content]); return '/private/backup'; };
  let current = original;
  client._durable = async action => {
    calls.push([action.type, action.path || action.title]);
    if (action.type === 'read') return { exists: current !== null, content: current };
    if (action.type === 'write') { current = action.content; return { accepted: true }; }
    if (action.type === 'delete') { current = null; return { accepted: true }; }
    if (action.type === 'save') return version;
  };
  return { client, calls };
}

test('durable operations refuse snapshot mode and unknown baseline', () => {
  assert.throws(() => requireGitMode({ ...state(), mode: 'snapshot' }), /Snapshot-mode/);
  assert.throws(() => requireGitMode({ ...state(), hasBaseline: false }), /unverified/);
});

test('write checks SHA before backing up and writing', async () => {
  const { client, calls } = fakeClient({ original: 'old' });
  await assert.rejects(client.writeDurable('src/App.tsx', 'new', { expectedSha256: hash('other') }), /SHA-256/);
  assert.equal(calls.some(call => call[0] === 'backup' || call[0] === 'write'), false);
});

test('replacement backs up old bytes, invokes VFS and verifies agreement', async () => {
  const { client, calls } = fakeClient({ original: 'old' });
  const result = await client.writeDurable('src/App.tsx', 'new', { expectedSha256: hash('old') });
  assert.equal(result.backupPath, '/private/backup');
  assert.equal(result.sha256, hash('new'));
  assert.deepEqual(calls.filter(call => ['backup', 'write', 'agreement'].includes(call[0])), [
    ['agreement', 'src/App.tsx', 'old'], ['backup', 'src/App.tsx', 'old'],
    ['write', 'src/App.tsx'], ['agreement', 'src/App.tsx', 'new'],
  ]);
});

test('replacement reuses a validated editor selection and reselects if it moved', async () => {
  for (const moved of [false, true]) {
    const { client } = fakeClient({ original: 'old' });
    // Exercise the real agreement path instead of fakeClient's agreement stub.
    client._durableAgreement = MakeClient.prototype._durableAgreement;
    client._sourceTree = async (_deadline, _expectedChange, onSnapshot) => {
      const entries = [{ kind: 'file', path: 'src/App.tsx' }];
      const rows = [...entry.ancestors, { ...entry, selected: true }];
      onSnapshot?.({ entries, rows, renderedRows: rows });
      return entries;
    };
    client._fileBridge = async () => ({ dispose: async () => {} });
    let current = 'old';
    client._durable = async action => {
      if (action.type === 'read') return { exists: true, content: current };
      if (action.type === 'write') { current = action.content; return { accepted: true }; }
    };
    client._bridgeRead = async () => ({ content: current });
    let selections = 0;
    const entry = { path: 'src/App.tsx', name: 'App.tsx', kind: 'file', level: 2, top: 32,
      ancestors: [{ name: 'src', kind: 'folder', level: 1, top: 0, height: 32, expanded: true }] };
    client._read = async () => { selections++; return { content: current, entry }; };
    client._editor = async () => {
      if (moved) throw new Error('Make selected source file changed before the editor operation.');
      return { content: current };
    };
    const result = await client.writeDurable('src/App.tsx', 'new', { expectedSha256: hash('old') });
    assert.equal(result.verification, 'editor-tree-vfs-sandbox-matched');
    assert.equal(selections, moved ? 2 : 1);
  }
});

test('new file verifies absence and read-back; delete keeps backup', async () => {
  const added = fakeClient();
  const result = await added.client.writeDurable('src/new.ts', 'hello');
  assert.equal(result.backupPath, null);
  assert.deepEqual(added.calls.filter(call => call[0] === 'agreement'), [
    ['agreement', 'src/new.ts', null], ['agreement', 'src/new.ts', 'hello'],
  ]);
  const removed = fakeClient({ original: 'old' });
  const deletion = await removed.client.deleteDurable('src/old.ts', { expectedSha256: hash('old') });
  assert.equal(deletion.backupPath, '/private/backup');
  assert.ok(removed.calls.some(call => call[0] === 'agreement' && call[2] === null));
});

test('a new durable write authorizes only its own tree insertion after the VFS write', async () => {
  const { client } = fakeClient();
  const beforeEntries = [{ path: 'src', kind: 'folder', level: 1, top: 0 }];
  const beforeRows = [{ name: 'src', kind: 'folder', level: 1, top: 0, height: 32 }];
  let authorization;
  client._durableAgreement = async (_path, content, _deadline, options) => {
    if (content === null) {
      options.treeState.entries = beforeEntries;
      options.treeState.rows = beforeRows;
    } else authorization = options.expectedChange;
    return 'matched';
  };
  await client.writeDurable('src/new.ts', 'hello');
  assert.deepEqual(authorization, { beforeEntries, beforeRows, writtenPath: 'src/new.ts' });
});

test('a durable delete authorizes only its own tree removal after the VFS delete', async () => {
  const { client } = fakeClient({ original: 'old' });
  const beforeEntries = [{ path: 'src', kind: 'folder', level: 1, top: 0 }, { path: 'src/old.ts', kind: 'file', level: 2, top: 32 }];
  const beforeRows = [{ name: 'src', kind: 'folder', level: 1, top: 0, height: 32 },
    { name: 'old.ts', kind: 'file', level: 2, top: 32, height: 32 }];
  let authorization;
  client._durableAgreement = async (_path, content, _deadline, options) => {
    if (content === 'old') {
      options.treeState.entries = beforeEntries;
      options.treeState.rows = beforeRows;
    } else authorization = options.expectedChange;
    return 'matched';
  };
  await client.deleteDurable('src/old.ts', { expectedSha256: hash('old') });
  assert.deepEqual(authorization, { beforeEntries, beforeRows, removedPath: 'src/old.ts' });
});

test('save refuses unrelated pending changes before calling createVersion', async () => {
  const { client, calls } = fakeClient({ paths: ['src/ours.ts', 'src/other.ts'] });
  await assert.rejects(client.saveVersion('Save', ['src/ours.ts']), /unrelated/);
  assert.equal(calls.some(call => call[0] === 'save'), false);
  assert.throws(() => requireExactPending(state(['src/ours.ts']), ['src/ours.ts', 'src/ours.ts']), /unrelated/);
});

test('save records Make version ID, git SHA and expected changed files', async () => {
  const { client, calls } = fakeClient({ paths: ['src/ours.ts'],
    version: { id: 'version-id', versionNumber: 2, gitSha: next } });
  let reads = 0;
  client._driftState = async () => ({ state: reads++ < 1 ? state(['src/ours.ts']) :
    { ...state(), savedVersion: next } });
  const result = await client.saveVersion('Saved', ['src/ours.ts']);
  assert.deepEqual({ id: result.versionId, gitSha: result.gitSha, files: result.changedFiles },
    { id: 'version-id', gitSha: next, files: ['src/ours.ts'] });
  assert.deepEqual(calls.filter(call => call[0] === 'save'), [['save', 'Saved']]);
});

test('save refuses an empty expected set before connecting to Make', () => {
  const { client, calls } = fakeClient();
  assert.throws(() => client.saveVersion('Empty', []), /exact expected changed-file set/);
  assert.equal(calls.length, 0);
});

test('save reports the created version when the clean baseline is not observed', async () => {
  const { client } = fakeClient({ paths: ['src/ours.ts'],
    version: { id: 'version-id', versionNumber: 4, gitSha: next } });
  client._operation = fn => fn(Date.now() + 300);
  const error = await client.saveVersion('Saved', ['src/ours.ts']).catch(cause => cause);
  assert.match(error.message, new RegExp(`version 4 \\(${next}\\) was created`));
  assert.deepEqual({ id: error.version.versionId, gitSha: error.version.gitSha, previous: error.version.previousGitSha },
    { id: 'version-id', gitSha: next, previous: base });
});

test('save keeps polling through transient post-save states', async () => {
  const { client } = fakeClient({ paths: ['src/ours.ts'],
    version: { id: 'version-id', versionNumber: 3, gitSha: next } });
  const states = [state(['src/ours.ts']), { ...state(['src/ours.ts']), isLoading: true }, null,
    { ...state(), savedVersion: null }, { ...state(), savedVersion: next }];
  client._driftState = async () => ({ state: states.length > 1 ? states.shift() : states[0] });
  const result = await client.saveVersion('Saved', ['src/ours.ts']);
  assert.equal(result.verification, 'saved-version-clean-pending');
  assert.equal(result.gitSha, next);
});

test('page action never invokes a save for a VFS read', async () => {
  const prior = globalThis.document;
  let saved = 0;
  const vfs = { writeFile() {}, deleteFile() {}, getFileEntryByPath: () => ({ asyncContents: Promise.resolve('hello') }) };
  const root = { memoizedProps: { vfs, state: { sandbox: { createVersion: () => { saved++; } } },
    chatController: { chatSdkState: { threadId: 'thread' } } }, child: null, sibling: null };
  globalThis.document = { querySelectorAll: () => [{ '__reactFiber$test': root }] };
  try {
    assert.deepEqual(await makeDurablePageAction({ type: 'read', path: 'src/a.ts' }), { exists: true, content: 'hello' });
    assert.equal(saved, 0);
  } finally { globalThis.document = prior; }
});

test('page-side VFS recheck refuses a concurrent change before mutation', async () => {
  const prior = globalThis.document;
  let writes = 0;
  const vfs = { writeFile: async () => { writes++; }, deleteFile: async () => {},
    getFileEntryByPath: () => ({ asyncContents: Promise.resolve('intervening edit') }) };
  const root = { memoizedProps: { vfs }, child: null, sibling: null };
  globalThis.document = { querySelectorAll: () => [{ '__reactFiber$test': root }] };
  try {
    const result = await makeDurablePageAction({ type: 'write', path: 'src/a.ts',
      expectedContent: 'old', content: 'new' });
    assert.match(result.refused, /changed/);
    assert.equal(writes, 0);
  } finally { globalThis.document = prior; }
});

test('read-back waits until VFS, sandbox, tree and editor agree', async () => {
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 2000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: true, content: 'new' });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async () => ({ content: 'new' });
  client._sourceTree = async () => [{ kind: 'file', path: 'src/a.ts' }];
  let editorReads = 0;
  client._read = async () => ({ content: ++editorReads === 1 ? 'old' : 'new' });
  await client._durableAgreement('src/a.ts', 'new', Date.now() + 1000);
  assert.equal(editorReads, 2);
});

test('hidden-file read-back uses VFS and sandbox when Make omits dotfiles from its tree', async () => {
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 2000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: true, content: 'sentinel' });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async () => ({ content: 'sentinel' });
  client._sourceTree = async () => [];
  client._read = async () => { throw new Error('Hidden file has no editor'); };
  await client._durableAgreement('src/vendor/atomic-aui/tokens/generated/.generated', 'sentinel', Date.now() + 1000);
});

test('a root lockfile, which Make leaves out of its tree, reads back through VFS and sandbox', async () => {
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 2000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: true, content: 'lock' });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async () => ({ content: 'lock' });
  client._sourceTree = async () => [];
  client._read = async () => { throw new Error('No editor for a file outside the tree'); };
  assert.equal(await client._durableAgreement('pnpm-lock.yaml', 'lock', Date.now() + 1000), 'vfs-sandbox-matched');
  await assert.rejects(client._durableAgreement('src/pnpm-lock.yaml', 'lock', Date.now() + 300), /tree absent/);
});

test('delete read-back requires a successful sandbox directory listing', async () => {
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 2000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: false, content: null });
  client._fileBridge = async () => ({ dispose: async () => {}, invoke: async () => ({
    success: true, data: { path: 'code/src', files: [] },
  }) });
  client._sourceTree = async () => [];
  await client._durableAgreement('src/a.ts', null, Date.now() + 1000);
});

test('page-side save refuses unrelated pending paths before createVersion', async () => {
  const prior = globalThis.document;
  let saved = 0;
  const props = {
    codeFileChanges: { isGitSourceOfTruth: true, hasBaseline: true,
      baselineMakeVersionGitSha: base, changedFiles: [{ path: 'src/ours.ts' }, { path: 'src/other.ts' }],
      isLoading: false, error: null },
    state: { sandbox: { createVersion: async () => { saved++; return { id: 'v', versionNumber: 2, gitSha: next }; } } },
    chatController: { chatSdkState: { threadId: 'thread' } },
  };
  globalThis.document = { querySelectorAll: () => [{ '__reactFiber$test': { memoizedProps: props } }] };
  try {
    const result = await makeDurablePageAction({ type: 'save', title: 'Saved',
      expectedPaths: ['src/ours.ts'], expectedGitSha: base });
    assert.match(result.refused, /pending file set/);
    assert.equal(saved, 0);
    const accepted = await makeDurablePageAction({ type: 'save', title: 'Saved',
      expectedPaths: ['src/ours.ts', 'src/other.ts'], expectedGitSha: base });
    assert.deepEqual(accepted, { id: 'v', versionNumber: 2, gitSha: next });
    assert.equal(saved, 1);
  } finally { globalThis.document = prior; }
});

test('absence read-back lists the nearest existing ancestor of a new directory', async () => {
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 2000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: false, content: null });
  const listed = [];
  client._fileBridge = async () => ({ dispose: async () => {}, invoke: async (_fn, [, data]) => {
    listed.push(data.path);
    // Live Make never answers fs/dir/list for a missing path; the bridge request times out.
    if (data.path !== 'code/src') throw new Error('Make filesystem request timed out; outcome is unknown.');
    return { success: true, data: { path: 'code/src', files: [{ name: 'App.tsx' }] } };
  } });
  client._sourceTree = async () => [];
  await client._durableAgreement('src/components/new/Foo.tsx', null, Date.now() + 1000);
  assert.deepEqual(listed, ['code/src/components/new', 'code/src/components', 'code/src']);
});

test('a missing-folder listing that Make never answers costs at most 5 s per level, not the whole budget', async () => {
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 120000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: false, content: null });
  const requestTimeouts = [];
  client._fileBridge = async (deadline, { requestTimeoutMs = deadline - Date.now() - 1000 } = {}) => {
    requestTimeouts.push(requestTimeoutMs);
    return { dispose: async () => {}, invoke: async (_fn, [, data]) => {
      if (data.path === 'code/src') return { success: true, data: { path: 'code/src', files: [{ name: 'App.tsx' }] } };
      // Make never answers; the in-page timer rejects after requestTimeoutMs (scaled 1:1000 here).
      await new Promise(resolve => setTimeout(resolve, requestTimeoutMs / 1000));
      throw new Error('Make filesystem request timed out; outcome is unknown.');
    } };
  };
  client._sourceTree = async () => [];
  assert.equal(await client._durableAgreement('src/features/new/Panel.tsx', null, Date.now() + 120000),
    'tree-vfs-sandbox-delete-matched');
  assert.equal(requestTimeouts.length, 1);
  assert.ok(requestTimeouts[0] <= 5000, `absence probe request timeout ${requestTimeouts[0]} must stay short`);
});

test('absence read-back keeps waiting when an existing ancestor cannot be listed deeper', async () => {
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 2000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: false, content: null });
  client._fileBridge = async () => ({ dispose: async () => {}, invoke: async (_fn, [, data]) => (data.path === 'code'
    ? { success: true, data: { path: 'code', files: [{ name: 'src' }] } } : { success: false }) });
  client._sourceTree = async () => [];
  await assert.rejects(client._durableAgreement('src/a.ts', null, Date.now() + 300), /timed out/);
});

test('save-version CLI requires an expected path before connecting', () => {
  const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--port', '1', 'make', 'save-version', '--file', 'ExactKey', '--title', 'Empty'],
    { env: { ...process.env, FIGMA_CLI_NO_UPDATE_CHECK: '1' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--expected-path/);
  assert.doesNotMatch(result.stderr, /CDP|port/i);
});

test('a created version survives a focus-emulation cleanup failure', async () => {
  const sent = [];
  const client = new MakeClient({ timeoutMs: 5000, transport: { close() {}, evaluate: async () => true,
    send: async (method, params) => {
      sent.push(params.enabled);
      if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === false) throw new Error('renderer gone');
      return {};
    } } });
  client.fileKey = 'ScratchKey';
  const saved = { fileKey: 'ScratchKey', versionId: 'version-id', versionNumber: 5, gitSha: next };
  const error = await client._operation(async () => saved).catch(cause => cause);
  assert.match(error.message, /focus emulation could not be disabled.*version 5/);
  assert.equal(error.version, saved);
});

test('page-side save sees a provider that wraps codeFileChanges in value', async () => {
  const prior = globalThis.document;
  let saved = 0;
  const props = {
    value: { codeFileChanges: { isGitSourceOfTruth: true, hasBaseline: true,
      baselineMakeVersionGitSha: base, changedFiles: [{ path: 'src/ours.ts' }], isLoading: false, error: null } },
    state: { sandbox: { createVersion: async () => { saved++; return { id: 'v', versionNumber: 2, gitSha: next }; } } },
    chatController: { chatSdkState: { threadId: 'thread' } },
  };
  globalThis.document = { querySelectorAll: () => [{ '__reactFiber$test': { memoizedProps: props } }] };
  try {
    const result = await makeDurablePageAction({ type: 'save', title: 'Saved', expectedPaths: ['src/ours.ts'], expectedGitSha: base });
    assert.deepEqual(result, { id: 'v', versionNumber: 2, gitSha: next });
    assert.equal(saved, 1);
  } finally { globalThis.document = prior; }
});

test('Markdown read-back accepts VFS, sandbox and tree when Make shows no editor', async () => {
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 5000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: true, content: '# Workbench\n' });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async () => ({ content: '# Workbench\n' });
  client._sourceTree = async () => [{ kind: 'file', path: 'guidelines/workbench.md' }];
  // Make renders Markdown as a preview: the selected file never gets an editor.
  client._select = async () => ({ name: 'workbench.md' });
  let inspections = 0;
  client._editor = async action => { inspections++; assert.equal(action.type, 'inspect'); return { editorCount: 0 }; };
  const started = Date.now();
  const verification = await client._durableAgreement('guidelines/workbench.md', '# Workbench\n', Date.now() + 5000);
  assert.equal(verification, 'tree-vfs-sandbox-matched');
  assert.ok(inspections > 1);
  assert.ok(Date.now() - started < 4500, 'the editor wait is bounded well inside the operation deadline');
});

test('a file with an editor is still compared through that editor', async () => {
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 2000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: true, content: 'new' });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async () => ({ content: 'new' });
  client._sourceTree = async () => [{ kind: 'file', path: 'src/a.ts' }];
  client._read = async (_path, _deadline, options) => {
    assert.equal(typeof options.editorWaitMs, 'number');
    return { content: 'new' };
  };
  assert.equal(await client._durableAgreement('src/a.ts', 'new', Date.now() + 1000), 'editor-tree-vfs-sandbox-matched');
});

test('an unopened source file accepts matching VFS, sandbox and tree after a bounded editor wait', async () => {
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 5000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: true, content: 'export default 1;\n' });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async () => ({ content: 'export default 1;\n' });
  client._sourceTree = async () => [{ kind: 'file', path: 'src/App.tsx' }];
  client._select = async () => ({ name: 'App.tsx' });
  // The editor has not mounted after the Markdown preview window.
  client._editor = async action => { assert.equal(action.type, 'inspect'); return { editorCount: 0 }; };
  const started = Date.now();
  assert.equal(await client._durableAgreement('src/App.tsx', 'export default 1;\n', Date.now() + 5000),
    'tree-vfs-sandbox-matched');
  assert.ok(Date.now() - started < 4500, 'an unopened source file must not consume the operation deadline');
});

test('a mounted editor that disagrees refuses the three-view fallback', async () => {
  const path = 'src/vendor/atomic-aui/lib/datepicker/use-recipe.ts';
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 2000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: true, content: 'expected' });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async () => ({ content: 'expected' });
  client._sourceTree = async () => [{ kind: 'file', path }];
  client._read = async () => ({ content: 'different' });
  const error = await client._durableAgreement(path, 'expected', Date.now() + 300).catch(cause => cause);
  assert.match(error.message, /editor different/);
});

test('a sandbox or tree mismatch refuses the missing-editor fallback', async () => {
  const path = 'src/vendor/atomic-aui/lib/datepicker/use-recipe.ts';
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 2000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: true, content: 'expected' });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async () => ({ content: 'different' });
  client._sourceTree = async () => [{ kind: 'file', path }];
  client._read = async () => { throw new Error('editor must not be read while a layer differs'); };
  await assert.rejects(client._durableAgreement(path, 'expected', Date.now() + 300), /sandbox different/);
  client._bridgeRead = async () => ({ content: 'expected' });
  client._sourceTree = async () => [];
  await assert.rejects(client._durableAgreement(path, 'expected', Date.now() + 300), /tree absent/);
});

test('an editor that disagreed earlier refuses the deep viewport fallback', async () => {
  const path = 'src/vendor/atomic-aui/lib/datepicker/use-recipe.ts';
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 2000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: true, content: 'expected' });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async () => ({ content: 'expected' });
  client._sourceTree = async () => [{ kind: 'file', path }];
  client._editor = async () => ({ editorCount: 1, editorPath: 'src/App.tsx' });
  let reads = 0;
  client._read = async () => {
    if (reads++ === 0) return { content: 'different' };
    throw Object.assign(new Error('viewport refused'), { code: 'MAKE_TREE_VIEWPORT' });
  };
  await assert.rejects(client._durableAgreement(path, 'expected', Date.now() + 300), /editor different/);
});

test('verified vendor write uses three live views only when deep ancestry cannot fit the tree viewport', async () => {
  const path = 'src/vendor/atomic-aui/lib/drawer/use-recipe.ts';
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 2000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: true, content: 'vendor bytes' });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async () => ({ content: 'vendor bytes' });
  client._sourceTree = async () => [{ kind: 'file', path }];
  client._read = async () => { throw Object.assign(new Error('Make source ancestry cannot fit in the file-tree viewport; selection was refused.'),
    { code: 'MAKE_TREE_VIEWPORT' }); };
  client._editor = async () => ({ editorCount: 1, editorPath: null });
  assert.equal(await client._durableAgreement(path, 'vendor bytes', Date.now() + 1000,
    { vendorTreeFallback: true }), 'tree-vfs-sandbox-vendor-matched');
  await assert.rejects(client._durableAgreement(path, 'vendor bytes', Date.now() + 300), /editor unavailable/);
  client._editor = async () => ({ editorCount: 1, editorPath: path });
  await assert.rejects(client._durableAgreement(path, 'vendor bytes', Date.now() + 300,
    { vendorTreeFallback: true }), /editor unavailable/);
  client._editor = async () => ({ editorCount: 1, editorPath: null });
  await assert.rejects(client._durableAgreement('src/App.tsx', 'vendor bytes', Date.now() + 1000,
    { vendorTreeFallback: true }), /limited to src\/vendor\/atomic-aui/);
  assert.throws(() => client.writeDurable('src/App.tsx', 'vendor bytes', { vendorTreeFallback: true }),
    /limited to src\/vendor\/atomic-aui/);
  client._bridgeRead = async () => ({ content: 'different bytes' });
  const error = await client._durableAgreement(path, 'vendor bytes', Date.now() + 300,
    { vendorTreeFallback: true }).catch(cause => cause);
  assert.match(error.message, /sandbox different/);
});

test('vendor tree fallback does not accept a missing editor for another reason', async () => {
  const path = 'src/vendor/atomic-aui/lib/drawer/use-recipe.ts';
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 2000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: true, content: 'vendor bytes' });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async () => ({ content: 'vendor bytes' });
  client._sourceTree = async () => [{ kind: 'file', path }];
  client._read = async () => { throw new Error('Make editor is temporarily unavailable.'); };
  const error = await client._durableAgreement(path, 'vendor bytes', Date.now() + 300,
    { vendorTreeFallback: true }).catch(cause => cause);
  assert.match(error.message, /editor unavailable/);
});

test('immutable release assets use VFS, sandbox and tree without mounting an editor', async () => {
  const path = 'public/atomicaui/7.0.0/files/lib/field/index.ts';
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 2000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: true, content: 'release' });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async () => ({ content: 'release' });
  client._sourceTree = async () => [{ kind: 'file', path }];
  client._read = async () => { throw new Error('release asset must not open an editor'); };
  assert.equal(await client._durableAgreement(path, 'release', Date.now() + 1000, { releaseAsset: true }),
    'tree-vfs-sandbox-release-matched');
  await assert.rejects(client._durableAgreement('src/App.tsx', 'release', Date.now() + 1000,
    { releaseAsset: true }), /limited to public/);
  assert.throws(() => client.writeDurable('src/App.tsx', 'release', { releaseAsset: true }), /limited to public/);
});

test('read-back mismatch fails at the deadline and names each view', async () => {
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 2000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: true, content: 'new' });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async () => ({ content: 'stale' });
  client._sourceTree = async () => [{ kind: 'file', path: 'AGENTS.md' }];
  client._read = async () => { throw new Error('must not read an editor before VFS and sandbox agree'); };
  const started = Date.now();
  const error = await client._durableAgreement('AGENTS.md', 'new', Date.now() + 300).catch(cause => cause);
  assert.match(error.message, /AGENTS\.md timed out before every view agreed \(vfs matched, sandbox different, tree present\)/);
  assert.ok(Date.now() - started < 1500);
});

test('new file directly under the project root is refused before any write', async () => {
  const { client, calls } = fakeClient();
  await assert.rejects(client.writeDurable('NOTES.md', 'hello'), /cannot prove NOTES\.md absent/);
  await assert.rejects(client.writeDurable('docs/probe.md', 'hello'), /cannot prove docs\/probe\.md absent/);
  assert.equal(calls.some(call => ['backup', 'write', 'agreement'].includes(call[0])), false);
});

test('exact pending allows only allowlisted unlisted root files to be absent', () => {
  assert.deepEqual(requireExactPending(state(['src/probe.md']), ['src/probe.md', 'AGENTS.md']),
    { listed: ['src/probe.md'], unlisted: ['AGENTS.md'] });
  assert.deepEqual(requireExactPending(state([]), ['CLAUDE.md']), { listed: [], unlisted: ['CLAUDE.md'] });
  // Listed when Make does list it.
  assert.deepEqual(requireExactPending(state(['AGENTS.md']), ['AGENTS.md']), { listed: ['AGENTS.md'], unlisted: [] });
  // Unexpected extras and missing ordinary paths are still refused.
  assert.throws(() => requireExactPending(state(['src/probe.md', 'src/other.ts']), ['src/probe.md', 'AGENTS.md']), /unrelated/);
  assert.throws(() => requireExactPending(state(['AGENTS.md']), ['src/probe.md']), /unrelated/);
  assert.throws(() => requireExactPending(state([]), ['README.md']), /unrelated/);
  assert.throws(() => requireExactPending(state([]), ['docs/AGENTS.md']), /unrelated/);
});

function unlistedClient({ after = 'agents v2' } = {}) {
  const fake = fakeClient({ original: 'agents v2', paths: ['src/probe.md'],
    version: { id: 'version-id', versionNumber: 15, gitSha: next } });
  let reads = 0;
  fake.client._driftState = async () => ({ state: reads++ < 1 ? state(['src/probe.md']) : { ...state(), savedVersion: next } });
  let saved = false;
  const durable = fake.client._durable;
  fake.client._durable = async action => {
    if (action.type === 'save') { saved = true; assert.deepEqual(action.expectedPaths, ['src/probe.md']); }
    if (action.type === 'read' && saved) return { exists: true, content: after };
    return durable(action);
  };
  fake.client._fileBridge = async () => ({ dispose: async () => {} });
  fake.client._bridgeRead = async () => ({ content: saved ? after : 'agents v2' });
  return fake;
}

test('save-version saves an unlisted root file and verifies it by a post-save read', async () => {
  const { client } = unlistedClient();
  const result = await client.saveVersion('Saved', ['src/probe.md', 'AGENTS.md']);
  assert.deepEqual(result.changedFiles, ['src/probe.md']);
  assert.deepEqual(result.unlistedFiles, [{ path: 'AGENTS.md', sha256: hash('agents v2') }]);
  assert.equal(result.verification, 'saved-version-clean-pending; unlisted-post-save-read-matched');
});

test('save-version reports the version when an unlisted file differs after the save', async () => {
  const { client } = unlistedClient({ after: 'changed' });
  const error = await client.saveVersion('Saved', ['src/probe.md', 'AGENTS.md']).catch(cause => cause);
  assert.match(error.message, /version 15 .* was created .* unlisted files changed across the save: AGENTS\.md\. Do not retry/);
  assert.equal(error.version.versionId, 'version-id');
});

// --first-version: a git-mode file that Make has never saved.
const head = 'c'.repeat(40);
const blank = () => ({ mode: 'git', hasBaseline: false, savedVersion: null,
  pendingCount: 0, pendingPaths: [], isLoading: false, error: false });
const flat = entries => new Map(Object.entries(entries).map(([path, blob]) => [path, { mode: '100644', blob }]));
const since = 'f'.repeat(40);
const sinceFlat = flat({ 'src/App.tsx': '1'.repeat(40), 'package.json': '2'.repeat(40) });

test('first-version gate accepts only a clean no-baseline git file', () => {
  assert.equal(requireGitMode(blank(), { firstVersion: true }).hasBaseline, false);
  assert.throws(() => requireGitMode(state(), { firstVersion: true }), /already has a saved version; --first-version refused/);
  assert.throws(() => requireGitMode({ ...state(), hasBaseline: false }, { firstVersion: true }), /already has a saved version/);
  assert.throws(() => requireGitMode({ ...blank(), isLoading: true }, { firstVersion: true }), /no-baseline state is unverified/);
  assert.throws(() => requireGitMode({ ...blank(), pendingPaths: ['src/a.ts'] }, { firstVersion: true }), /no-baseline state is unverified/);
  assert.throws(() => requireGitMode({ ...blank(), mode: 'snapshot' }, { firstVersion: true }), /Snapshot-mode/);
  assert.throws(() => requireGitMode(blank()), /no saved version; pass --first-version/);
});

test('override gate accepts only the pinned saved pointer in git mode', () => {
  const pin = { savedVersion: base, head };
  const broken = { ...state(), hasBaseline: false, error: true };
  assert.equal(requireGitMode(broken, { overrideMake: pin }), broken);
  assert.equal(requireGitMode(state(['src/edit.ts']), { overrideMake: pin }).savedVersion, base);
  for (const bad of [{ ...broken, savedVersion: next }, { ...broken, isLoading: true },
    { ...broken, pendingPaths: null }, { ...broken, mode: 'snapshot' },
    { ...broken, error: false }, { ...state(), error: true }]) {
    assert.throws(() => requireGitMode(bad, { overrideMake: pin }));
  }
  assert.throws(() => requireGitMode(broken), /unverified/);
});

test('override write checks the sandbox head before the VFS mutation', async () => {
  const broken = { ...state(), hasBaseline: false, error: true };
  const { client, calls } = fakeClient({ original: 'old', post: broken });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._sandboxGit = () => ({ head: async () => next, reaches: async () => false });
  await assert.rejects(client.writeDurable('src/App.tsx', 'new', {
    expectedSha256: hash('old'), overrideMake: { savedVersion: base, head },
  }), /sandbox head is not an ancestor/);
  assert.equal(calls.some(call => call[0] === 'write'), false);
});

test('page-side override save requires the pinned pointer and unchanged pending set', async () => {
  const prior = globalThis.document;
  let calls = 0;
  const changes = { isGitSourceOfTruth: true, hasBaseline: false,
    baselineMakeVersionGitSha: base, changedFiles: [], isLoading: false, error: new Error('stale') };
  const props = { codeFileChanges: changes,
    state: { sandbox: { createVersion: async () => { calls++; return { id: 'v', versionNumber: 2, gitSha: next }; } } },
    chatController: { chatSdkState: { threadId: 'thread' } } };
  globalThis.document = { querySelectorAll: () => [{ '__reactFiber$test': { memoizedProps: props } }] };
  const action = { type: 'save', title: 'Override', expectedPaths: [], expectedGitSha: base,
    overrideMake: { savedVersion: base, head } };
  try {
    assert.deepEqual(await makeDurablePageAction(action), { id: 'v', versionNumber: 2, gitSha: next });
    changes.changedFiles = [{ path: 'src/other.ts' }];
    assert.match((await makeDurablePageAction(action)).refused, /pending file set/);
    changes.changedFiles = [];
    changes.baselineMakeVersionGitSha = next;
    assert.match((await makeDurablePageAction(action)).refused, /pending file set/);
    changes.baselineMakeVersionGitSha = base;
    changes.isLoading = true;
    assert.match((await makeDurablePageAction(action)).refused, /pending file set/);
    assert.equal(calls, 1);
  } finally { globalThis.document = prior; }
});

test('first-version pending set is the exact working-copy difference from the --since commit', () => {
  const working = flat({ 'src/App.tsx': '1'.repeat(40), 'package.json': '2'.repeat(40), 'src/probe.ts': '3'.repeat(40) });
  assert.deepEqual(requireFirstVersionPending(sinceFlat, working, ['src/probe.ts']), ['src/probe.ts']);
  assert.throws(() => requireFirstVersionPending(sinceFlat, working, ['src/other.ts']), /unrelated or missing/);
  assert.throws(() => requireFirstVersionPending(sinceFlat, working, ['src/probe.ts', 'src/probe.ts']), /unrelated or missing/);
  const edited = flat({ 'src/App.tsx': '4'.repeat(40), 'src/probe.ts': '3'.repeat(40) });
  assert.throws(() => requireFirstVersionPending(sinceFlat, edited, ['src/probe.ts']),
    /found \["package.json","src\/App.tsx","src\/probe.ts"\]/);
  assert.throws(() => requireFirstVersionPending(sinceFlat, sinceFlat, ['src/probe.ts']), /found \[\]/);
});

function firstVersionClient({ statuses, version = { id: 'version-id', versionNumber: 1, gitSha: next }, drift } = {}) {
  const { client, calls } = fakeClient({ post: blank(), version });
  const queue = [...statuses];
  client.projectStatus = async () => { calls.push(['status']); return queue.length > 1 ? queue.shift() : queue[0]; };
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._sandboxGit = () => ({ head: async () => head, reaches: async (from, to) => from === head && [since, head].includes(to),
    commitTree: async sha => { assert.ok([since, head].includes(sha)); return 'tree'; }, flatten: async () => sinceFlat });
  const durable = client._durable;
  client._durable = async action => { if (action.type === 'save') calls.push(['first', action.firstVersion, action.expectedPaths]); return durable(action); };
  const states = drift ?? [blank(), { ...state(), savedVersion: next }];
  client._driftState = async () => ({ state: states.length > 1 ? states.shift() : states[0] });
  return { client, calls };
}
const working = flat({ 'src/App.tsx': '1'.repeat(40), 'package.json': '2'.repeat(40), 'src/probe.ts': '3'.repeat(40) });
const beforeStatus = (overrides = {}) => ({ persistence: blank(), head, treeSource: 'sandbox-head', makeFlat: working,
  workingFlat: working, workingTree: 'd'.repeat(40), makeTree: 'e'.repeat(40), ...overrides });
const afterStatus = (tree = 'd'.repeat(40)) => ({ persistence: { ...state(), savedVersion: next }, head: next,
  treeSource: 'saved-version', makeFlat: working, workingFlat: working, makeTree: tree, workingTree: tree });

test('first version saves the checked working tree and verifies the new baseline and tree', async () => {
  const { client, calls } = firstVersionClient({ statuses: [beforeStatus(), afterStatus()] });
  const result = await client.saveFirstVersion('First', ['src/probe.ts'], { since });
  assert.deepEqual(calls.filter(call => call[0] === 'first'), [['first', true, []]]);
  assert.deepEqual({ first: result.firstVersion, sha: result.gitSha, previous: result.previousGitSha, since: result.since,
    head: result.sandboxHead, files: result.changedFiles, tree: result.tree, verification: result.verification },
  { first: true, sha: next, previous: null, since, head, files: ['src/probe.ts'], tree: 'd'.repeat(40),
    verification: 'first-version-clean-baseline; saved-tree-matched' });
});

test('first version refuses a file that already has a baseline before createVersion', async () => {
  const { client, calls } = firstVersionClient({ statuses: [beforeStatus({ persistence: state(), treeSource: 'saved-version' })] });
  await assert.rejects(client.saveFirstVersion('First', ['src/probe.ts'], { since }), /already has a saved version; --first-version refused/);
  assert.equal(calls.some(call => call[0] === 'first'), false);
});

test('first version refuses a bad --since, an unexpected pending set or a moved HEAD before createVersion', async () => {
  const unrelated = firstVersionClient({ statuses: [beforeStatus()] });
  await assert.rejects(unrelated.client.saveFirstVersion('First', ['src/App.tsx'], { since }), /unrelated or missing/);
  await assert.rejects(unrelated.client.saveFirstVersion('First', ['src/probe.ts']), /requires --since/);
  await assert.rejects(unrelated.client.saveFirstVersion('First', ['src/probe.ts'], { since: base }), /not in the sandbox history/);
  await assert.rejects(unrelated.client.saveFirstVersion('First', [], { since }), /exact expected changed-file set/);
  assert.equal(unrelated.calls.some(call => call[0] === 'first'), false);
  const moved = firstVersionClient({ statuses: [beforeStatus()] });
  const reader = moved.client._sandboxGit();
  moved.client._sandboxGit = () => ({ ...reader, head: async () => base });
  await assert.rejects(moved.client.saveFirstVersion('First', ['src/probe.ts'], { since }), /HEAD changed/);
  assert.equal(moved.calls.some(call => call[0] === 'first'), false);
});

test('first version reports the created version when the saved tree differs', async () => {
  const { client } = firstVersionClient({ statuses: [beforeStatus(), afterStatus('f'.repeat(40))] });
  const error = await client.saveFirstVersion('First', ['src/probe.ts'], { since }).catch(cause => cause);
  assert.match(error.message, /version 1 .* was created .* saved tree f{40} differs .*Do not retry/);
  assert.equal(error.version.versionId, 'version-id');
  assert.equal(error.version.firstVersion, true);
});

test('durable write honours --first-version in both directions', async () => {
  const blankFile = fakeClient({ post: blank() });
  await assert.rejects(blankFile.client.writeDurable('src/new.ts', 'hello'), /--first-version/);
  const written = await blankFile.client.writeDurable('src/new.ts', 'hello', { firstVersion: true });
  assert.equal(written.persistence, 'pending-version');
  const saved = fakeClient();
  await assert.rejects(saved.client.writeDurable('src/new.ts', 'hello', { firstVersion: true }), /already has a saved version/);
  await assert.rejects(saved.client.deleteDurable('src/old.ts', { expectedSha256: hash('old'), firstVersion: true }), /already has a saved version/);
  assert.equal(saved.calls.some(call => call[0] === 'write' || call[0] === 'delete'), false);
});

test('page-side first-version save requires Make to report no baseline', async () => {
  const prior = globalThis.document;
  let saved = 0;
  const changes = { isGitSourceOfTruth: true, hasBaseline: false, changedFiles: [], isLoading: false, error: null };
  const props = { codeFileChanges: changes,
    state: { sandbox: { createVersion: async () => { saved++; return { id: 'v', versionNumber: 1, gitSha: next }; } } },
    chatController: { chatSdkState: { threadId: 'thread' } } };
  globalThis.document = { querySelectorAll: () => [{ '__reactFiber$test': { memoizedProps: props } }] };
  const action = { type: 'save', firstVersion: true, title: 'First', expectedPaths: [], expectedGitSha: null };
  try {
    assert.deepEqual(await makeDurablePageAction(action), { id: 'v', versionNumber: 1, gitSha: next });
    Object.assign(changes, { hasBaseline: true, baselineMakeVersionGitSha: next });
    assert.match((await makeDurablePageAction(action)).refused, /pending file set/);
    assert.match((await makeDurablePageAction({ ...action, firstVersion: false })).refused, /pending file set/);
    assert.equal(saved, 1);
  } finally { globalThis.document = prior; }
});

// A checked version with a baseline: Make lists nothing under a dot folder such
// as .figma-cli/, so the working copy's difference from the saved tree is the check.
function checkedClient({ before, drift = [state(), { ...state(), savedVersion: next }] } = {}) {
  const { client, calls } = firstVersionClient({ statuses: [before, { ...afterStatus(), persistence: { ...state(), savedVersion: next } }],
    version: { id: 'version-id', versionNumber: 9, gitSha: next }, drift });
  const durable = client._durable;
  client._durable = async action => { if (action.type === 'save') calls.push(['action', action]); return durable(action); };
  return { client, calls };
}
const markerWorking = new Map([...sinceFlat, ['.figma-cli/project.json', { mode: '100644', blob: '3'.repeat(40) }]]);
const savedStatus = (overrides = {}) => ({ persistence: state(), head, treeSource: 'saved-version', makeFlat: sinceFlat,
  workingFlat: markerWorking, workingTree: 'd'.repeat(40), makeTree: 'e'.repeat(40), ...overrides });

test('a checked version saves an unlisted path against the saved tree and verifies the tree', async () => {
  const { client, calls } = checkedClient({ before: savedStatus() });
  const result = await client.saveCheckedVersion('Mode', ['.figma-cli/project.json']);
  const [, action] = calls.find(call => call[0] === 'action');
  assert.deepEqual({ first: action.firstVersion, paths: action.expectedPaths, sha: action.expectedGitSha }, { first: undefined, paths: [], sha: base });
  assert.deepEqual({ previous: result.previousGitSha, files: result.changedFiles, tree: result.tree, verification: result.verification },
    { previous: base, files: ['.figma-cli/project.json'], tree: 'd'.repeat(40), verification: 'saved-version-clean-baseline; saved-tree-matched' });
});

test('a checked version refuses listed pending files, other unsaved paths or a missing baseline before createVersion', async () => {
  const listed = checkedClient({ before: savedStatus({ persistence: state(['src/App.tsx']) }) });
  await assert.rejects(listed.client.saveCheckedVersion('Mode', ['.figma-cli/project.json']), /other pending changes/);
  const other = checkedClient({ before: savedStatus({ workingFlat: new Map([...markerWorking, ['src/x.ts', { mode: '100644', blob: '4'.repeat(40) }]]) }) });
  await assert.rejects(other.client.saveCheckedVersion('Mode', ['.figma-cli/project.json']), /unrelated or missing/);
  const headBase = checkedClient({ before: savedStatus({ treeSource: 'sandbox-head' }) });
  await assert.rejects(headBase.client.saveCheckedVersion('Mode', ['.figma-cli/project.json']), /saved version was not the comparison base/);
  for (const { calls } of [listed, other, headBase]) assert.equal(calls.some(call => call[0] === 'action'), false);
});

test('a deploy save (listed) passes exactly Make\'s listed paths and still checks every path as a tree', async () => {
  const edited = new Map([...markerWorking, ['src/App.tsx', { mode: '100644', blob: '5'.repeat(40) }]]);
  const pending = state(['src/App.tsx']);
  const { client, calls } = checkedClient({ before: savedStatus({ persistence: pending, workingFlat: edited }),
    drift: [pending, { ...state(), savedVersion: next }] });
  const queue = [savedStatus({ persistence: pending, workingFlat: edited }), { ...afterStatus(), makeFlat: edited, workingFlat: edited }];
  client.projectStatus = async () => (queue.length > 1 ? queue.shift() : queue[0]);
  const result = await client.saveCheckedVersion('deploy abc1234', ['src/App.tsx', '.figma-cli/project.json'], { listed: true });
  const [, action] = calls.find(call => call[0] === 'action');
  assert.deepEqual(action.expectedPaths, ['src/App.tsx']);
  assert.deepEqual(result.changedFiles, ['.figma-cli/project.json', 'src/App.tsx']);
  assert.equal(result.verification, 'saved-version-clean-baseline; saved-content-matched');
  const stray = checkedClient({ before: savedStatus({ persistence: state(['src/App.tsx', 'src/x.ts']), workingFlat: edited }) });
  await assert.rejects(stray.client.saveCheckedVersion('deploy', ['src/App.tsx', '.figma-cli/project.json'], { listed: true }), /other pending changes.*src\/x\.ts/);
  assert.equal(stray.calls.some(call => call[0] === 'action'), false);
});

test('a deploy save accepts a saved file mode Make kept, but not different content', async () => {
  const edited = new Map([...markerWorking, ['src/App.tsx', { mode: '100644', blob: '5'.repeat(40) }]]);
  const pending = state(['src/App.tsx']);
  const kept = new Map([...edited, ['src/App.tsx', { mode: '100755', blob: '5'.repeat(40) }]]);
  const run = after => {
    const { client } = checkedClient({ before: savedStatus({ persistence: pending, workingFlat: edited }), drift: [pending, { ...state(), savedVersion: next }] });
    const queue = [savedStatus({ persistence: pending, workingFlat: edited }), after];
    client.projectStatus = async () => (queue.length > 1 ? queue.shift() : queue[0]);
    return client.saveCheckedVersion('deploy', ['src/App.tsx', '.figma-cli/project.json'], { listed: true });
  };
  const ok = await run({ ...afterStatus('f'.repeat(40)), makeFlat: kept, workingFlat: kept });
  assert.deepEqual(ok.modeOnly, ['src/App.tsx']);
  const wrong = new Map([...edited, ['src/App.tsx', { mode: '100644', blob: '6'.repeat(40) }]]);
  const error = await run({ ...afterStatus('f'.repeat(40)), makeFlat: wrong, workingFlat: wrong }).catch(cause => cause);
  assert.match(error.message, /version 9 .* differs from the checked working tree.*Do not retry/);
});

test('override save binds sandbox head and exact working-copy diff before createVersion', async () => {
  const broken = { ...state(), hasBaseline: false, error: true };
  const advancedHead = '9'.repeat(40);
  const edited = new Map([...markerWorking, ['src/App.tsx', { mode: '100644', blob: '5'.repeat(40) }]]);
  const before = savedStatus({ persistence: broken, head: advancedHead, treeSource: 'sandbox-head', workingFlat: edited });
  const { client, calls } = checkedClient({ before, drift: [broken, { ...state(), savedVersion: next }] });
  client._sandboxGit = () => ({ head: async () => advancedHead,
    reaches: async (from, to) => from === advancedHead && to === head,
    commitTree: async sha => { assert.equal(sha, head); return 'recorded-tree'; },
    flatten: async () => sinceFlat });
  const queue = [before, { ...afterStatus(), makeFlat: edited, workingFlat: edited }];
  client.projectStatus = async () => (queue.length > 1 ? queue.shift() : queue[0]);
  const pin = { savedVersion: base, head, expectedDiff: ['.figma-cli/project.json', 'src/App.tsx'],
    allowedPaths: ['.figma-cli/project.json', 'src/App.tsx'] };
  const result = await client.saveCheckedVersion('Override', pin.allowedPaths, { listed: true, overrideMake: pin });
  assert.equal(result.gitSha, next);
  const action = calls.find(call => call[0] === 'action')[1];
  assert.equal(action.overrideMake.savedVersion, base);
  assert.deepEqual(action.expectedPaths, []);
  const moved = checkedClient({ before: { ...before, head: next }, drift: [broken] });
  moved.client._sandboxGit = () => ({ reaches: async () => false });
  await assert.rejects(moved.client.saveCheckedVersion('Override', pin.allowedPaths,
    { listed: true, overrideMake: pin }), /sandbox head is not an ancestor/);
  assert.equal(moved.calls.some(call => call[0] === 'action'), false);
  const wrong = checkedClient({ before, drift: [broken] });
  wrong.client._sandboxGit = client._sandboxGit;
  await assert.rejects(wrong.client.saveCheckedVersion('Override', pin.allowedPaths,
    { listed: true, overrideMake: { ...pin, expectedDiff: ['src/App.tsx'] } }), /unrelated or missing/);
  assert.equal(wrong.calls.some(call => call[0] === 'action'), false);
});

// The working-copy inventory never reads .npmrc, and listing exposes no file
// mode: neither a tracked .npmrc nor an executable bit is an override change.
test('override save ignores an uninventoried .npmrc and a mode-only difference from the sandbox head', async () => {
  const broken = { ...state(), hasBaseline: false, error: true };
  const advancedHead = '9'.repeat(40);
  const headFlat = new Map([...sinceFlat, ['.npmrc', { mode: '100644', blob: '6'.repeat(40) }],
    ['scripts/run.sh', { mode: '100755', blob: '7'.repeat(40) }]]);
  const edited = new Map([...markerWorking, ['src/App.tsx', { mode: '100644', blob: '5'.repeat(40) }],
    ['scripts/run.sh', { mode: '100644', blob: '7'.repeat(40) }]]);
  const savedAfter = new Map([...headFlat, ...edited, ['scripts/run.sh', { mode: '100755', blob: '7'.repeat(40) }]]);
  const before = savedStatus({ persistence: broken, head: advancedHead, treeSource: 'sandbox-head', workingFlat: edited });
  const { client, calls } = checkedClient({ before, drift: [broken, { ...state(), savedVersion: next }] });
  client._sandboxGit = () => ({ head: async () => advancedHead,
    reaches: async (from, to) => from === advancedHead && to === head,
    commitTree: async () => 'recorded-tree', flatten: async () => headFlat });
  const queue = [before, { ...afterStatus(), makeFlat: savedAfter, workingFlat: edited }];
  client.projectStatus = async () => (queue.length > 1 ? queue.shift() : queue[0]);
  const pin = { savedVersion: base, head, expectedDiff: ['.figma-cli/project.json', 'src/App.tsx'],
    allowedPaths: ['.figma-cli/project.json', 'src/App.tsx'] };
  const result = await client.saveCheckedVersion('Override', pin.allowedPaths, { listed: true, overrideMake: pin });
  assert.equal(result.gitSha, next);
  assert.deepEqual(result.changedFiles, ['.figma-cli/project.json', 'src/App.tsx']);
  assert.ok(calls.some(call => call[0] === 'action'));
  // A real content change outside the reviewed diff still refuses.
  const changed = new Map([...edited, ['scripts/run.sh', { mode: '100644', blob: '8'.repeat(40) }]]);
  const other = checkedClient({ before: { ...before, workingFlat: changed }, drift: [broken] });
  other.client._sandboxGit = client._sandboxGit;
  await assert.rejects(other.client.saveCheckedVersion('Override', pin.allowedPaths,
    { listed: true, overrideMake: pin }), /unrelated or missing.*scripts\/run\.sh/);
  assert.equal(other.calls.some(call => call[0] === 'action'), false);
});

test('project status exposes the sandbox head inventory when it differs from the saved pointer', async () => {
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 5000 });
  client.fileKey = 'ScratchKey';
  client._operation = fn => fn(Date.now() + 5000);
  client._driftState = async () => ({ state: state() });
  client._evaluate = async () => ({ generationInProgress: false });
  client._fileBridge = async () => ({ dispose: async () => {} });
  const saved = flat({ 'src/App.tsx': '1'.repeat(40) });
  const current = flat({ 'src/App.tsx': '1'.repeat(40), 'src/new.ts': '2'.repeat(40) });
  client._sandboxGit = () => ({ head: async () => head, commitTree: async rev => rev === base ? 'saved' : 'current',
    flatten: async tree => tree === 'saved' ? saved : current, readFile: async () => null });
  client.inventoryProject = async ({ tracked }) => {
    assert.ok(tracked.includes('src/new.ts'));
    return { state: state(), inventory: new Map([['src/App.tsx', { blob: '1'.repeat(40), sha256: hash('app') }],
      ['src/new.ts', { blob: '2'.repeat(40), sha256: hash('new') }]]), contents: new Map(), excluded: [], batches: 1 };
  };
  const status = await client.projectStatus();
  assert.equal(status.makeFlat.has('src/new.ts'), false);
  assert.equal(status.headFlat.has('src/new.ts'), true);
  assert.equal(status.workingFlat.has('src/new.ts'), true);
});

test('saved inventory keeps protected blob IDs without reading their contents', async () => {
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 5000 });
  client.fileKey = 'ScratchKey';
  client._operation = fn => fn(Date.now() + 5000);
  client._driftState = async () => ({ state: state() });
  client._evaluate = async () => ({ generationInProgress: false });
  client._fileBridge = async () => ({ dispose: async () => {} });
  const npmrcBlob = '3'.repeat(40);
  const appBlob = '4'.repeat(40);
  const saved = flat({ '.npmrc': npmrcBlob, 'src/App.tsx': appBlob });
  const read = [];
  client._sandboxGit = () => ({ head: async () => head, commitTree: async () => 'saved',
    flatten: async () => saved, readFile: async () => null,
    object: async blob => {
      read.push(blob);
      if (blob === npmrcBlob) throw new Error('Protected .npmrc blob was read');
      return { type: 'blob', content: Buffer.from('app') };
    } });
  client.inventoryProject = async () => ({ state: state(), inventory: new Map([
    ['src/App.tsx', { blob: appBlob, sha256: hash('app') }]]), contents: new Map(), excluded: ['.npmrc'], batches: 1 });
  const status = await client.projectStatus({ savedInventory: true, savedProtected: path => path === '.npmrc' });
  assert.deepEqual(read, [appBlob]);
  assert.equal(status.savedBlobs.get('.npmrc'), npmrcBlob);
  assert.equal(status.savedSha256.get('src/App.tsx'), hash('app'));
  assert.equal(status.savedSha256.has('.npmrc'), false);
});

test('reload waits for a new document and its Make state', async () => {
  const sent = [];
  const client = new MakeClient({ transport: { close() {}, send: async method => { sent.push(method); return {}; } }, timeoutMs: 5000 });
  client.fileKey = 'ScratchKey';
  client._operation = fn => fn(Date.now() + 5000);
  const answers = [true, false, new Error('Execution context was destroyed.'), true];
  client._evaluate = async () => { const next = answers.shift(); if (next instanceof Error) throw next; return next; };
  client._driftState = async () => ({ state: state() });
  const result = await client.reloadPage();
  assert.deepEqual(sent, ['Page.reload']);
  assert.equal(answers.length, 0);
  assert.equal(result.persistence.savedVersion, base);
});

test('durable CDP calls use the operation budget while saves keep ordinary waits', async () => {
  const seen = [];
  const client = new MakeClient({ transport: { timeoutMs: 5000, close() {}, send: async () => ({}),
    evaluate: async (expression, options) => { seen.push(options.timeoutMs); return { exists: false }; } }, timeoutMs: 120000 });
  client.fileKey = 'ScratchKey';
  await client._operation(async deadline => {
    seen.length = 0;
    await client._durable({ type: 'write', path: 'src/big.scss', content: 'x'.repeat(377 * 1024), expectedContent: null }, deadline);
    await client._durable({ type: 'write', path: 'src/small.ts', content: 'x', expectedContent: null }, deadline);
    await client._durable({ type: 'read', path: 'src/big.scss' }, deadline);
    await client._durable({ type: 'write', path: 'src/big.scss', content: 'x'.repeat(2 * 1024 * 1024), expectedContent: null }, Date.now() + 30000);
    await client._treeTransport(deadline).evaluate('true');
    await client._editor({ type: 'inspect' }, deadline);
  }, { durable: true });
  assert.ok(seen[0] > 110000 && seen[0] <= 120000, `large write: ${seen[0]}`);
  assert.ok(seen[1] > 110000 && seen[1] <= 120000, `small write: ${seen[1]}`);
  assert.ok(seen[2] > 110000 && seen[2] <= 120000, `read waits up to the deadline: ${seen[2]}`);
  assert.ok(seen[3] <= 30000, `capped by the deadline: ${seen[3]}`);
  assert.ok(seen[4] > 110000 && seen[4] <= 120000, `tree read-back: ${seen[4]}`);
  assert.ok(seen[5] > 110000 && seen[5] <= 120000, `editor read-back: ${seen[5]}`);
  await client._operation(async deadline => {
    seen.length = 0;
    await client._durable({ type: 'save', title: 'Version', expectedPaths: ['src/small.ts'] }, deadline);
    await client._treeTransport(deadline).evaluate('true');
  });
  assert.equal(seen.length, 2);
  assert.ok(seen.every(wait => wait >= 5000 && wait < 30000), `ordinary waits: ${seen}`);
});

test('a slow fake Make page completes a durable write within its operation deadline', async () => {
  let calls = 0;
  const client = new MakeClient({ transport: { close() {}, send: async () => ({}), timeoutMs: 5000,
    evaluate: async (_expression, { timeoutMs }) => {
      if (++calls === 1) return { accepted: true };
      assert.ok(timeoutMs >= 28000);
      await new Promise(resolve => setTimeout(resolve, 10500));
      return { accepted: true };
    } }, timeoutMs: 30000 });
  client.fileKey = 'ScratchKey';
  assert.deepEqual(await client._operation(deadline => client._durable({ type: 'write', path: 'src/App.tsx', content: 'x', expectedContent: null }, deadline), { durable: true }),
    { accepted: true });
});

test('a hung fake Make page stops at the operation deadline', async () => {
  let calls = 0;
  const client = new MakeClient({ transport: { close() {}, send: async () => ({}), timeoutMs: 0,
    evaluate: () => ++calls === 1 ? { accepted: true } : new Promise(() => {}) }, timeoutMs: 1500 });
  client.fileKey = 'ScratchKey';
  const started = Date.now();
  await assert.rejects(client._operation(deadline => client._durable({ type: 'write', path: 'src/App.tsx', content: 'x', expectedContent: null }, deadline), { durable: true }),
    /Make operation timed out/);
  assert.ok(Date.now() - started < 5000);
});

test('durable write and delete keep the busy-page wait through preflight and read-back', async () => {
  const { client } = fakeClient({ original: 'old' });
  client._operation = async (fn, options) => {
    assert.deepEqual(options, { durable: true });
    return fn(Date.now() + 30000);
  };
  await client.writeDurable('src/App.tsx', 'new', { expectedSha256: hash('old') });
  await client.deleteDurable('src/App.tsx', { expectedSha256: hash('new') });

  const waits = [];
  const scoped = new MakeClient({ transport: { close() {}, timeoutMs: 5000,
    send: async () => ({}), evaluate: async (_expression, { timeoutMs }) => {
      waits.push(timeoutMs);
      return { codeReady: true, needsFilesTab: false, state: state(), editorCount: 1, content: 'new' };
    } }, timeoutMs: 30000 });
  scoped.fileKey = 'ScratchKey';
  await scoped._operation(async deadline => {
    await scoped._ensureCode(deadline);
    await scoped._driftState(deadline);
    await scoped._treeTransport(deadline).evaluate('true');
    await scoped._editor({ type: 'inspect' }, deadline);
  }, { durable: true });
  assert.ok(waits.every(wait => wait >= 28000), `durable waits: ${waits}`);
  assert.equal(scoped._durableOperation, false);
});

// A deep existing file whose post-write read-back outlives the operation
// deadline although Make accepted the bytes.
function uncertainClient({ sandbox = current => current, refuse = false, observed } = {}) {
  const fake = fakeClient({ original: 'old' });
  const { client, calls } = fake;
  client._durableAgreement = async (path, content) => {
    calls.push(['agreement', path, content]);
    if (content === 'new') {
      throw Object.assign(new Error(`Make read-back for ${path} timed out before every view agreed (vfs matched, editor unavailable)`), { observed });
    }
  };
  if (refuse) {
    const durable = client._durable;
    client._durable = async action => action.type === 'write' ? (calls.push(['write', action.path]), { refused: 'Make source changed.' }) : durable(action);
  }
  client._fileBridge = async () => ({ dispose: async () => { calls.push(['dispose']); } });
  client._bridgeRead = async (_bridge, path) => {
    calls.push(['sandbox', path]);
    const { content } = await client._durable({ type: 'read', path });
    return { content: sandbox(content) };
  };
  return fake;
}

test('an uncertain write is read back once and confirmed when VFS and sandbox hold the target bytes', async () => {
  const path = 'src/vendor/atomic-aui/lib/table/table-row.tsx';
  const { client, calls } = uncertainClient();
  await assert.rejects(client.writeDurable(path, 'new', { expectedSha256: hash('old') }), /outcome is uncertain/);
  const confirmed = uncertainClient();
  const result = await confirmed.client.writeDurableConfirmed(path, 'new', { expectedSha256: hash('old') });
  assert.equal(result.verification, 'vfs-sandbox-matched-after-uncertain-write');
  assert.equal(result.changed, true);
  assert.equal(result.sha256, hash('new'));
  assert.equal(result.beforeSha256, hash('old'));
  assert.equal(result.backupPath, '/private/backup');
  assert.equal(result.persistence, 'pending-version');
  assert.match(result.uncertainCause, /timed out before every view agreed/);
  assert.equal(confirmed.calls.filter(call => call[0] === 'write').length, 1);
  // The fake sandbox read reads the fake VFS, hence the inner 'read'.
  assert.deepEqual(confirmed.calls.slice(-4), [['read', path], ['sandbox', path], ['read', path], ['dispose']]);
  assert.equal(calls.some(call => call[0] === 'sandbox'), false);
});

test('an uncertain write whose read-back differs keeps the error and reports what was read', async () => {
  const path = 'src/vendor/atomic-aui/lib/list/list.tsx';
  const { client, calls } = uncertainClient({ sandbox: () => 'old' });
  const error = await client.writeDurableConfirmed(path, 'new', { expectedSha256: hash('old') }).catch(cause => cause);
  assert.match(error.message, /outcome is uncertain: .*Read-back after it: client VFS matched, sandbox different\./);
  assert.deepEqual({ vfs: error.readBack.vfs, sandbox: error.readBack.sandbox, sandboxSha256: error.readBack.sandboxSha256,
    targetSha256: error.readBack.targetSha256 }, { vfs: 'matched', sandbox: 'different', sandboxSha256: hash('old'), targetSha256: hash('new') });
  assert.equal(error.backupPath, '/private/backup');
  assert.equal(calls.filter(call => call[0] === 'write').length, 1);
});

test('an uncertain write whose mounted editor or rendered tree disagreed keeps the error without confirming', async () => {
  for (const observed of [{ vfs: 'matched', sandbox: 'matched', tree: 'present', editor: 'different' },
    { vfs: 'matched', sandbox: 'matched', tree: 'absent' }]) {
    const { client, calls } = uncertainClient({ observed });
    const error = await client.writeDurableConfirmed('src/App.tsx', 'new', { expectedSha256: hash('old') }).catch(cause => cause);
    assert.ok(error instanceof Error, JSON.stringify(observed));
    assert.match(error.message, /outcome is uncertain: .*timed out before every view agreed/);
    assert.deepEqual(error.uncertainWrite.observed, observed);
    assert.equal(calls.filter(call => call[0] === 'write').length, 1);
  }
  const unanswered = uncertainClient({ observed: { vfs: 'matched', sandbox: 'matched', tree: 'present', editor: 'unavailable' } });
  const result = await unanswered.client.writeDurableConfirmed('src/App.tsx', 'new', { expectedSha256: hash('old') });
  assert.equal(result.verification, 'vfs-sandbox-matched-after-uncertain-write');
  assert.equal('observed' in result, false);
});

test('a write the page refused is not read back as if it might have landed', async () => {
  const { client, calls } = uncertainClient({ refuse: true });
  const error = await client.writeDurableConfirmed('src/App.tsx', 'new', { expectedSha256: hash('old') }).catch(cause => cause);
  assert.match(error.message, /Make source changed/);
  assert.equal(error.readBack, undefined);
  assert.equal(calls.some(call => call[0] === 'sandbox'), false);
});

test('a failed read-back after an uncertain write is reported with the original error', async () => {
  const { client } = uncertainClient();
  client._fileBridge = async () => { throw new Error('No Make filesystem connection was observed'); };
  await assert.rejects(client.writeDurableConfirmed('src/App.tsx', 'new', { expectedSha256: hash('old') }),
    /outcome is uncertain: .*The read-back after it also failed: No Make filesystem connection/);
});

test('a new file\'s pre-write absence check reuses the ancestor check\'s tree listing', async () => {
  const path = 'public/atomicaui/7.0.2/manifest.json';
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 5000 });
  client.fileKey = 'ScratchKey';
  client._operation = fn => fn(Date.now() + 5000);
  client._ensureCode = async () => ({ busy: false, offline: false, readOnly: false });
  client._driftState = async () => ({ state: state() });
  let current = null;
  const listings = [];
  const entries = () => [{ kind: 'folder', path: 'public' }, { kind: 'folder', path: 'public/atomicaui' },
    ...(current === null ? [] : [{ kind: 'folder', path: 'public/atomicaui/7.0.2' }, { kind: 'file', path }])];
  client._sourceTree = async (_deadline, expectedChange, onSnapshot) => {
    listings.push(current === null ? 'before' : 'after');
    if (current !== null) assert.equal(expectedChange.beforeEntries.length, 2);
    const list = entries();
    onSnapshot?.({ entries: list, rows: list.map(entry => ({ name: entry.path })) });
    return list;
  };
  client._durable = async action => {
    if (action.type === 'read') return { exists: current !== null, content: current };
    if (action.type === 'write') { current = action.content; return { accepted: true }; }
  };
  client._fileBridge = async () => ({ dispose: async () => {}, invoke: async (_fn, [, data]) => {
    const names = { code: ['public'], 'code/public': ['atomicaui'], 'code/public/atomicaui': current === null ? [] : ['7.0.2'] }[data.path];
    if (!names) throw new Error('Make filesystem request timed out; outcome is unknown.');
    return { success: true, data: { path: data.path, files: names.map(name => ({ name })) } };
  } });
  client._bridgeRead = async () => ({ content: current });
  const result = await client.writeDurable(path, '{}', { releaseAsset: true });
  assert.equal(result.verification, 'tree-vfs-sandbox-release-matched');
  assert.deepEqual(listings, ['before', 'after']);
});

test('several sandbox files are read in one operation without listing the file tree', async () => {
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 5000 });
  client.fileKey = 'ScratchKey';
  let operations = 0;
  client._operation = fn => { operations++; return fn(Date.now() + 5000); };
  client._sourceTree = async () => { throw new Error('the tree must not be listed'); };
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async (_bridge, path) => ({ content: `bytes of ${path}` });
  const files = await client.readRemoteFiles(['package.json', 'public/atomicaui/latest.json']);
  assert.equal(operations, 1);
  assert.deepEqual([...files.keys()], ['package.json', 'public/atomicaui/latest.json']);
  assert.equal(files.get('package.json').sha256, hash('bytes of package.json'));
  assert.throws(() => client.readRemoteFiles([]), /1–64/);
  assert.throws(() => client.readRemoteFiles(['../escape']), /path/i);
});

test('make write offers the vendor tree fallback', () => {
  const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'make', 'write', '--help'],
    { env: { ...process.env, FIGMA_CLI_NO_UPDATE_CHECK: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--vendor-tree-fallback/);
});
