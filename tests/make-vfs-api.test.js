import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { MakeClient } from '../src/make-client.js';
import { makeDurablePageAction } from '../src/make-durable.js';

// The current Make API has prototype methods and async text-content getters;
// fetchEntry can return a directory as well as a file, or null for absence.
function page(files = {}) {
  const contents = new Map(Object.entries(files));
  const calls = [];
  class TextEntry {
    constructor(path) { this.path = path; }
    get asyncContents() { return Promise.resolve(contents.get(this.path)); }
  }
  class VFS {
    async fetchEntry(path) {
      calls.push(['fetch', path]);
      return contents.has(path) ? new TextEntry(path) : null;
    }
    async writeFile(path, content) { calls.push(['write', path, content]); contents.set(path, content); }
    async deleteFile(path) { calls.push(['delete', path]); contents.delete(path); }
  }
  const vfs = new VFS();
  const props = {
    vfs,
    codeFileChanges: { isGitSourceOfTruth: true, hasBaseline: true, baselineMakeVersionGitSha: 'a'.repeat(40),
      isLoading: false, changedFiles: [{ path: 'src/a.ts' }] },
    state: { sandbox: { async createVersion(options) {
      calls.push(['save', { ...options }]); return { id: 'version', versionNumber: 2, gitSha: 'b'.repeat(40) };
    } } },
    chatController: { chatSdkState: { threadId: 'thread' } },
  };
  const root = { memoizedProps: props };
  const context = { document: { querySelectorAll: () => [{ '__reactFiber$test': root }] },
    URL, location: { href: 'https://www.figma.com/make/ExactKey/test' } };
  // Exercise serialization too: page code must not depend on module helpers.
  const evaluate = async expression => JSON.parse(JSON.stringify(await runInNewContext(expression, context)));
  const action = input => evaluate(`(${makeDurablePageAction.toString()})(${JSON.stringify(input)})`);
  return { action, evaluate, vfs, calls, contents, props, root };
}

test('current VFS reads missing, empty and Unicode text without writes or saves', async () => {
  const { action, calls } = page({ '/src/empty.ts': '', '/src/a.ts': '한글\r\n🙂\n' });
  for (const [path, content] of [['.figma-cli/project.json', null], ['src/empty.ts', ''], ['src/a.ts', '한글\r\n🙂\n']]) {
    assert.deepEqual(await action({ type: 'read', path }), { exists: content !== null, content });
  }
  assert.deepEqual(calls.map(call => call[0]), ['fetch', 'fetch', 'fetch']);
});

test('projectMarker caller uses the serialized current VFS read and preserves exact-file guard', async () => {
  const { evaluate, contents, calls } = page();
  const client = new MakeClient({ transport: { evaluate } });
  client.fileKey = 'ExactKey';
  client._operation = fn => fn(Date.now() + 5000);
  assert.equal(await client.projectMarker(), null);
  contents.set('/.figma-cli/project.json', '{"mode":"team"}\n');
  assert.equal((await client.projectMarker()).toString(), '{"mode":"team"}\n');
  client.fileKey = 'DifferentKey';
  await assert.rejects(client.projectMarker(), /no longer matches/);
  assert.deepEqual(calls.map(call => call[0]), ['fetch', 'fetch']);
});

test('current VFS rechecks exact bytes for create, replace and delete', async () => {
  const { action, contents, calls } = page({ '/src/a.ts': 'old' });
  assert.deepEqual(await action({ type: 'write', path: 'src/new.ts', expectedContent: null, content: '' }), { accepted: true });
  assert.match((await action({ type: 'write', path: 'src/new.ts', expectedContent: null, content: 'overwrite' })).refused, /changed/);
  assert.match((await action({ type: 'write', path: 'src/a.ts', expectedContent: 'stale', content: 'new' })).refused, /changed/);
  assert.deepEqual(await action({ type: 'write', path: 'src/a.ts', expectedContent: 'old', content: 'new' }), { accepted: true });
  assert.match((await action({ type: 'delete', path: 'src/a.ts', expectedContent: 'old' })).refused, /changed/);
  assert.deepEqual(await action({ type: 'delete', path: 'src/a.ts', expectedContent: 'new' }), { accepted: true });
  assert.deepEqual([...contents], [['/src/new.ts', '']]);
  assert.deepEqual(calls.filter(call => call[0] !== 'fetch'), [
    ['write', '/src/new.ts', ''], ['write', '/src/a.ts', 'new'], ['delete', '/src/a.ts'],
  ]);
});

test('current VFS fetch and content failures propagate without legacy fallback or mutation', async () => {
  for (const failure of ['fetch', 'content']) {
    const { vfs, action, calls } = page();
    vfs.getFileEntryByPath = () => { throw Error('Must not fall back'); };
    vfs.fetchEntry = async () => {
      if (failure === 'fetch') throw Error('Fetch failed');
      return { get asyncContents() { return Promise.reject(Error('Contents failed')); } };
    };
    for (const type of ['read', 'write', 'delete']) {
      await assert.rejects(action({ type, path: 'src/a.ts', expectedContent: null, content: 'new' }),
        failure === 'fetch' ? /Fetch failed/ : /Contents failed/);
    }
    assert.deepEqual(calls, []);
  }
});

test('current VFS refuses directories and non-text entries before mutation', async () => {
  for (const entry of [{ path: '/src', loadState: 'loaded' }, { asyncContents: new Uint8Array([1]) },
    { asyncContents: null }, { asyncContents: undefined }]) {
    const { vfs, action, calls } = page();
    vfs.fetchEntry = async () => entry;
    for (const type of ['read', 'write', 'delete']) {
      await assert.rejects(action({ type, path: 'src', expectedContent: null, content: 'new' }), /not a text file/);
    }
    assert.deepEqual(calls, []);
  }
});

test('current VFS lookup wins over legacy and cache-only APIs, which cannot prove absence', async () => {
  const { vfs, action } = page({ '/src/a.ts': 'current' });
  vfs.getCachedEntry = () => null;
  vfs.getFileEntryByPath = () => ({ asyncContents: 'stale' });
  assert.deepEqual(await action({ type: 'read', path: 'src/a.ts' }), { exists: true, content: 'current' });
  vfs.fetchEntry = undefined;
  assert.deepEqual(await action({ type: 'read', path: 'src/a.ts' }), { exists: true, content: 'stale' });
  vfs.getFileEntryByPath = undefined;
  await assert.rejects(action({ type: 'write', path: 'src/a.ts', expectedContent: null, content: 'new' }), /lookup is unsupported/);
});

test('multiple current VFS providers remain ambiguous and cannot mutate', async () => {
  const { root, action, calls } = page();
  root.child = { memoizedProps: { vfs: page().vfs } };
  await assert.rejects(action({ type: 'write', path: 'src/a.ts', expectedContent: null, content: 'new' }), /absent or ambiguous/);
  assert.deepEqual(calls, []);
});

test('version creation retains the exact baseline and pending-set guard with current VFS', async () => {
  const { action, calls } = page();
  const save = { type: 'save', title: 'Saved', expectedGitSha: 'a'.repeat(40), expectedPaths: ['src/a.ts'] };
  assert.match((await action({ ...save, expectedPaths: ['src/other.ts'] })).refused, /pending file set/);
  assert.match((await action({ ...save, expectedGitSha: 'c'.repeat(40) })).refused, /pending file set/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await action(save), { id: 'version', versionNumber: 2, gitSha: 'b'.repeat(40) });
  assert.deepEqual(calls, [['save', { threadId: 'thread', title: 'Saved' }]]);
});
