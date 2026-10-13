import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MakeClient } from '../src/make-client.js';
import { compareVendor, digest, driftExitCode, externalReceipt, vendorManifest } from '../src/make-drift.js';
import { makePersistenceState } from '../src/make-persistence.js';

const root = 'src/vendor/atomic-aui';
const gitSha = 'a'.repeat(40);
const clean = { mode: 'git', hasBaseline: true, savedVersion: gitSha, pendingCount: 0, isLoading: false, error: false };
const expected = { 'a.ts': Buffer.from('alpha\n'), 'tokens/generated/.generated': Buffer.from('sentinel\n') };
const manifestBytes = Buffer.from(JSON.stringify({ files: Object.entries(expected).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) })) }));
const manifest = vendorManifest(manifestBytes, root);
const info = bytes => ({ bytes: bytes.length, sha256: digest(bytes) });
const inventory = additions => new Map(Object.entries({
  ...Object.fromEntries(Object.entries(expected).map(([path, bytes]) => [path, info(bytes)])),
  'VENDOR.json': info(manifestBytes), ...additions,
}));
const compare = (files, more = {}) => compareVendor(manifest, files, {
  manifestFile: files.get('VENDOR.json'), stateBefore: clean, stateAfter: clean, ...more,
});

test('vendor classifications and exit codes include missing, mismatched and extra files', () => {
  const matched = compare(inventory());
  assert.equal(driftExitCode(matched), 0);
  assert.deepEqual(matched.counts, { matched: 2, mismatched: 0, missing: 0, extra: 0 });
  const files = inventory({ 'a.ts': info(Buffer.from('changed')), 'new.ts': info(Buffer.from('extra')) });
  files.delete('tokens/generated/.generated');
  const result = compare(files);
  assert.equal(driftExitCode(result), 1);
  assert.deepEqual(result.counts, { matched: 0, mismatched: 1, missing: 1, extra: 1 });
  assert.deepEqual(Object.fromEntries(result.files.map(file => [file.path, file.status])), {
    'a.ts': 'mismatched', 'new.ts': 'extra', 'tokens/generated/.generated': 'missing',
  });
});

test('pending, missing baseline, mode and changing state fail persistence proof', () => {
  const files = inventory();
  for (const state of [
    { ...clean, pendingCount: 1 }, { ...clean, savedVersion: null },
    { ...clean, mode: 'snapshot' }, { ...clean, isLoading: true }, null,
  ]) assert.equal(driftExitCode(compare(files, { stateAfter: state })), 1);
  assert.match(compare(files, { stateAfter: { ...clean, pendingCount: 1 } }).reasons.join(' '), /pending/);
  assert.match(compare(files, { stateAfter: { ...clean, mode: 'snapshot' } }).reasons.join(' '), /Snapshot/);
  assert.equal(driftExitCode(compare(files, { manifestFile: null })), 1);
});

test('external receipt pins exact file, manifest and saved git revision', () => {
  const bytes = Buffer.from(JSON.stringify({ fileKey: 'ExactKey', manifestSha256: manifest.sha256, savedVersionGitSha: gitSha }));
  const receipt = externalReceipt(bytes, { fileKey: 'ExactKey', manifestSha256: manifest.sha256 });
  assert.equal(driftExitCode(compare(inventory(), { receipt })), 0);
  assert.equal(driftExitCode(compare(inventory(), { receipt, stateAfter: { ...clean, savedVersion: 'b'.repeat(40) } })), 1);
  assert.throws(() => externalReceipt(bytes, { fileKey: 'WrongKey', manifestSha256: manifest.sha256 }), /pin/);
});

test('manifest rejects missing hashes, self entries and ambiguous paths', () => {
  for (const files of [[{ path: 'a.ts', bytes: 1 }],
    [{ path: 'VENDOR.json', bytes: 1, sha256: digest('x') }],
    [{ path: '../a.ts', bytes: 1, sha256: digest('x') }],
    [{ path: 'a.ts', bytes: 1, sha256: digest('x') }, { path: 'A.ts', bytes: 1, sha256: digest('x') }]]) {
    assert.throws(() => vendorManifest(Buffer.from(JSON.stringify({ files })), root));
  }
});

test('mode detection reads bounded React state for git and snapshot modes', () => {
  const previous = globalThis.document;
  const codeFileChanges = { isGitSourceOfTruth: true, hasBaseline: true,
    baselineMakeVersionGitSha: gitSha, changedFiles: [], isLoading: false, error: null };
  globalThis.document = { querySelectorAll: () => [{ '__reactFiber$test': {
    memoizedProps: { codeFileChanges }, memoizedState: null, child: null, sibling: null,
  } }] };
  try {
    assert.deepEqual(makePersistenceState(), clean);
    codeFileChanges.isGitSourceOfTruth = false;
    codeFileChanges.baselineMakeVersionGitSha = null;
    codeFileChanges.changedFiles = [{ path: 'src/App.tsx' }];
    assert.equal(makePersistenceState().mode, 'snapshot');
    assert.equal(makePersistenceState().pendingCount, 1);
  } finally { globalThis.document = previous; }
});

test('persistence discovery fails closed when a traversal budget hides a later live provider', () => {
  const previous = globalThis.document;
  const state = pending => ({ codeFileChanges: { isGitSourceOfTruth: true, hasBaseline: true,
    baselineMakeVersionGitSha: gitSha, changedFiles: pending ? [{ path: 'src/App.tsx' }] : [], isLoading: false, error: null } });
  const tree = (fillers, props, hooks = null) => {
    let child = { memoizedProps: state(true), memoizedState: null, child: null, sibling: null };
    for (let i = 0; i < fillers; i++) child = { memoizedProps: props(), memoizedState: hooks, child, sibling: null };
    return { memoizedProps: state(false), memoizedState: null, child, sibling: null };
  };
  const longHooks = { memoizedState: null, next: null };
  for (let i = 0, hook = longHooks; i < 100; i++) hook = hook.next = { memoizedState: null, next: null };
  const results = [];
  try {
    for (const root of [tree(0, () => null), tree(50001, () => ({})), tree(100001, () => null), tree(1, () => null, longHooks)]) {
      globalThis.document = { querySelectorAll: () => [{ '__reactFiber$test': root }] };
      results.push(makePersistenceState());
    }
  } finally { globalThis.document = previous; }
  assert.deepEqual(results[0], { ambiguous: true, count: 2 });
  for (const result of results.slice(1)) assert.equal(result, null);
});

test('read-only client inventory includes nested dotfiles and never sends writes', async () => {
  const fs = new Map([...Object.entries(expected).map(([path, bytes]) => [`${root}/${path}`, bytes]), [`${root}/VENDOR.json`, manifestBytes]]);
  const calls = [];
  const directory = {
    [root]: [{ name: 'a.ts', isFile: true, isDirectory: false },
      { name: 'tokens', isFile: false, isDirectory: true },
      { name: 'VENDOR.json', isFile: true, isDirectory: false }],
    [`${root}/tokens`]: [{ name: 'generated', isFile: false, isDirectory: true }],
    [`${root}/tokens/generated`]: [{ name: '.generated', isFile: true, isDirectory: false }],
  };
  const client = new MakeClient({ transport: { close() {}, send: async () => ({}) }, timeoutMs: 5000 });
  client.fileKey = 'ExactKey';
  client._driftState = async () => clean;
  client._fileBridge = async () => ({
    dispose: async () => {},
    invoke: async (_fn, [type, data]) => {
      calls.push({ type, data });
      if (type === 'fs/dir/list') {
        const path = data.path.slice(5);
        return { success: true, data: { path: data.path,
          files: directory[path]?.map(file => ({ path: file.name, ...file })) } };
      }
      const bytes = fs.get(data.path.slice(5));
      return { success: !!bytes, data: { path: data.path, encoding: 'base64', content: bytes?.toString('base64') } };
    },
  });
  const result = await client.drift(manifestBytes, { root });
  assert.equal(result.ok, true);
  assert.equal(result.counts.matched, 2);
  assert.ok(result.files.some(file => file.path === 'tokens/generated/.generated' && file.status === 'matched'));
  assert.ok(calls.filter(call => call.type === 'fs/dir/list').every(call => call.data.includeHidden === true));
  assert.ok(calls.every(call => ['fs/dir/list', 'fs/file/read'].includes(call.type)));
});
