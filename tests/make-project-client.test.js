import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MakeClient } from '../src/make-client.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Figma Make', GIT_AUTHOR_EMAIL: 'make@example.invalid',
    GIT_COMMITTER_NAME: 'Figma Make', GIT_COMMITTER_EMAIL: 'make@example.invalid' } }).trim();
const clean = sha => ({ mode: 'git', hasBaseline: true, savedVersion: sha, pendingCount: 0, pendingPaths: [], isLoading: false, error: false });

// A Make sandbox as a local folder: a git repository whose template files are
// executable, a .git/info/exclude, ignored output and the Make registry config.
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'figma-cli-make-project-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  const files = {
    '.figma/make/dev': '#!/bin/sh\n', '.gitignore': 'node_modules\ndist\n*.log\n', 'package.json': '{}\n',
    'src/App.tsx': 'export default 1;\n', '.figma-cli/project.json': JSON.stringify({ fileKey: 'ExactKey', repo: 'owner/proto' }),
    '.gitattributes': '*.png filter=lfs\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
    if (path !== '.figma-cli/project.json') chmodSync(join(dir, path), 0o755); // Make's template mode
  }
  writeFileSync(join(dir, '.git/info/exclude'), '/.npmrc\n/.figma/design-context/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fs write: 1');
  // Untracked, excluded content that must never be read.
  for (const [path, content] of Object.entries({ '.npmrc': '//registry/:_authToken=secret\n', 'node_modules/x/index.js': 'x',
    'dist/app.js': 'd', 'debug.log': 'l', '.figma/design-context/ctx.json': '{}' })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function client(dir, { state, hangOnMissing = true } = {}) {
  const c = new MakeClient({ transport: { close() {}, send: async () => ({}) }, timeoutMs: 20000 });
  c.fileKey = 'ExactKey';
  const calls = [];
  c._operation = async fn => fn(Date.now() + 20000);
  c._driftState = async () => ({ state });
  c._evaluate = async () => ({ ambiguous: false, generationInProgress: false, aiTurns: 0, latest: null });
  c._fileBridge = async () => ({ dispose: async () => {}, invoke: async (_fn, [type, data]) => {
    calls.push({ type, path: data.path });
    assert.ok(['fs/dir/list', 'fs/file/read'].includes(type), 'status never writes');
    const local = join(dir, data.path.replace(/^code\/?/, ''));
    if (!existsSync(local)) {
      // Make never answers a listing of a missing folder.
      if (hangOnMissing) throw new Error('Make filesystem request timed out; outcome is unknown.');
      return { success: false };
    }
    if (type === 'fs/dir/list') {
      const files = readdirSync(local).filter(name => !(data.path === 'code' && name === '.git')).map(name => {
        const isDirectory = statSync(join(local, name)).isDirectory();
        return { name, path: name, isDirectory, isFile: !isDirectory, type: isDirectory ? 2 : 1, size: isDirectory ? 4096 : statSync(join(local, name)).size };
      });
      return { success: true, data: { path: data.path, files } };
    }
    return { success: true, data: { path: data.path, encoding: 'base64', content: readFileSync(local).toString('base64') } };
  } });
  return { c, calls };
}

test('project status hashes the saved tree from sandbox git objects, with exact modes, and reads no excluded file', async t => {
  const dir = sandbox(t);
  const head = git(dir, 'rev-parse', 'HEAD');
  const { c, calls } = client(dir, { state: clean(head) });
  const result = await c.projectStatus();
  const tree = git(dir, 'rev-parse', 'HEAD^{tree}');
  assert.equal(result.makeTree, tree);
  assert.equal(result.treeSource, 'saved-version');
  assert.equal(result.workingTree, tree, 'unchanged files keep their 100755 mode');
  assert.equal(result.head, head);
  assert.equal(result.fileCount, 6);
  assert.deepEqual(result.excluded, ['.figma/design-context/', '.npmrc', 'debug.log', 'dist/', 'node_modules/']);
  assert.equal(result.excludeSource, '.git/info/exclude');
  assert.ok(JSON.parse(result.markerBytes).repo === 'owner/proto');
  const read = calls.filter(call => call.type === 'fs/file/read').map(call => call.path);
  for (const secret of ['code/.npmrc', 'code/node_modules/x/index.js', 'code/dist/app.js', 'code/debug.log']) {
    assert.ok(!read.includes(secret), `${secret} was read`);
  }
  assert.ok(calls.some(call => call.type === 'fs/dir/list' && call.path === 'code'), 'the project root is listed');
});

test('an edited file takes mode 100644 in the working tree, matching a Make commit of it', async t => {
  const dir = sandbox(t);
  const head = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'package.json'), '{"edited":true}\n');
  const { c } = client(dir, { state: { ...clean(head), pendingCount: 1, pendingPaths: ['package.json'] } });
  const result = await c.projectStatus();
  assert.equal(result.makeTree, git(dir, 'rev-parse', 'HEAD^{tree}'));
  chmodSync(join(dir, 'package.json'), 0o644);
  git(dir, 'add', '-A');
  assert.equal(result.workingTree, git(dir, 'write-tree'));
});

test('without a saved baseline the sandbox HEAD tree is used, and packed objects are read', async t => {
  const dir = sandbox(t);
  git(dir, 'repack', '-adq');
  git(dir, 'prune-packed');
  git(dir, 'pack-refs', '--all');
  const { c } = client(dir, { state: { ...clean(null), hasBaseline: false, savedVersion: null } });
  const result = await c.projectStatus();
  assert.equal(result.treeSource, 'sandbox-head');
  assert.equal(result.makeTree, git(dir, 'rev-parse', 'HEAD^{tree}'));
});

test('a state change while reading the sandbox git objects fails the status', async t => {
  const dir = sandbox(t);
  const head = git(dir, 'rev-parse', 'HEAD');
  const { c } = client(dir, { state: clean(head) });
  let reads = 0;
  c._driftState = async () => ({ state: ++reads > 3 ? { ...clean(head), pendingCount: 1 } : clean(head) });
  await assert.rejects(c.projectStatus(), /Make state changed/);
});

test('symbolic links are refused rather than hashed', async t => {
  const dir = sandbox(t);
  const { c } = client(dir, { state: clean(git(dir, 'rev-parse', 'HEAD')) });
  const bridge = await c._fileBridge();
  c._fileBridge = async () => ({ ...bridge, invoke: async (fn, args) => {
    const reply = await bridge.invoke(fn, args);
    if (args[1].path === 'code/src') reply.data.files.push({ name: 'link', path: 'link', isFile: true, isDirectory: false, type: 65 });
    return reply;
  } });
  await assert.rejects(c.inventoryProject(), /symbolic links are unsupported: src\/link/);
});

test('the write gate reads the marker through the client VFS', async () => {
  const c = new MakeClient({ transport: { close() {}, send: async () => ({}) }, timeoutMs: 5000 });
  c.fileKey = 'ExactKey';
  c._operation = async fn => fn(Date.now() + 5000);
  const actions = [];
  c._durable = async action => { actions.push(action); return { exists: true, content: '{"fileKey":"ExactKey","repo":"o/r"}' }; };
  assert.equal((await c.projectMarker()).toString(), '{"fileKey":"ExactKey","repo":"o/r"}');
  assert.deepEqual(actions, [{ type: 'read', path: '.figma-cli/project.json' }]);
  c._durable = async () => ({ exists: false, content: null });
  assert.equal(await c.projectMarker(), null);
});
