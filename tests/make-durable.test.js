import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MakeClient } from '../src/make-client.js';
import { makeDurablePageAction, requireExactPending, requireGitMode } from '../src/make-durable.js';

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
    assert.equal(options.editorWaitMs, undefined);
    return { content: 'new' };
  };
  assert.equal(await client._durableAgreement('src/a.ts', 'new', Date.now() + 1000), 'editor-tree-vfs-sandbox-matched');
});

test('a slow editor on a non-Markdown file fails instead of falling back to VFS, sandbox and tree', async () => {
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 5000 });
  client.fileKey = 'ScratchKey';
  client._durable = async () => ({ exists: true, content: 'export default 1;\n' });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async () => ({ content: 'export default 1;\n' });
  client._sourceTree = async () => [{ kind: 'file', path: 'src/App.tsx' }];
  client._select = async () => ({ name: 'App.tsx' });
  // The editor has not mounted after the Markdown preview window.
  client._editor = async action => { assert.equal(action.type, 'inspect'); return { editorCount: 0 }; };
  const error = await client._durableAgreement('src/App.tsx', 'export default 1;\n', Date.now() + 3500).catch(cause => cause);
  assert.ok(error instanceof Error, 'a missing editor must not verify a non-Markdown write');
  assert.match(error.message, /src\/App\.tsx timed out before every view agreed \(vfs matched, sandbox matched, tree present, editor unavailable\)/);
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
