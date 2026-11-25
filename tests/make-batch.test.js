import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MakeClient } from '../src/make-client.js';
import { checkChangedTree } from '../src/make-tree.js';
import { MAX_BATCH_BYTES, MAX_BATCH_FILES, batchBarred, chunkBatch, writeInOrder } from '../src/make-batch.js';
import { gitBlobSha } from '../src/git-tree.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const base = 'a'.repeat(40);

// The rendered tree of a set of paths: one row (32 px) per folder and file, folders first.
function render(paths) {
  const folders = new Set();
  for (const path of paths) path.split('/').slice(0, -1).forEach((_, i, parts) => folders.add(path.split('/').slice(0, i + 1).join('/')));
  const all = [...[...folders].map(path => ({ path, kind: 'folder' })), ...paths.map(path => ({ path, kind: 'file' }))]
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const entries = all.map((entry, index) => ({ ...entry, level: entry.path.split('/').length, top: index * 32 }));
  return { entries, rows: entries.map(entry => ({ top: entry.top, height: 32, kind: entry.kind, level: entry.level })) };
}

// A MakeClient over a fake Make: client VFS, sandbox, saved version, rendered tree. The real writeDurableBatch,
// _agreeBatch, _settleTracker and checkChangedTree run; only Make's own transport is replaced.
function fakeMake(initial, { sandbox, hooks = {} } = {}) {
  const vfs = new Map(Object.entries(initial));
  const sb = new Map(Object.entries(sandbox ?? initial));
  const saved = new Map(Object.entries(initial));
  const calls = [];
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 3000 });
  client.fileKey = 'ScratchKey';
  client._operation = fn => fn(Date.now() + 3000);
  client._ensureCode = async () => ({ busy: false, offline: false, readOnly: false });
  const pending = () => [...new Set([...saved.keys(), ...vfs.keys()])]
    .filter(path => saved.get(path) !== vfs.get(path) && !path.split('/').some(part => part.startsWith('.'))).sort();
  client._driftState = async () => ({ state: { mode: 'git', hasBaseline: true, savedVersion: base, pendingPaths: pending(),
    pendingCount: pending().length, isLoading: false, error: false } });
  client._sandboxGit = () => ({ commitTree: async () => 'saved',
    flatten: async () => new Map([...saved].map(([path, content]) => [path, { blob: gitBlobSha(Buffer.from(content)) }])) });
  client._sourceTree = async (_deadline, expectedChange, onSnapshot) => {
    calls.push(['tree', Boolean(expectedChange)]);
    const shown = hooks.tree ? hooks.tree([...vfs.keys()].filter(path => !path.split('/').some(part => part.startsWith('.')))) : [...vfs.keys()].filter(path => !path.split('/').some(part => part.startsWith('.')));
    const { entries, rows } = render(shown);
    const result = hooks.rows ? hooks.rows(entries, rows) : { entries, rows };
    onSnapshot?.(result);
    if (expectedChange) checkChangedTree(expectedChange, result.entries, result.rows);
    return result.entries;
  };
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async (_bridge, path) => {
    calls.push(['sandbox-read', path]);
    if (!sb.has(path)) throw new Error('missing');
    return { content: sb.get(path) };
  };
  client._sandboxAbsent = async (_bridge, path) => !sb.has(path);
  client._backup = async (path, content) => { calls.push(['backup', path]); return `/private/backup/${path}`; };
  client._editor = async () => ({ editorCount: 0 });
  client._durable = async action => {
    if (action.type === 'read') return { exists: vfs.has(action.path), content: vfs.get(action.path) };
    calls.push([action.type, action.path]);
    const guard = action.expectedContent ?? null;
    if ((vfs.get(action.path) ?? null) !== guard) return { refused: `Make source changed at ${action.path}.` };
    await hooks.beforeWrite?.(action, { vfs, sb });
    if (action.type === 'write') { vfs.set(action.path, action.content); if (!hooks.lagSandbox) sb.set(action.path, action.content); }
    else { vfs.delete(action.path); if (!hooks.lagSandbox) sb.delete(action.path); }
    await hooks.afterWrite?.(action, { vfs, sb });
    return { accepted: true };
  };
  return { client, calls, vfs, sb, saved, writes: () => calls.filter(call => ['write', 'delete'].includes(call[0])).map(call => call[1]) };
}

const edit = (path, content, from) => ({ path, content, expectedSha256: hash(from) });
const add = (path, content) => ({ path, content });
const remove = (path, from) => ({ path, delete: true, expectedSha256: hash(from) });

test('a batch writes in the given order, edits, adds and deletes together, and returns one result per item in order', async () => {
  const { client, writes, vfs, sb } = fakeMake({ 'src/a.ts': 'a0', 'src/b.ts': 'b0', 'src/c.ts': 'c0', 'src/lib/d.ts': 'd0' });
  const results = await client.writeDurableBatch([
    edit('src/c.ts', 'c1', 'c0'), add('src/lib/e.ts', 'e1'), remove('src/b.ts', 'b0'), edit('src/a.ts', 'a1', 'a0'), add('src/new/f.ts', 'f1'),
  ]);
  assert.deepEqual(writes(), ['src/c.ts', 'src/lib/e.ts', 'src/b.ts', 'src/a.ts', 'src/new/f.ts']);
  assert.deepEqual(results.map(result => result.path), ['src/c.ts', 'src/lib/e.ts', 'src/b.ts', 'src/a.ts', 'src/new/f.ts']);
  assert.deepEqual(results.map(result => result.changed), [true, true, true, true, true]);
  assert.equal(results[0].sha256, hash('c1'));
  assert.equal(results[0].beforeSha256, hash('c0'));
  assert.equal(results[0].backupPath, '/private/backup/src/c.ts');
  assert.equal(results[1].backupPath, null);
  assert.equal(results[2].sha256, null);
  assert.equal(results[2].verification, 'tree-vfs-sandbox-delete-matched');
  assert.equal(results[3].verification, 'tree-vfs-sandbox-matched');
  assert.deepEqual([...vfs].sort(), [...sb].sort());
  assert.equal(vfs.get('src/new/f.ts'), 'f1');
  assert.equal(vfs.has('src/b.ts'), false);
});

test('a batch scans the tree once before and once after, however many files it holds', async () => {
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/f${i}.ts`, `v0-${i}`]));
  const { client, calls } = fakeMake(files);
  await client.writeDurableBatch(Object.keys(files).map((path, i) => edit(path, `v1-${i}`, `v0-${i}`)));
  assert.deepEqual(calls.filter(call => call[0] === 'tree'), [['tree', false], ['tree', true]]);
});

test('an unchanged file is verified but neither backed up nor written, and is reported unchanged', async () => {
  const { client, writes, calls } = fakeMake({ 'src/a.ts': 'same', 'src/b.ts': 'b0' });
  const results = await client.writeDurableBatch([edit('src/a.ts', 'same', 'same'), edit('src/b.ts', 'b1', 'b0')]);
  assert.deepEqual(writes(), ['src/b.ts']);
  assert.equal(calls.some(call => call[0] === 'backup' && call[1] === 'src/a.ts'), false);
  assert.deepEqual(results.map(result => [result.path, result.changed, result.verification]), [['src/a.ts', false, 'unchanged'], ['src/b.ts', true, 'tree-vfs-sandbox-matched']]);
  assert.equal(results[0].sha256, hash('same'));
  const nothing = await fakeMake({ 'src/a.ts': 'same' }).client.writeDurableBatch([edit('src/a.ts', 'same', 'same')]);
  assert.equal(nothing[0].changed, false);
});

test('a wrong sha256 on any file refuses the whole batch before anything is backed up or written', async () => {
  for (const [items, message] of [
    [[edit('src/a.ts', 'a1', 'a0'), edit('src/b.ts', 'b1', 'not b0')], /SHA-256 does not match: src\/b\.ts/],
    [[edit('src/a.ts', 'a1', 'a0'), add('src/lib/c.ts', 'c')].map((item, i) => (i ? { ...item, expectedSha256: hash('x') } : item)), /forbidden for a new file: src\/lib\/c\.ts/],
    [[edit('src/a.ts', 'a1', 'a0'), { path: 'src/gone.ts', content: 'x', expectedSha256: hash('x') }], /required for an existing file and forbidden for a new file: src\/gone\.ts/],
    [[edit('src/a.ts', 'a1', 'a0'), remove('src/b.ts', 'other')], /missing or changed; delete refused: src\/b\.ts/],
    [[edit('src/a.ts', 'a1', 'a0'), remove('src/ghost.ts', 'x')], /missing or changed; delete refused: src\/ghost\.ts/],
  ]) {
    const { client, calls } = fakeMake({ 'src/a.ts': 'a0', 'src/b.ts': 'b0', 'src/lib/z.ts': 'z' });
    const error = await client.writeDurableBatch(items).catch(cause => cause);
    assert.match(error.message, message);
    assert.equal(error.batchWritesStarted, undefined);
    assert.equal(calls.some(call => ['write', 'delete', 'backup'].includes(call[0])), false, `nothing written or backed up for ${message}`);
  }
});

test('a client VFS that differs from the sandbox before the first write refuses the batch with nothing written', async () => {
  const { client, calls } = fakeMake({ 'src/a.ts': 'a0', 'src/b.ts': 'b0' }, { sandbox: { 'src/a.ts': 'a0', 'src/b.ts': 'other' } });
  client.timeoutMs = 300;
  client._operation = fn => fn(Date.now() + 300);
  const error = await client.writeDurableBatch([edit('src/a.ts', 'a1', 'a0'), edit('src/b.ts', 'b1', 'b0')]).catch(cause => cause);
  assert.match(error.message, /Make read-back for src\/b\.ts timed out before every view agreed/);
  assert.equal(calls.some(call => ['write', 'delete', 'backup'].includes(call[0])), false);
});

test('a new file below a missing top-level folder refuses the batch before any write', async () => {
  const { client, calls } = fakeMake({ 'src/a.ts': 'a0' });
  const error = await client.writeDurableBatch([edit('src/a.ts', 'a1', 'a0'), add('docs/readme.md', 'x')]).catch(cause => cause);
  assert.match(error.message, /cannot prove docs\/readme\.md absent/);
  assert.equal(calls.some(call => ['write', 'backup'].includes(call[0])), false);
  // A root-level file can be edited but never created or deleted by a batch, as for one file.
  const root = await fakeMake({ 'src/a.ts': 'a0' }).client.writeDurableBatch([add('NOTES.md', 'x')]).catch(cause => cause);
  assert.match(root.message, /cannot prove NOTES\.md absent/);
});

test('the page-side guard refuses a file that changed after the pre-check: the batch stops with a confirmed prefix', async () => {
  const { client, writes, vfs } = fakeMake({ 'src/a.ts': 'a0', 'src/b.ts': 'b0', 'src/c.ts': 'c0', 'src/d.ts': 'd0' }, { hooks: {
    // Make changes src/c.ts between the pre-check and its write.
    beforeWrite: (action, { vfs: files, sb }) => { if (action.path === 'src/b.ts') { files.set('src/c.ts', 'edited elsewhere'); sb.set('src/c.ts', 'edited elsewhere'); } },
  } });
  const error = await client.writeDurableBatch([edit('src/a.ts', 'a1', 'a0'), edit('src/b.ts', 'b1', 'b0'), edit('src/c.ts', 'c1', 'c0'), edit('src/d.ts', 'd1', 'd0')]).catch(cause => cause);
  assert.match(error.message, /Make refused the batch write at src\/c\.ts/);
  assert.equal(error.batchWritesStarted, true);
  assert.equal(error.batchTracker, undefined, 'a refusal is not a write to confirm by reading back, as for one file');
  assert.deepEqual(error.completedWrites.map(result => result.path), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(error.uncertainWrites, []);
  assert.equal(error.completedWrites[0].backupPath, '/private/backup/src/a.ts');
  assert.deepEqual(writes(), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.equal(vfs.get('src/c.ts'), 'edited elsewhere');
  assert.equal(vfs.get('src/d.ts'), 'd0');
});

test('a write that fails after the first write, with time left, leaves it and nothing later attempted: confirmed prefix, uncertain file', async () => {
  let seen = 0;
  const { client, writes } = fakeMake({ 'src/a.ts': 'a0', 'src/b.ts': 'b0', 'src/c.ts': 'c0', 'src/d.ts': 'd0' }, { hooks: {
    afterWrite: action => { if (action.path === 'src/b.ts' && ++seen) throw new Error('Make page connection closed.'); },
  } });
  const error = await client.writeDurableBatch([edit('src/a.ts', 'a1', 'a0'), edit('src/b.ts', 'b1', 'b0'), edit('src/c.ts', 'c1', 'c0'), edit('src/d.ts', 'd1', 'd0')]).catch(cause => cause);
  assert.match(error.message, /Make durable batch write outcome is uncertain: Make page connection closed/);
  assert.equal(error.batchWritesStarted, true);
  assert.deepEqual(error.completedWrites.map(result => result.path), ['src/a.ts']);
  assert.deepEqual(error.uncertainWrites.map(item => [item.path, item.backupPath, item.op]), [['src/b.ts', '/private/backup/src/b.ts', 'modify']]);
  assert.deepEqual(writes(), ['src/a.ts', 'src/b.ts'], 'nothing is retried and nothing after the failure is written');
  assert.equal(seen, 1);
});

test('a deadline that expires during the writes confirms nothing inside the operation: every accepted file is uncertain', async () => {
  const { client, writes } = fakeMake({ 'src/a.ts': 'a0', 'src/b.ts': 'b0', 'src/c.ts': 'c0' }, { hooks: {
    afterWrite: async action => { if (action.path === 'src/b.ts') { await new Promise(resolve => setTimeout(resolve, 60)); throw new Error('Make operation timed out.'); } },
  } });
  client._operation = fn => fn(Date.now() + 40);
  // As the real client: once the deadline has passed, no bridge can be opened to read anything back.
  client._fileBridge = async deadline => {
    if (Date.now() >= deadline) throw new Error('Make operation timed out.');
    return { dispose: async () => {} };
  };
  const error = await client.writeDurableBatch([edit('src/a.ts', 'a1', 'a0'), edit('src/b.ts', 'b1', 'b0'), edit('src/c.ts', 'c1', 'c0')]).catch(cause => cause);
  assert.equal(error.batchWritesStarted, true);
  assert.deepEqual(error.completedWrites, []);
  assert.deepEqual(error.uncertainWrites.map(item => item.path), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(writes(), ['src/a.ts', 'src/b.ts']);
  assert.ok(error.batchTracker.expectedPaths.includes('src/a.ts'));
  assert.equal(error.batchTracker.expectedPaths.includes('src/c.ts'), false, 'the tracker expectation covers only the files that may have landed');
  // The fresh read-only confirmation operation the caller then runs, with a new deadline.
  client._operation = fn => fn(Date.now() + 3000);
  const views = await client.confirmDurableBatch([{ path: 'src/a.ts', content: 'a1' }, { path: 'src/b.ts', content: 'b1' }], { tracker: error.batchTracker });
  assert.deepEqual(views.map(view => [view.path, view.confirmed]), [['src/a.ts', true], ['src/b.ts', true]]);
  assert.deepEqual(writes(), ['src/a.ts', 'src/b.ts'], 'confirming writes nothing');
});

test('confirmDurableBatch reads both views and reports what differs; a deleted file confirms by being absent', async () => {
  const { client, calls, vfs, sb } = fakeMake({ 'src/a.ts': 'a1', 'src/b.ts': 'b0', 'src/gone.ts': 'g0' });
  sb.set('src/a.ts', 'a1');
  vfs.delete('src/gone.ts');
  sb.delete('src/gone.ts');
  const views = await client.confirmDurableBatch([{ path: 'src/a.ts', content: 'a1' }, { path: 'src/b.ts', content: 'b1' }, { path: 'src/gone.ts', delete: true }]);
  assert.deepEqual(views.map(view => [view.path, view.vfs, view.sandbox, view.confirmed]),
    [['src/a.ts', 'matched', 'matched', true], ['src/b.ts', 'different', 'different', false], ['src/gone.ts', 'absent', 'absent', true]]);
  assert.equal(calls.some(call => ['write', 'delete', 'backup'].includes(call[0])), false);
  assert.throws(() => client.confirmDurableBatch([]), /1–25 files/);
});

test('confirmDurableBatch that had to wait for the tracker reads both views again and fails when one no longer holds its target', async () => {
  // src/a.ts was written to a1; Make lists it late, so the confirmation waits for the tracker.
  const run = async whileWaiting => {
    const { client, vfs, sb } = fakeMake({ 'src/a.ts': 'a0' });
    const before = (await client._driftState()).state;
    vfs.set('src/a.ts', 'a1');
    sb.set('src/a.ts', 'a1');
    const real = client._driftState;
    let polls = 0;
    client._driftState = async () => {
      const value = await real();
      if (++polls > 2) return value;
      whileWaiting({ vfs, sb });
      return { state: { ...value.state, pendingPaths: [], pendingCount: 0 } };
    };
    const outcome = await client.confirmDurableBatch([{ path: 'src/a.ts', content: 'a1' }], { tracker: { before, expectedPaths: ['src/a.ts'] } }).catch(cause => cause);
    return { outcome, polls };
  };
  const kept = await run(() => {});
  assert.ok(kept.polls > 2, 'the tracker was waited for');
  assert.deepEqual(kept.outcome.map(view => [view.path, view.confirmed]), [['src/a.ts', true]]);
  const sandboxMoved = await run(({ sb }) => sb.set('src/a.ts', 'rewritten by Make'));
  assert.equal(sandboxMoved.outcome.code, 'MAKE_CONTENT_CHANGED');
  const vfsMoved = await run(({ vfs }) => vfs.set('src/a.ts', 'rewritten by Make'));
  assert.equal(vfsMoved.outcome.code, 'MAKE_CONTENT_CHANGED');
});

test('a cleanup failure after a complete batch still carries every written file', async () => {
  const { client, vfs } = fakeMake({ 'src/a.ts': 'a0', 'src/b.ts': 'b0', 'src/c.ts': 'c0' });
  const run = client._operation;
  // What _operation does when Make's focus emulation cannot be switched off after the callback succeeded.
  client._operation = async fn => {
    await run(fn);
    throw new Error('Make operation completed. Temporary Make focus emulation could not be disabled: connection lost');
  };
  const error = await client.writeDurableBatch([edit('src/a.ts', 'a1', 'a0'), edit('src/b.ts', 'b1', 'b0'), edit('src/c.ts', 'c0', 'c0')]).catch(cause => cause);
  assert.match(error.message, /focus emulation could not be disabled/);
  assert.equal(error.batchWritesStarted, true);
  assert.deepEqual(error.completedWrites.map(result => [result.path, result.backupPath]), [['src/a.ts', '/private/backup/src/a.ts'], ['src/b.ts', '/private/backup/src/b.ts']]);
  assert.deepEqual(error.uncertainWrites, []);
  assert.equal(vfs.get('src/b.ts'), 'b1');
  // A refusal before the first write carries nothing.
  const refused = fakeMake({ 'src/a.ts': 'a0' });
  const before = refused.client._operation;
  refused.client._operation = async fn => { await before(fn).catch(() => {}); throw new Error('Make operation completed. Temporary Make focus emulation could not be disabled: x'); };
  const early = await refused.client.writeDurableBatch([edit('src/a.ts', 'a1', 'wrong')]).catch(cause => cause);
  assert.equal(early.batchWritesStarted, undefined);
});

test('a read-back that never agrees after the writes marks every unconfirmed file uncertain and keeps the ones that read back equal', async () => {
  const { client } = fakeMake({ 'src/a.ts': 'a0', 'src/b.ts': 'b0' }, { hooks: {
    // Make accepts both writes but its sandbox keeps showing the old bytes of src/b.ts.
    afterWrite: (action, { sb }) => { if (action.path === 'src/b.ts') sb.set('src/b.ts', 'b0'); },
  } });
  client._operation = async fn => fn(Date.now() + 400);
  const error = await client.writeDurableBatch([edit('src/a.ts', 'a1', 'a0'), edit('src/b.ts', 'b1', 'b0')]).catch(cause => cause);
  assert.match(error.message, /timed out before every view agreed/);
  assert.equal(error.batchWritesStarted, true);
  assert.equal(error.observed.find(view => view.path === 'src/b.ts').sandbox, 'different');
  assert.ok(error.uncertainWrites.some(item => item.path === 'src/b.ts'));
  assert.equal(error.completedWrites.some(result => result.path === 'src/b.ts'), false);
});

test('a tracker that never settles after confirmed writes keeps every write confirmed', async () => {
  const { client } = fakeMake({ 'src/a.ts': 'a0', 'src/b.ts': 'b0' });
  client._operation = async fn => fn(Date.now() + 300);
  const state = client._driftState;
  let calls = 0;
  client._driftState = async () => { const value = await state(); return ++calls < 3 ? value : { state: { ...value.state, pendingPaths: ['src/zzz.ts'], pendingCount: 1 } }; };
  const error = await client.writeDurableBatch([edit('src/a.ts', 'a1', 'a0'), edit('src/b.ts', 'b1', 'b0')]).catch(cause => cause);
  assert.ok(error.message);
  assert.equal(error.batchWritesStarted, true);
  assert.deepEqual(error.completedWrites.map(result => result.path), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(error.uncertainWrites, []);
});

test('Make settles once for the union: the tracker waits for every written path, and a wait re-checks both views', async () => {
  const { client, vfs, saved } = fakeMake({ 'src/a.ts': 'a0', 'src/b.ts': 'b0' });
  const real = client._driftState;
  let polls = 0;
  // Make lists the changed paths late: the first polls after the writes still show none of them.
  client._driftState = async () => {
    const value = await real();
    if (vfs.get('src/a.ts') === 'a1' && ++polls <= 3) return { state: { ...value.state, pendingPaths: [], pendingCount: 0 } };
    return value;
  };
  const results = await client.writeDurableBatch([edit('src/a.ts', 'a1', 'a0'), edit('src/b.ts', 'b1', 'b0')]);
  assert.ok(polls > 3);
  assert.equal(results.length, 2);
  assert.notEqual(saved.get('src/a.ts'), vfs.get('src/a.ts'));
});

test('the tracker expects a file written back to its saved content to leave the pending list', async () => {
  const { client, vfs, sb } = fakeMake({ 'src/a.ts': 'saved', 'src/b.ts': 'b0' });
  vfs.set('src/a.ts', 'edited');
  sb.set('src/a.ts', 'edited');
  const results = await client.writeDurableBatch([edit('src/a.ts', 'saved', 'edited'), edit('src/b.ts', 'b1', 'b0')]);
  assert.equal(results[0].changed, true);
  assert.equal(vfs.get('src/a.ts'), 'saved');
});

test('a hidden file is verified by the client VFS and the sandbox alone, a release asset by its own rule', async () => {
  const { client } = fakeMake({ 'src/a.ts': 'a0', 'src/.keep': 'k0', 'public/atomicaui/latest.json': 'l0' });
  const results = await client.writeDurableBatch([edit('src/.keep', 'k1', 'k0'), edit('src/a.ts', 'a1', 'a0'),
    { ...edit('public/atomicaui/latest.json', 'l1', 'l0'), releaseAsset: true }, { path: 'public/atomicaui/7.0.1/x.json', content: '{}', releaseAsset: true }]);
  assert.deepEqual(results.map(result => result.verification), ['vfs-sandbox-matched', 'tree-vfs-sandbox-matched', 'tree-vfs-sandbox-release-matched', 'tree-vfs-sandbox-release-matched']);
  assert.throws(() => fakeMake({ 'src/a.ts': 'a0' }).client.writeDurableBatch([{ ...edit('src/a.ts', 'a1', 'a0'), releaseAsset: true }]), /limited to public\/atomicaui/);
});

test('the editor is only a bonus view: a mounted file must match, and is never selected', async () => {
  const mounted = fakeMake({ 'src/a.ts': 'a0', 'src/b.ts': 'b0' });
  const actions = [];
  mounted.client._editor = async action => { actions.push(action.type); return action.type === 'inspect' ? { editorCount: 1, editorPath: 'src/b.ts' } : { content: mounted.vfs.get('src/b.ts') }; };
  mounted.client._select = mounted.client._read = async () => { throw new Error('a batch must not select a file in the editor'); };
  const results = await mounted.client.writeDurableBatch([edit('src/a.ts', 'a1', 'a0'), edit('src/b.ts', 'b1', 'b0')]);
  assert.deepEqual(results.map(result => result.verification), ['tree-vfs-sandbox-matched', 'editor-tree-vfs-sandbox-matched']);
  assert.deepEqual([...new Set(actions)].sort(), ['inspect', 'read-mounted']);
  // An editor buffer that already differs from the client VFS refuses the batch before any write, as for one file.
  const stale = fakeMake({ 'src/a.ts': 'a0', 'src/b.ts': 'b0' });
  stale.client._operation = fn => fn(Date.now() + 300);
  stale.client._editor = async action => (action.type === 'inspect' ? { editorCount: 1, editorPath: 'src/a.ts' } : { content: 'stale buffer' });
  const error = await stale.client.writeDurableBatch([edit('src/b.ts', 'b1', 'b0'), edit('src/a.ts', 'a1', 'a0')]).catch(cause => cause);
  assert.match(error.message, /timed out before every view agreed.*editor different/);
  assert.equal(error.batchWritesStarted, undefined);
  assert.deepEqual(stale.writes(), [], 'nothing was written');
  assert.equal(stale.calls.some(call => call[0] === 'backup'), false);
  // The same holds for a delete of the mounted file, and a file whose buffer differs only by line endings is accepted.
  const doomed = fakeMake({ 'src/a.ts': 'a0' });
  doomed.client._operation = fn => fn(Date.now() + 300);
  doomed.client._editor = async action => (action.type === 'inspect' ? { editorCount: 1, editorPath: 'src/a.ts' } : { content: 'stale buffer' });
  assert.match((await doomed.client.writeDurableBatch([remove('src/a.ts', 'a0')]).catch(cause => cause)).message, /editor different/);
  assert.deepEqual(doomed.writes(), []);
  const crlf = fakeMake({ 'src/a.ts': 'a\r\nb' });
  crlf.client._editor = async action => (action.type === 'inspect' ? { editorCount: 1, editorPath: 'src/a.ts' } : { content: crlf.vfs.get('src/a.ts').replace(/\r\n/g, '\n') });
  assert.equal((await crlf.client.writeDurableBatch([edit('src/a.ts', 'c', 'a\r\nb')]))[0].changed, true);
  // A buffer that goes stale after the writes still keeps the batch from confirming.
  const late = fakeMake({ 'src/a.ts': 'a0' });
  late.client._operation = fn => fn(Date.now() + 300);
  late.client._editor = async action => (action.type === 'inspect' ? { editorCount: 1, editorPath: 'src/a.ts' }
    : { content: late.vfs.get('src/a.ts') === 'a0' ? 'a0' : 'stale buffer' });
  const after = await late.client.writeDurableBatch([edit('src/a.ts', 'a1', 'a0')]).catch(cause => cause);
  assert.match(after.message, /timed out before every view agreed/);
  assert.equal(after.batchWritesStarted, true);
});

test('dependency files and VENDOR.json never travel in a batch, and nothing is read or written for one', async () => {
  for (const path of ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'src/vendor/atomic-aui/VENDOR.json', 'VENDOR.json']) {
    assert.equal(batchBarred(path), true, path);
    const { client, calls } = fakeMake({ [path]: 'x', 'src/a.ts': 'a0' });
    assert.throws(() => client.writeDurableBatch([edit('src/a.ts', 'a1', 'a0'), edit(path, 'y', 'x')]), /never holds .*one at a time/);
    assert.equal(calls.length, 0);
  }
  for (const path of ['src/package.json', 'src/vendor/atomic-aui/tokens/a.scss', 'public/atomicaui/7.0.0/manifest.json']) assert.equal(batchBarred(path), false, path);
});

test('a batch refuses an empty list, more than 25 files, a duplicate path, a bad hash and a delete with content', () => {
  const { client } = fakeMake({ 'src/a.ts': 'a0' });
  assert.throws(() => client.writeDurableBatch([]), /1–25 files/);
  assert.throws(() => client.writeDurableBatch(Array.from({ length: MAX_BATCH_FILES + 1 }, (_, i) => add(`src/n${i}.ts`, 'x'))), /1–25 files/);
  assert.throws(() => client.writeDurableBatch([add('src/n.ts', 'x'), add('src/n.ts', 'y')]), /lists src\/n\.ts twice/);
  assert.throws(() => client.writeDurableBatch([{ path: 'src/a.ts', content: 'x', expectedSha256: 'abc' }]), /Invalid expected SHA-256/);
  assert.throws(() => client.writeDurableBatch([{ path: 'src/a.ts', delete: true, content: 'x', expectedSha256: hash('a0') }]), /carries no content/);
  assert.throws(() => client.writeDurableBatch([{ path: 'src/a.ts', delete: true }]), /requires expected SHA-256/);
  assert.throws(() => client.writeDurableBatch([{ path: '../a.ts', content: 'x' }]));
  assert.throws(() => client.writeDurableBatch([add('src/a.ts', 'x'.repeat(MAX_BATCH_BYTES)), add('src/b.ts', 'y')]), /at most/);
  assert.equal(MAX_BATCH_FILES, 25);
});

test('chunking: at most 25 files and 8 MiB, order kept, an oversized file alone', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ path: `src/f${i}.ts`, content: 'x' }));
  const chunks = chunkBatch(items);
  assert.deepEqual(chunks.map(chunk => chunk.length), [25, 25, 10]);
  assert.deepEqual(chunks.flat(), items);
  assert.deepEqual(chunkBatch([]), []);
  const big = 'x'.repeat(5 * 1024 * 1024);
  assert.deepEqual(chunkBatch([{ content: big }, { content: big }, { content: 'a' }, { content: 'b' }]).map(chunk => chunk.length), [1, 3]);
  assert.deepEqual(chunkBatch([{ content: 'x'.repeat(MAX_BATCH_BYTES + 1) }, { content: 'a' }]).map(chunk => chunk.length), [1, 1]);
});

test('writeInOrder cuts a run at a barred file and keeps every file at its own position', async () => {
  const items = ['a', 'b', 'package.json', 'c', 'd', 'e', 'VENDOR.json'].map(name => ({ path: name, content: name }));
  const order = [];
  await writeInOrder(items, {
    batchable: item => !batchBarred(item.path),
    batch: chunk => order.push(['batch', chunk.map(item => item.path)]),
    single: item => order.push(['single', item.path]),
  });
  assert.deepEqual(order, [['batch', ['a', 'b']], ['single', 'package.json'], ['batch', ['c', 'd', 'e']], ['single', 'VENDOR.json']]);
  const many = Array.from({ length: 52 }, (_, i) => ({ path: `src/f${i}.ts`, content: 'x' }));
  const sizes = [];
  await writeInOrder(many, { batchable: () => true, batch: chunk => sizes.push(chunk.length), single: () => {} });
  assert.deepEqual(sizes, [25, 25, 2]);
});

// checkChangedTree: the tree after a batch must differ from the tree before it by exactly the expected paths.
test('the tree check accepts exactly the expected adds, removes and untouched edits, and nothing else', () => {
  const before = render(['src/a.ts', 'src/b.ts', 'src/old/x.ts', 'src/lib/y.ts']);
  const change = { beforeEntries: before.entries, beforeRows: before.rows };
  const check = (afterPaths, extra) => checkChangedTree({ ...change, ...extra }, ...Object.values(render(afterPaths)));
  // edit only
  check(['src/a.ts', 'src/b.ts', 'src/old/x.ts', 'src/lib/y.ts'], { writtenPaths: [], removedPaths: [] });
  // adds (new folder chain), a remove that empties its folder, an edit
  check(['src/a.ts', 'src/b.ts', 'src/lib/y.ts', 'src/new/deep/z.ts', 'src/lib/w.ts'],
    { writtenPaths: ['src/new/deep/z.ts', 'src/lib/w.ts'], removedPaths: ['src/old/x.ts'] });
  // the emptied folder may also still be shown
  check(['src/a.ts', 'src/b.ts', 'src/old/x.ts', 'src/lib/y.ts'], { writtenPaths: [], removedPaths: ['src/old/x.ts'] });
  // delete and write in the same folder
  check(['src/a.ts', 'src/b.ts', 'src/old/q.ts', 'src/lib/y.ts'], { writtenPaths: ['src/old/q.ts'], removedPaths: ['src/old/x.ts'] });
  const refuses = (afterPaths, extra, message) => assert.throws(() => check(afterPaths, extra), /Make file tree changed before the requested action/, message);
  refuses(['src/a.ts', 'src/b.ts', 'src/old/x.ts', 'src/lib/y.ts', 'src/stray.ts'], { writtenPaths: [], removedPaths: [] }, 'an unexpected extra entry');
  refuses(['src/a.ts', 'src/old/x.ts', 'src/lib/y.ts'], { writtenPaths: [], removedPaths: [] }, 'an unexpected missing entry');
  refuses(['src/a.ts', 'src/b.ts', 'src/lib/y.ts'], { writtenPaths: [], removedPaths: ['src/b.ts', 'src/old/x.ts', 'src/a.ts'].slice(0, 1) }, 'an unexpected removal: x.ts disappears without being removed');
  refuses(['src/a.ts', 'src/b.ts', 'src/old/x.ts', 'src/lib/y.ts', 'src/lib/w.ts', 'src/stray.ts'], { writtenPaths: ['src/lib/w.ts'], removedPaths: [] }, 'an extra next to an expected add');
  refuses(['src/a.ts', 'src/b.ts', 'src/old/x.ts', 'src/lib/y.ts', 'src/lib/w.ts'], { writtenPaths: ['src/lib/w.ts', 'src/lib/w.ts'] }, 'a path listed twice');
  refuses(['src/a.ts', 'src/b.ts', 'src/old/x.ts', 'src/lib/y.ts'], { writtenPaths: ['src/a.ts'], removedPaths: [] }, 'a written path that already existed');
  refuses(['src/a.ts', 'src/b.ts', 'src/old/x.ts', 'src/lib/y.ts'], { writtenPaths: [], removedPaths: ['src/ghost.ts'] }, 'a removed path that was not there');
  assert.throws(() => checkChangedTree({ ...change }, ...Object.values(render([]))), /Make file tree changed/);
  assert.throws(() => checkChangedTree({ beforeEntries: undefined, beforeRows: undefined, writtenPaths: [] }, [], []), /Make file tree changed/);
});

test('the tree check still compares every other entry by kind, level and row height', () => {
  const before = render(['src/a.ts', 'src/b.ts', 'src/lib/y.ts']);
  const change = { beforeEntries: before.entries, beforeRows: before.rows, writtenPaths: ['src/lib/w.ts'], removedPaths: [] };
  const after = render(['src/a.ts', 'src/b.ts', 'src/lib/y.ts', 'src/lib/w.ts']);
  checkChangedTree(change, after.entries, after.rows);
  const bump = patch => {
    const entries = after.entries.map(entry => (entry.path === 'src/b.ts' && patch.level ? { ...entry, level: patch.level } : entry));
    const rows = after.rows.map(row => (row.top === after.entries.find(entry => entry.path === 'src/b.ts').top && patch.height ? { ...row, height: patch.height } : row));
    return [entries, rows];
  };
  assert.throws(() => checkChangedTree(change, ...bump({ level: 4 })), /Make file tree changed/);
  assert.throws(() => checkChangedTree(change, ...bump({ height: 64 })), /Make file tree changed/);
  const asFolder = after.entries.map(entry => (entry.path === 'src/b.ts' ? { ...entry, kind: 'folder' } : entry));
  assert.throws(() => checkChangedTree(change, asFolder, after.rows), /Make file tree changed/);
  const noHeight = { ...change, beforeRows: before.rows.map(row => ({ ...row, height: undefined })) };
  assert.throws(() => checkChangedTree(noHeight, after.entries, after.rows), /Make file tree changed/);
  // The single-file forms keep their meaning.
  const single = render(['src/a.ts', 'src/b.ts']);
  checkChangedTree({ beforeEntries: before.entries, beforeRows: before.rows, removedPath: 'src/lib/y.ts' }, single.entries, single.rows);
  checkChangedTree({ beforeEntries: single.entries, beforeRows: single.rows, writtenPath: 'src/lib/y.ts' }, before.entries, before.rows);
  assert.throws(() => checkChangedTree({ beforeEntries: before.entries, beforeRows: before.rows, removedPath: 'src/a.ts' }, single.entries, single.rows), /Make file tree changed/);
});

test('a batch fails when the tree after it shows an unexpected entry, a missing one or a changed row', async () => {
  const run = async hooks => {
    const { client } = fakeMake({ 'src/a.ts': 'a0', 'src/b.ts': 'b0' }, { hooks });
    return client.writeDurableBatch([edit('src/a.ts', 'a1', 'a0'), add('src/lib/n.ts', 'n')]).catch(cause => cause);
  };
  let after = false;
  const extra = await run({ afterWrite: () => { after = true; }, tree: paths => (after ? [...paths, 'src/stray.ts'] : paths) });
  assert.match(extra.message, /Make file tree changed before the requested action/);
  assert.equal(extra.batchWritesStarted, true);
  // With time left the batch reads its own writes back: every file is confirmed, none uncertain, and the
  // tracker expectation for the follow-up confirmation covers them all.
  assert.deepEqual(extra.completedWrites.map(result => result.path), ['src/a.ts', 'src/lib/n.ts']);
  assert.deepEqual(extra.uncertainWrites, []);
  assert.deepEqual(extra.batchTracker.expectedPaths, ['src/a.ts', 'src/lib/n.ts']);
  after = false;
  const missing = await run({ afterWrite: () => { after = true; }, tree: paths => (after ? paths.filter(path => path !== 'src/b.ts') : paths) });
  assert.match(missing.message, /Make file tree changed before the requested action/);
  after = false;
  const taller = await run({ afterWrite: () => { after = true; }, rows: (entries, rows) => ({ entries, rows: after ? rows.map(row => (row.top === 64 ? { ...row, height: 64 } : row)) : rows }) });
  assert.match(taller.message, /Make file tree changed before the requested action/);
  // And the exact expected change passes.
  assert.equal((await run({})).length, 2);
});

test('a batch whose first write is never attempted because the drift check changed reports no write started', async () => {
  const { client, calls } = fakeMake({ 'src/a.ts': 'a0' });
  const real = client._driftState;
  let polls = 0;
  client._driftState = async () => { const value = await real(); return ++polls < 2 ? value : { state: { ...value.state, pendingPaths: ['src/other.ts'], pendingCount: 1 } }; };
  const error = await client.writeDurableBatch([edit('src/a.ts', 'a1', 'a0')]).catch(cause => cause);
  assert.equal(error.code, 'MAKE_PENDING_CHANGED');
  assert.equal(error.batchWritesStarted, undefined);
  assert.equal(calls.some(call => call[0] === 'write'), false);
});
