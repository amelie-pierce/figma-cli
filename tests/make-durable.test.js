import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
    if (data.path !== 'code/src') return { success: false, error: 'not found' };
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
