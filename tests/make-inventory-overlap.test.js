import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MakeClient } from '../src/make-client.js';

const state = { mode: 'git', hasBaseline: true, savedVersion: 'a'.repeat(40), pendingCount: 0, pendingPaths: [], isLoading: false, error: false };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// A Make project as a map folder -> entries, files with content. 5 top folders,
// 4 files each plus root files and a .gitignore in two folders: more than one
// 24-request batch and more than eight files per folder level.
function project() {
  const folders = new Map([['', []]]);
  const content = new Map();
  const add = (folder, name, text) => {
    folders.get(folder).push({ name, isDirectory: false, size: Buffer.byteLength(text) });
    content.set(folder ? `${folder}/${name}` : name, Buffer.from(text));
  };
  const dir = (parent, name) => {
    const path = parent ? `${parent}/${name}` : name;
    folders.get(parent).push({ name, isDirectory: true, size: 0 });
    folders.set(path, []);
    return path;
  };
  add('', 'package.json', '{}\n');
  add('', '.gitignore', 'dist\n*.log\n');
  const src = dir('', 'src');
  for (let i = 0; i < 5; i++) {
    const folder = dir(src, `part${i}`);
    for (let j = 0; j < 4; j++) add(folder, `file${j}.ts`, `export const v${i}${j} = ${i * 10 + j};\n`);
    if (i === 2) add(folder, '.gitignore', '*.tmp\n');
    if (i === 2) add(folder, 'skip.tmp', 'ignored\n');
  }
  const dist = dir('', 'dist');
  add(dist, 'bundle.js', 'ignored by the root .gitignore\n');
  return { folders, content };
}

// The order a one-at-a-time walk records files in (queue: folders first, files after).
function sequentialOrder({ folders }, { skip = () => false } = {}) {
  const directories = [''];
  const files = [];
  while (directories.length) {
    const directory = directories.shift();
    for (const entry of folders.get(directory)) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (skip(path)) continue;
      if (entry.isDirectory) directories.push(path); else files.push(path);
    }
  }
  return files;
}

// Enforces what the real client does: one operation at a time on a client, one
// request at a time per bridge is NOT enforced (Make answers side by side).
function fake(tree, { fail = {}, refuse = [], closeAt = [], closeError = 'Error: Make filesystem socket closed; outcome is unknown.' } = {}) {
  const closes = new Set([].concat(closeAt));
  const c = new MakeClient({ transport: { close() {}, send: async () => ({}) }, timeoutMs: 20000 });
  c.fileKey = 'ScratchKey';
  const log = { requests: [], operations: [], peak: 0, active: 0, driftStates: 0, disposed: 0, activeAtDispose: [] };
  let running = false;
  let requestNumber = 0;
  c._operation = async fn => {
    assert.equal(running, false, 'a second operation started while one was running');
    running = true;
    log.operations.push(log.requests.length);
    try { return await fn(Date.now() + 20000); } finally { running = false; }
  };
  c._driftState = async () => { log.driftStates++; return { state }; };
  c._evaluate = async () => ({ ambiguous: false, generationInProgress: false, aiTurns: 0, latest: null });
  c._fileBridge = async () => ({
    dispose: async () => { log.disposed++; log.activeAtDispose.push(log.active); },
    invoke: async (_fn, [type, data]) => {
      assert.equal(running, true, 'a request was sent outside an operation');
      assert.ok(['fs/dir/list', 'fs/file/read'].includes(type), 'an inventory never writes');
      const number = ++requestNumber;
      log.requests.push(`${type} ${data.path}`);
      log.peak = Math.max(log.peak, ++log.active);
      // Later requests of a wave answer first, so order must come from the queue.
      await new Promise(resolve => setTimeout(resolve, 1 + (number % 3)));
      log.active--;
      if (closes.has(number)) throw new Error(closeError);
      if (fail[data.path]) throw new Error(fail[data.path]);
      if (refuse.includes(data.path)) return { success: false };
      const path = data.path.replace(/^code\/?/, '');
      if (type === 'fs/dir/list') {
        return { success: true, data: { path: data.path, files: tree.folders.get(path).map(entry => ({
          name: entry.name, path: entry.name, isDirectory: entry.isDirectory, isFile: !entry.isDirectory, size: entry.size })) } };
      }
      return { success: true, data: { path: data.path, encoding: 'base64', content: tree.content.get(path).toString('base64') } };
    },
  });
  return { c, log, closes };
}

// The real status read over the real inventory; only the sandbox git reader is replaced.
function statusClient(options) {
  const made = fake(project(), options);
  made.gitReads = 0;
  made.c._sandboxGit = () => {
    made.gitReads++;
    return { head: async () => 'b'.repeat(40), commitTree: async () => 'c'.repeat(40), flatten: async () => new Map(), readFile: async () => null };
  };
  return made;
}

test('the project inventory overlaps eight requests, keeps queue order and the same requests', async () => {
  const tree = project();
  const { c, log } = fake(tree);
  const result = await c.inventoryProject({ includeBytes: true });
  const expected = sequentialOrder(tree, { skip: path => path === 'dist' || path === 'src/part2/skip.tmp' });
  assert.deepEqual([...result.inventory.keys()], expected);
  for (const [path, entry] of result.inventory) assert.equal(entry.sha256, sha(tree.content.get(path)));
  assert.deepEqual(result.excluded, ['dist/', 'src/part2/skip.tmp']);
  assert.equal(log.peak, 8, 'eight in flight, no more');
  // Every kept file once, every listed folder once, and each .gitignore a second time for its rules.
  const listed = [...tree.folders.keys()].filter(path => path !== 'dist').map(path => `fs/dir/list code${path ? `/${path}` : ''}`);
  const read = [...expected, '.gitignore', 'src/part2/.gitignore'].map(path => `fs/file/read code/${path}`);
  assert.deepEqual([...log.requests].sort(), [...listed, ...read].sort());
  assert.ok(log.activeAtDispose.every(active => active === 0), 'the bridge is released after its requests settled');
  // A drift-state bracket before and after every operation, and at most 24 requests in each.
  assert.equal(log.driftStates, log.operations.length * 2);
  const bounds = [...log.operations, log.requests.length];
  for (let i = 0; i < log.operations.length; i++) assert.ok(bounds[i + 1] - bounds[i] <= 24 + 2, 'batch bound');
  assert.equal(result.batches, 2, '7 listed folders and 23 kept files, 24 to a batch');
});

test('the vendor inventory overlaps eight requests and keeps queue order', async () => {
  const tree = project();
  const { c, log } = fake(tree);
  const result = await c.inventoryVendor('src', { includeBytes: true });
  const expected = sequentialOrder({ folders: new Map([...tree.folders].filter(([p]) => p === 'src' || p.startsWith('src/'))
    .map(([p, entries]) => [p === 'src' ? '' : p.slice(4), entries])) }, {});
  assert.deepEqual([...result.inventory.keys()], expected.map(path => path));
  assert.equal(log.peak, 8);
  assert.equal(result.contents.size, result.inventory.size);
  assert.equal(log.driftStates, log.operations.length * 2);
  assert.ok(log.activeAtDispose.every(active => active === 0));
});

test('a failed request raises the error a one-at-a-time walk would, after the others settled', async () => {
  const tree = project();
  const { c, log } = fake(tree, { fail: { 'code/src/part1/file0.ts': 'read failed: part1', 'code/src/part3/file0.ts': 'read failed: part3' } });
  await assert.rejects(c.inventoryProject(), /read failed: part1/);
  assert.ok(log.activeAtDispose.every(active => active === 0));
  assert.equal(log.disposed, log.operations.length);
});

test('a refused reply or a changed size raises before a later request failure of the same wave', async () => {
  // One at a time, the earlier item of the queue fails first and the later one is never requested.
  const refused = fake(project(), { refuse: ['code/src/part1'], fail: { 'code/src/part3': 'Make filesystem request timed out; outcome is unknown.' } });
  await assert.rejects(refused.c.inventoryVendor('src'), /Make directory listing is unavailable: src\/part1/);
  const refusedProject = fake(project(), { refuse: ['code/src/part1'], fail: { 'code/src/part3': 'Make filesystem request timed out; outcome is unknown.' } });
  await assert.rejects(refusedProject.c.inventoryProject(), /Make directory listing is unavailable: src\/part1/);
  for (const read of [c => c.inventoryProject(), c => c.inventoryVendor('src')]) {
    const tree = project();
    tree.folders.get('src/part0').find(entry => entry.name === 'file0.ts').size += 1;
    const { c } = fake(tree, { fail: { 'code/src/part0/file2.ts': 'read failed: later' } });
    await assert.rejects(read(c), /Make file changed during inventory: src\/part0\/file0\.ts/);
  }
});

test('the entry limit still stops an inventory', async () => {
  const { c } = fake(project());
  c.maxEntries = 10;
  await assert.rejects(c.inventoryProject(), /exceeds the entry limit/);
  await assert.rejects(c.inventoryVendor('src'), /exceeds the entry limit/);
});

test('a read-only inventory is taken again once when the filesystem socket closes under it', async () => {
  const tree = project();
  const { c, log } = fake(tree, { closeAt: 12 });
  const result = await c.inventoryProject();
  assert.equal(result.inventory.size, sequentialOrder(tree, { skip: path => path === 'dist' || path === 'src/part2/skip.tmp' }).length);
  assert.ok(log.operations.length >= 3, 'the retry ran in new operations');
  assert.ok(log.requests.length > result.inventory.size, 'the first attempt had already sent requests');
  const vendor = fake(tree, { closeAt: 6 });
  assert.equal((await vendor.c.inventoryVendor('src')).inventory.size, 22);
});

test('a request refused because the socket had just closed is retried once; a lost connection for another cause is not', async () => {
  const unsent = 'Error: Make filesystem socket closed before the request was sent.';
  const tree = project();
  const once = fake(tree, { closeAt: 12, closeError: unsent });
  assert.equal((await once.c.inventoryProject()).inventory.size, 23);
  const twice = fake(tree, { fail: { 'code/src': unsent } });
  await assert.rejects(twice.c.inventoryProject(), /socket closed before the request was sent/);
  assert.equal(twice.log.requests.filter(request => request === 'fs/dir/list code/src').length, 2, 'one retry');
  const other = fake(tree, { fail: { 'code/src': 'Error: Make filesystem connection is unavailable.' } });
  await assert.rejects(other.c.inventoryProject(), /connection is unavailable/);
  assert.equal(other.log.requests.filter(request => request === 'fs/dir/list code/src').length, 1, 'not retried');
});

test('a status read whose socket closes twice is raised after one retry of the whole read', async () => {
  const fail = { 'code/src': 'Error: Make filesystem socket closed; outcome is unknown.' };
  const made = statusClient({ fail });
  const { c, log, closes } = made;
  await assert.rejects(c.projectStatus(), /socket closed/);
  assert.equal(made.gitReads, 2, 'the whole status read ran twice');
  assert.equal(log.requests.filter(request => request === 'fs/dir/list code/src').length, 2, 'the inventory ran twice, not four times');
  // The next read on the same client gets its own single retry.
  delete fail['code/src'];
  closes.add(log.requests.length + 3);
  assert.equal((await c.inventoryProject()).inventory.size, 23);
});

test('a status read whose socket closes once is taken again in whole', async () => {
  const made = statusClient({ closeAt: 5 });
  const status = await made.c.projectStatus();
  assert.equal(status.fileCount, 23);
  assert.equal(made.gitReads, 2, 'the git-object read ran again with the inventory');
  assert.equal(made.log.requests.filter(request => request === 'fs/dir/list code').length, 2);
  made.closes.add(made.log.requests.length + 3);
  assert.equal((await made.c.projectStatus()).fileCount, 23, 'a later status read is retried once as well');
});

test('a socket that closes twice, or any other error, is not retried more than once', async () => {
  const { c, log } = fake(project(), { fail: { 'code/src': 'Error: Make filesystem socket closed; outcome is unknown.' } });
  await assert.rejects(c.inventoryProject(), /socket closed/);
  assert.equal(log.requests.filter(request => request === 'fs/dir/list code/src').length, 2, 'one retry');
  const other = fake(project(), { fail: { 'code/src': 'Make filesystem request timed out; outcome is unknown.' } });
  await assert.rejects(other.c.inventoryProject(), /timed out/);
  assert.equal(other.log.requests.filter(request => request === 'fs/dir/list code/src').length, 1, 'a timeout is not retried');
});

test('a status read goes through the same retry, and a write does not', async () => {
  const c = new MakeClient({ transport: { close() {} }, timeoutMs: 1000 });
  let attempts = 0;
  c._projectStatus = async () => { if (++attempts === 1) throw new Error('Make filesystem socket closed; outcome is unknown.'); return { ok: true }; };
  assert.deepEqual(await c.projectStatus(), { ok: true });
  assert.equal(attempts, 2);
  const writes = new MakeClient({ transport: { close() {} }, timeoutMs: 1000 });
  writes.fileKey = 'ScratchKey';
  let writeAttempts = 0;
  writes._operation = async () => { writeAttempts++; throw new Error('Make filesystem socket closed; outcome is unknown.'); };
  await assert.rejects(writes.writeDurable('src/a.ts', 'x', { expectedSha256: sha('y') }), /Make filesystem socket closed/);
  assert.equal(writeAttempts, 1, 'a write is never taken again');
});
