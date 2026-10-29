import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBlobSha, gitTreeSha } from '../src/git-tree.js';
import { MakeClient } from '../src/make-client.js';
import { DEPLOY_IGNORE, defaultReadBlob, deployAbort, deployApply, deployPlan, deployResume, deployVerify, driftProblems, ignoreMatcher, ignorePatterns, readReceipt } from '../src/make-deploy.js';
import { markerContent } from '../src/make-mode.js';
import { PROJECT_MARKER } from '../src/make-project.js';
import { defaultRun } from '../src/make-team.js';
import { listMakeFiles } from '../src/make-tree.js';

// Local git only: a bare "origin" stands in for GitHub, while gh, pnpm and the
// Make client are faked. Nothing here reaches Figma, GitHub or a registry.
const REPO = 'owner/proto';
const KEY = 'ExactKey';
const PKG = { name: 'app', private: true, scripts: { build: 'vite build' } };
const MARKER = markerContent(KEY, REPO);

const config = mkdtempSync(join(tmpdir(), 'figma-cli-deploy-git-'));
writeFileSync(join(config, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.invalid\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(config, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' });
process.on('exit', () => rmSync(config, { recursive: true, force: true }));

const sha256 = value => createHash('sha256').update(value).digest('hex');
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'figma-cli-deploy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const sh = (dir, ...args) => {
  const result = defaultRun('git', args, { cwd: dir });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const text = value => typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) { rmSync(join(dir, path), { force: true }); continue; }
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), Buffer.isBuffer(content) ? content : text(content));
  }
}
function commit(dir, files, message = 'change') {
  write(dir, files);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', message);
  return sh(dir, 'rev-parse', 'HEAD');
}

const BASE = { 'package.json': PKG, 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n', 'src/App.tsx': 'export const App = () => null;\n',
  'src/main.tsx': 'import { App } from "./App";\n', 'src/old.ts': 'export const old = 1;\n' };

// origin (bare), upstream (where "merged pull requests" land) and the
// deployer's clone of main.
function project(t, { files = BASE, marker = true } = {}) {
  const root = temp(t);
  const origin = join(root, 'origin.git');
  const upstream = join(root, 'upstream');
  const clone = join(root, 'clone');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'init', '-q', '-b', 'main', upstream);
  commit(upstream, { ...files, ...(marker ? { [PROJECT_MARKER]: MARKER } : {}) }, 'initial');
  sh(upstream, 'remote', 'add', 'origin', `file://${origin}`);
  sh(upstream, 'push', '-q', 'origin', 'main');
  sh(root, 'clone', '-q', `file://${origin}`, clone);
  const land = (changes, message = 'merged pull request') => {
    sh(upstream, 'pull', '-q', '--ff-only', 'origin', 'main');
    const sha = commit(upstream, changes, message);
    sh(upstream, 'push', '-q', 'origin', 'main');
    return sha;
  };
  const pull = () => sh(clone, 'pull', '-q', '--ff-only');
  const tags = () => sh(origin, 'tag', '-l', 'make-deploy/*').split('\n').filter(Boolean);
  const home = join(root, 'home');
  return { root, origin, upstream, clone, land, pull, tags, home };
}

// A lockfile that pnpm would write for this package.json.
const lockFor = pkg => `lockfileVersion: 9.0\n# resolved for ${sha256(Buffer.isBuffer(pkg) ? pkg : text(pkg)).slice(0, 12)}\n`;

// A stateful Make: saved and working files, the listed pending set (Make does
// not list dot-folder paths), versions, private backups and failure hooks.
// With `install` set, a write of package.json or the lockfile makes Make run
// its own install, which lands at the next call: it rewrites the lockfile as
// install(package.json) and, when that changes the pending list under a
// write, the write refuses as the real client does. As live, a version
// commits a root lockfile only when the client wrote it, not when Make's
// install did.
class FakeMake {
  constructor(files, { marker = true } = {}) {
    this.fileKey = KEY;
    this.saved = new Map(Object.entries({ ...files, ...(marker ? { [PROJECT_MARKER]: MARKER } : {}) }).map(([p, c]) => [p, Buffer.isBuffer(c) ? c : Buffer.from(text(c))]));
    this.working = new Map(this.saved);
    this.version = 3;
    this.savedVersion = 'a'.repeat(40);
    this.calls = [];
    this.ui = { busy: false };
    this.hooks = {};
    this.hasBaseline = true;
    this.trackerError = false;
    this.head = this.savedVersion;
    this.sandbox = new Map(this.saved);
    this.generating = false;
    this.install = null;
    this.installing = false;
    this.clientWrote = new Set();
  }
  land() {
    if (!this.installing) return;
    this.installing = false;
    const result = typeof this.install === 'function' ? this.install(this.working.get('package.json')) : null;
    for (const [path, content] of Object.entries(result || {})) this.working.set(path, Buffer.from(text(content)));
  }
  installAfter(path) { if (this.install && ['package.json', 'pnpm-lock.yaml'].includes(path)) this.installing = true; }
  landUnder(what) {
    const before = JSON.stringify(this.pending());
    this.land();
    if (JSON.stringify(this.pending()) !== before) {
      const error = new Error(`Make version or pending files changed before the durable ${what}.`);
      error.code = 'MAKE_PENDING_CHANGED';
      throw error;
    }
  }
  async readDurable(path) {
    this.calls.push(['read', path]);
    return this.working.has(path) ? { exists: true, content: this.working.get(path).toString() } : { exists: false, content: null };
  }
  async idleState(paths) {
    this.calls.push(['idle']);
    if (this.installing) { this.land(); return { busy: true, offline: false, state: null, sha: {} }; }
    const sha = Object.fromEntries(paths.map(path => [path, this.working.has(path) ? sha256(this.working.get(path)) : null]));
    return { busy: false, offline: false, state: { mode: 'git', savedVersion: this.savedVersion, pendingPaths: this.pending(), isLoading: false,
      error: this.trackerError }, sha };
  }
  flat(files) { return new Map([...files].map(([path, bytes]) => [path, { mode: '100644', blob: gitBlobSha(bytes) }])); }
  tree(files) { return gitTreeSha([...this.flat(files)].map(([path, entry]) => ({ path, ...entry }))); }
  changed() {
    return [...new Set([...this.saved.keys(), ...this.working.keys()])]
      .filter(path => !(this.saved.has(path) && this.working.has(path) && this.saved.get(path).equals(this.working.get(path)))).sort();
  }
  // Like live Make, root lockfiles are never listed.
  pending() { return this.changed().filter(path => !path.split('/').some(part => part.startsWith('.')) && !['pnpm-lock.yaml', 'package-lock.json'].includes(path)); }
  async inspect() { return { fileKey: KEY, ...this.ui }; }
  async projectMarker() { return this.working.get(PROJECT_MARKER) ?? null; }
  async projectStatus({ classifyText = false, savedInventory = false, savedProtected = () => false } = {}) {
    this.calls.push(['status']);
    const pendingPaths = this.pending();
    const missing = this.savedCommitMissing === true;
    const base = this.hasBaseline && !missing ? this.saved : this.sandbox;
    return {
      persistence: { mode: 'git', hasBaseline: this.hasBaseline, savedVersion: this.hasBaseline || this.trackerError ? this.savedVersion : null,
        pendingCount: pendingPaths.length, pendingPaths, isLoading: false, error: this.trackerError },
      history: { generationInProgress: this.generating, latest: { versionNumber: this.version, gitSha: this.savedVersion } },
      head: this.head, treeSource: this.hasBaseline && !missing ? 'saved-version' : 'sandbox-head', savedMissing: missing,
      makeFlat: this.flat(base), headFlat: this.flat(this.sandbox), workingFlat: this.flat(this.working),
      makeTree: this.tree(base), workingTree: this.tree(this.working),
      workingSha256: new Map([...this.working].map(([path, bytes]) => [path, sha256(bytes)])),
      ...(savedInventory ? {
        savedSha256: new Map(missing ? [] : [...this.saved].filter(([path]) => !savedProtected(path)).map(([path, bytes]) => [path, sha256(bytes)])),
        savedBlobs: new Map(missing ? [] : [...this.saved].filter(([path]) => savedProtected(path)).map(([path, bytes]) => [path, gitBlobSha(bytes)])),
      } : {}),
      ...(classifyText ? { workingText: new Map([...this.working].map(([path, bytes]) => {
        let text = true;
        try { text = bytes.length <= 2 * 1024 * 1024 && !new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0'); }
        catch { text = false; }
        return [path, text];
      })) } : {}),
      markerBytes: this.working.get(PROJECT_MARKER) ?? null, isLfs: () => false,
    };
  }
  backup(path, bytes, backupDir) {
    const dir = join(backupDir, `make-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'original.txt'), bytes);
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ fileKey: KEY, path, sha256: sha256(bytes) }));
    return join(dir, 'original.txt');
  }
  // figma-cli's own absence guard for a new file, over the working copy as
  // Make renders it: a folder with no file left below it is gone.
  async requireAncestor(path, baseFolders) {
    const client = new MakeClient({ transport: { close() {} }, timeoutMs: 2000 });
    client._sourceTree = async () => [...this.working.keys()].flatMap(file => file.split('/').map((_, index, parts) =>
      ({ kind: index === parts.length - 1 ? 'file' : 'folder', path: parts.slice(0, index + 1).join('/') })));
    client._durable = async ({ path: target }) => ({ exists: this.working.has(target) });
    await client._requireListableAncestor(path, Date.now() + 1000, baseFolders);
  }
  async writeDurable(path, content, { expectedSha256, backupDir, rewrite = false, baseFolders } = {}) {
    this.calls.push(['write', path]);
    this.hooks.beforeWrite?.(path);
    this.landUnder('write');
    const current = this.working.get(path);
    if ((current != null) !== (expectedSha256 != null)) throw new Error('Expected SHA-256 is required for an existing file and forbidden for a new file.');
    if (current && sha256(current) !== expectedSha256) throw new Error('Make source changed; SHA-256 does not match.');
    if (!current) await this.requireAncestor(path, baseFolders);
    if (current && current.equals(Buffer.from(content)) && !rewrite) return { path, changed: false, backupPath: null };
    const backupPath = current ? this.backup(path, current, backupDir) : null;
    this.working.set(path, Buffer.from(content));
    this.clientWrote.add(path);
    this.installAfter(path);
    await this.hooks.afterWrite?.(path);
    return { path, changed: true, backupPath };
  }
  async deleteDurable(path, { expectedSha256, backupDir } = {}) {
    this.calls.push(['delete', path]);
    this.hooks.beforeWrite?.(path);
    this.landUnder('delete');
    const current = this.working.get(path);
    if (!current || sha256(current) !== expectedSha256) throw new Error('Make source is missing or changed; delete refused.');
    const backupPath = this.backup(path, current, backupDir);
    this.working.delete(path);
    this.clientWrote.add(path);
    return { path, backupPath };
  }
  commitVersion() {
    const saved = new Map(this.working);
    for (const path of ['pnpm-lock.yaml', 'package-lock.json']) {
      if (this.clientWrote.has(path)) continue;
      if (this.saved.has(path)) saved.set(path, this.saved.get(path)); else saved.delete(path);
    }
    this.saved = saved;
    this.clientWrote.clear();
    this.version += 1;
    this.savedVersion = sha256(`v${this.version}`).slice(0, 40);
    this.head = this.savedVersion;
    this.sandbox = new Map(this.saved);
    this.hasBaseline = true;
    this.trackerError = false;
    this.savedCommitMissing = false;
    return { versionId: `id-${this.version}`, versionNumber: this.version, gitSha: this.savedVersion, tree: this.tree(this.saved) };
  }
  async saveCheckedVersion(title, expectedPaths, { listed, overrideMake } = {}) {
    this.calls.push(['save', title, [...expectedPaths].sort()]);
    assert.equal(listed, true);
    const others = this.pending().filter(path => !(overrideMake ? overrideMake.expectedDiff : expectedPaths).includes(path));
    if (others.length) throw new Error(`Make lists other pending changes ${JSON.stringify(others)}`);
    if (overrideMake) {
      assert.equal(overrideMake.savedVersion, this.savedVersion);
      assert.equal(overrideMake.head, this.head);
      const actual = [...new Set([...this.sandbox.keys(), ...this.working.keys()])]
        .filter(path => !this.sandbox.has(path) || !this.working.has(path) || !this.sandbox.get(path).equals(this.working.get(path))).sort();
      assert.deepEqual(actual, overrideMake.expectedDiff);
    } else assert.deepEqual(this.changed(), [...expectedPaths].sort());
    if (this.hooks.save === 'refused') throw new Error('Make version or pending file set changed before createVersion.');
    if (this.hooks.save === 'uncertain-no-save') {
      const error = new Error('Make version outcome is uncertain.');
      error.createVersionCalled = true;
      throw error;
    }
    if (this.hooks.save === 'uncertain') {
      this.commitVersion();
      const error = new Error('Make version outcome is uncertain: socket closed. Inspect versions before retrying.');
      error.createVersionCalled = true;
      throw error;
    }
    const version = this.commitVersion();
    if (this.hooks.save === 'tracker-not-recovered') {
      this.hasBaseline = false;
      this.trackerError = true;
      const error = new Error('Make version was created but the tracker did not recover.');
      error.version = { ...version };
      throw error;
    }
    if (this.hooks.save === 'unconfirmed') {
      const error = new Error(`Make version ${version.versionNumber} was created but its baseline was not verified. Do not retry the save.`);
      error.version = { ...version, previousGitSha: null };
      throw error;
    }
    return { ...version, title, verification: 'saved-version-clean-baseline; saved-tree-matched' };
  }
  async reloadPage() {
    this.calls.push(['reload']);
    this.working = new Map(this.saved);
    return { reloaded: true };
  }
  async probeFilesystemReady() {
    this.calls.push(['probe-filesystem']);
    if (this.hooks.probeAlwaysFails || this.hooks.probeFailures > 0) {
      if (this.hooks.probeFailures > 0) this.hooks.probeFailures--;
      throw new Error('Make filesystem request timed out');
    }
  }
  get writes() { return this.calls.filter(([kind]) => ['write', 'delete', 'save'].includes(kind)); }
}

// gh: permission, login, and which commits came from merged pull requests.
function fakeGh({ permission = 'admin', login = 'octo', reviewed = () => true, down = false } = {}) {
  const calls = [];
  const gh = async args => {
    calls.push(args);
    if (down) throw new Error('gh api failed: HTTP 401');
    if (args[0] === 'user') return { login };
    if (args[0] === `repos/${REPO}`) return { permissions: { admin: permission === 'admin', push: ['admin', 'write'].includes(permission), pull: true } };
    const pulls = /^repos\/owner\/proto\/commits\/([a-f0-9]{40})\/pulls$/.exec(args[0]);
    if (pulls) return reviewed(pulls[1]) ? [{ merged_at: '2026-10-15T00:00:00Z', base: { ref: 'main' }, html_url: 'https://github.com/owner/proto/pull/7' }] : [];
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
}

// pnpm is faked; git is real. Never pushes a branch, only deploy tags.
function fakeRun({ build = 0, onBuild, onTagPush, originUrl = 'https://github.com/owner/proto.git' } = {}) {
  const calls = [];
  const run = (command, args, options = {}) => {
    calls.push({ command, args });
    // origin is a local bare repo; report the GitHub URL it stands in for.
    if (command === 'git' && args.join(' ') === 'remote get-url origin') return { status: 0, stdout: `${originUrl}\n`, stderr: '' };
    if (command === 'git' && args[0] === 'push') {
      assert.ok(args.every(arg => !/refs\/heads\//.test(arg) && arg !== 'main' && !arg.startsWith('-f') && arg !== '--force'), `pushed more than a tag: ${args.join(' ')}`);
      onTagPush?.(args);
    }
    if (command === 'pnpm') {
      if (args[0] === 'run' && args[1] === 'build') {
        onBuild?.(options.cwd);
        return { status: build, stdout: build ? 'error TS2304: Cannot find name\n' : 'built\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    return defaultRun(command, args, options);
  };
  return { run, calls };
}

function setup(t, { files = BASE, marker = true, makeFiles, make: makeOptions, gh: ghOptions, run: runOptions, install } = {}) {
  const p = project(t, { files, marker });
  const make = new FakeMake(makeFiles ?? files, makeOptions);
  const gh = fakeGh(ghOptions);
  const run = fakeRun(runOptions);
  const deps = { run: run.run, gh: gh.gh, home: p.home, install: install ?? (() => {}), now: () => new Date('2026-10-15T01:02:03.000Z'),
    settle: { quietMs: 0, pollMs: 0, timeoutMs: 5000 }, sleep: async () => {} };
  return { p, make, gh, run, deps, opts: { dir: p.clone } };
}

const refuses = async (promise, code, pattern) => {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
};

// A merged change on main, pulled into the clone; the deploy target.
function landChange(s, changes = { 'src/App.tsx': 'export const App = () => "v2";\n', 'src/old.ts': null, 'src/Card.tsx': 'export const Card = 1;\n' }) {
  const sha = s.p.land(changes);
  s.p.pull();
  return sha;
}

// A compact fake rendered tree. The first folder expansion after a write sees
// Make's stale guarded snapshot, then the next traversal sees the new rows.
function writtenTree(paths, { refuseFirstExpand = false } = {}) {
  const roots = [];
  for (const path of paths) {
    if (path.startsWith('.') || ['pnpm-lock.yaml', 'package-lock.json'].includes(path)) continue;
    let children = roots;
    for (const [index, name] of path.split('/').entries()) {
      let node = children.find(item => item.name === name);
      if (!node) { node = { name, kind: index === path.split('/').length - 1 ? 'file' : 'folder', children: [] }; children.push(node); }
      children = node.children;
    }
  }
  const expanded = new Set();
  let refused = false;
  const flatten = (nodes = roots, prefix = '', level = 1) => nodes.flatMap(node => {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    return [{ node, path, level }, ...(node.kind === 'folder' && expanded.has(path) ? flatten(node.children, path, level + 1) : [])];
  });
  return {
    async evaluate(expression) {
      const action = JSON.parse(expression.match(/\)\((\{[\s\S]*\})\)$/)[1]);
      if (action.type === 'expand') {
        if (refuseFirstExpand && !refused) {
          refused = true;
          throw new Error('Make file tree changed before the requested action. Run the command again.');
        }
        const hit = flatten().find((item, index) => index * 32 === action.row.top && item.node.name === action.row.name);
        assert.ok(hit, 'folder action targets a rendered row');
        expanded.add(hit.path);
      }
      const visible = flatten();
      return { contentHeight: visible.length * 32, scrollTop: 0, clientHeight: 100000,
        rows: visible.map(({ node, level }, index) => ({ name: node.name, kind: node.kind, level,
          top: index * 32, height: 32, expanded: node.kind === 'folder' ? expanded.has(visible[index].path) : null,
          selected: false })) };
    },
  };
}

const DEEP_PATH = 'src/vendor/atomic-aui/lib/datepicker/use-recipe.ts';
function checkUnopenedReadback(make) {
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 2000 });
  client.fileKey = KEY;
  client._durable = async ({ path }) => ({ exists: make.working.has(path), content: make.working.get(path)?.toString() });
  client._fileBridge = async () => ({ dispose: async () => {} });
  client._bridgeRead = async (_bridge, path) => ({ content: make.working.get(path).toString() });
  client._sourceTree = async () => [{ kind: 'file', path: DEEP_PATH }];
  client._read = async () => { throw Object.assign(new Error('Make shows no source editor.'), { code: 'MAKE_NO_EDITOR' }); };
  make.hooks.afterWrite = async path => {
    if (path === DEEP_PATH) make.deepReadback = await client._durableAgreement(path, make.working.get(path).toString(), Date.now() + 1000);
  };
}

describe('make deploy unopened deep-file read-back', () => {
  it('applies and saves a deep file with three matching views', async t => {
    const s = setup(t, { files: { ...BASE, [DEEP_PATH]: 'old\n' } });
    landChange(s, { [DEEP_PATH]: 'new\n' });
    checkUnopenedReadback(s.make);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps);
    assert.equal(s.make.deepReadback, 'tree-vfs-sandbox-matched');
    assert.equal(applied.stage, 'deployed');
    assert.equal(s.make.saved.get(DEEP_PATH).toString(), 'new\n');
  });

  it('resumes across a deep file after an earlier write failed', async t => {
    const s = setup(t, { files: { ...BASE, [DEEP_PATH]: 'old\n' } });
    landChange(s, { 'src/App.tsx': 'updated\n', [DEEP_PATH]: 'new\n' });
    const plan = await deployPlan(s.make, s.opts, s.deps);
    s.make.hooks.beforeWrite = path => { if (path === DEEP_PATH) throw new Error('Make operation timed out.'); };
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => {
      receiptPath = error.receiptPath;
      return error.code === 'DEPLOY_WRITE_FAILED';
    });
    s.make.hooks.beforeWrite = null;
    checkUnopenedReadback(s.make);
    const resumed = await deployResume(s.make, { ...s.opts, receiptPath }, s.deps);
    assert.equal(s.make.deepReadback, 'tree-vfs-sandbox-matched');
    assert.equal(resumed.stage, 'deployed');
    assert.equal(s.make.saved.get(DEEP_PATH).toString(), 'new\n');
  });
});

describe('guarded Make override (fake Make and local git only)', () => {
  const stale = s => {
    s.make.hasBaseline = false;
    s.make.trackerError = true;
    s.make.head = 'b'.repeat(40);
    s.make.sandbox = new Map(s.make.working);
  };
  const target = s => {
    landChange(s);
    stale(s);
  };

  it('plans from a verified deploy record when the saved sandbox commit is missing', async t => {
    const s = setup(t, { files: { ...BASE, '.npmrc': 'secret=do-not-read\n' } });
    const served = new Map(s.make.working);
    landChange(s, { 'src/App.tsx': 'export const App = 2;\n' });
    const first = await deployPlan(s.make, s.opts, s.deps);
    const deployed = await deployApply(s.make, { ...s.opts, planPath: first.planPath }, s.deps);
    const prior = readReceipt(deployed.receiptPath);
    assert.equal(prior.makeAfter.tree, prior.mainTree);

    landChange(s, { 'src/App.tsx': 'export const App = 3;\n' });
    s.make.working = new Map(served);
    stale(s);
    const projectStatus = s.make.projectStatus.bind(s.make);
    s.make.projectStatus = async options => {
      if (options?.savedInventory) throw new Error(`Make sandbox git object ${s.make.savedVersion} is missing.`);
      return projectStatus(options);
    };
    const npmrcBlob = sh(s.p.clone, 'rev-parse', 'HEAD:.npmrc');
    const readBlobs = [];
    s.deps.readBlob = (root, blob) => {
      readBlobs.push(blob);
      if (blob === npmrcBlob) throw new Error('Protected .npmrc blob was read');
      return defaultReadBlob(root, blob);
    };

    const plan = await deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps);
    assert.equal(readBlobs.includes(npmrcBlob), false);
    assert.match(plan.summary, /saved copy unreadable, using deploy record/);
    assert.deepEqual(plan.files, [{ path: 'src/App.tsx', op: 'modify' }]);
    const savedInventory = JSON.parse(readFileSync(plan.planPath, 'utf8')).makeBefore.savedInventory;
    assert.equal(savedInventory.find(item => item.path === 'src/App.tsx').sha256, sha256('export const App = 2;\n'));
    assert.deepEqual(savedInventory.find(item => item.path === '.npmrc'), { path: '.npmrc', blob: npmrcBlob });

    prior.makeAfter.tree = 'f'.repeat(40);
    writeFileSync(deployed.receiptPath, JSON.stringify(prior));
    assert.match((await deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps)).summary, /using deploy tag record/);
    rmSync(deployed.receiptPath);
    sh(s.p.origin, 'tag', '-d', 'make-deploy/0');
    await refuses(deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps), 'DEPLOY_MAKE_STATE', /deploy record/i);
  });

  it('plans from the annotated deploy tag record when the saved commit and local receipt are missing', async t => {
    const s = setup(t, { files: { ...BASE, '.npmrc': 'fixture-only\n' } });
    landChange(s, { 'src/App.tsx': 'export const App = 2;\n' });
    const first = await deployPlan(s.make, s.opts, s.deps);
    const deployed = await deployApply(s.make, { ...s.opts, planPath: first.planPath }, s.deps);
    assert.deepEqual(s.p.tags(), ['make-deploy/0']);
    const prior = readReceipt(deployed.receiptPath);
    rmSync(deployed.receiptPath);

    landChange(s, { 'src/App.tsx': 'export const App = 3;\n' });
    stale(s);
    const projectStatus = s.make.projectStatus.bind(s.make);
    s.make.projectStatus = async options => {
      if (options?.savedInventory) throw new Error(`Make sandbox git object ${s.make.savedVersion} is missing.`);
      return projectStatus(options);
    };
    const protectedBlob = sh(s.p.clone, 'rev-parse', 'HEAD:.npmrc');
    s.deps.readBlob = (root, blob) => {
      if (blob === protectedBlob) throw new Error('Protected blob was read');
      return defaultReadBlob(root, blob);
    };

    const plan = await deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps);
    assert.match(plan.summary, /saved copy unreadable, using deploy tag record/);
    assert.deepEqual(plan.files, [{ path: 'src/App.tsx', op: 'modify' }]);
    const saved = JSON.parse(readFileSync(plan.planPath, 'utf8')).makeBefore;
    assert.equal(saved.savedInventorySource, 'deploy-tag-record');
    assert.deepEqual(saved.savedInventory.find(item => item.path === '.npmrc'), { path: '.npmrc', blob: protectedBlob });
    assert.equal(saved.savedInventory.find(item => item.path === 'src/App.tsx').sha256, sha256('export const App = 2;\n'));

    const oldRecord = { ...prior, makeAfter: { ...prior.makeAfter, versionGitSha: 'd'.repeat(40) } };
    delete oldRecord.receiptPath;
    writeFileSync(deployed.receiptPath, JSON.stringify(oldRecord));
    assert.match((await deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps)).summary, /using deploy tag record/);
    rmSync(deployed.receiptPath);

    const pointer = s.make.savedVersion;
    s.make.savedVersion = 'c'.repeat(40);
    await refuses(deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps), 'DEPLOY_MAKE_STATE', /deploy record.*saved pointer/i);
    s.make.savedVersion = pointer;
    const tagMessage = sh(s.p.origin, 'cat-file', 'tag', 'make-deploy/0');
    const record = JSON.parse(tagMessage.slice(tagMessage.indexOf('{')));
    assert.equal(record.plan, undefined);
    assert.equal(record.outcome, undefined);
    record.mainTree = 'f'.repeat(40);
    sh(s.p.origin, 'tag', '-f', '-a', '-m', JSON.stringify(record), 'make-deploy/0', record.mainCommit);
    await refuses(deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps), 'DEPLOY_MAKE_STATE', /tagged commit's tree/i);
  });

  it('plans and applies with a baseline flag when the saved commit is absent', async t => {
    const s = setup(t);
    landChange(s, { 'src/App.tsx': 'export const App = 2;\n' });
    const first = await deployPlan(s.make, s.opts, s.deps);
    const deployed = await deployApply(s.make, { ...s.opts, planPath: first.planPath }, s.deps);
    rmSync(deployed.receiptPath);

    landChange(s, { 'src/App.tsx': 'export const App = 3;\n' });
    s.make.head = 'b'.repeat(40);
    s.make.sandbox = new Map(s.make.working);
    s.make.savedCommitMissing = true;
    assert.equal(s.make.hasBaseline, true);
    const plan = await deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps);
    assert.match(plan.summary, /using deploy tag record/);
    assert.deepEqual(plan.files, [{ path: 'src/App.tsx', op: 'modify' }]);
    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath,
      confirmOverride: plan.digest.slice(0, 12) }, s.deps);
    assert.equal(applied.stage, 'saved-unverified');
    assert.deepEqual(s.p.tags(), ['make-deploy/0']);
    s.make.savedCommitMissing = true;
    s.make.head = 'c'.repeat(40);
    await refuses(deployVerify(s.make, { ...s.opts, receiptPath: applied.receiptPath }, s.deps),
      'DEPLOY_MAKE_STATE', /deploy record.*saved pointer/i);
    assert.equal(readReceipt(applied.receiptPath).stage, 'saved-unverified');
    s.make.savedCommitMissing = false;
    s.make.head = s.make.savedVersion;
    const verified = await deployVerify(s.make, { ...s.opts, receiptPath: applied.receiptPath }, s.deps);
    assert.equal(verified.stage, 'deployed');
    assert.deepEqual(s.p.tags(), ['make-deploy/0', 'make-deploy/1']);
  });

  it('waits for the reloaded Make filesystem before verifying', async t => {
    const s = setup(t);
    target(s);
    const plan = await deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps);
    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath,
      confirmOverride: plan.digest.slice(0, 12) }, s.deps);
    s.make.hooks.probeFailures = 2;
    const verified = await deployVerify(s.make, { ...s.opts, receiptPath: applied.receiptPath }, s.deps);
    assert.equal(verified.stage, 'deployed');
    const afterReload = s.make.calls.slice(s.make.calls.findIndex(([kind]) => kind === 'reload') + 1);
    assert.deepEqual(afterReload.slice(0, 4).map(([kind]) => kind), ['probe-filesystem', 'probe-filesystem', 'probe-filesystem', 'status']);
  });

  it('keeps the receipt unverified when the reloaded filesystem never becomes ready', async t => {
    const s = setup(t);
    target(s);
    const plan = await deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps);
    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath,
      confirmOverride: plan.digest.slice(0, 12) }, s.deps);
    s.make.hooks.probeAlwaysFails = true;
    s.deps.reloadReady = { timeoutMs: 30, initialMs: 10, maxMs: 10 };
    await refuses(deployVerify(s.make, { ...s.opts, receiptPath: applied.receiptPath }, s.deps),
      'DEPLOY_VERIFY_FAILED', /filesystem and code panel were not ready after reload/);
    assert.equal(readReceipt(applied.receiptPath).stage, 'saved-unverified');
    assert.deepEqual(s.p.tags(), []);
    assert.ok(s.make.calls.filter(([kind]) => kind === 'probe-filesystem').length >= 2);
  });

  it('binds confirmation and Make-only policy to the reviewed digest; tags only after reload', async t => {
    const s = setup(t);
    target(s);
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_MAKE_STATE');
    const keep = await deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps);
    const strict = await deployPlan(s.make, { ...s.opts, overrideMake: true, deleteMakeOnly: true }, s.deps);
    assert.notEqual(keep.digest, strict.digest);
    assert.deepEqual(keep.counts, { add: 1, modify: 1, delete: 0, keepMakeOnly: 1,
      unsupported: 0, ignored: 0 });
    assert.deepEqual(keep.keepMakeOnly, ['src/old.ts']);
    assert.equal(readFileSync(keep.planPath, 'utf8').includes('export const App'), false);
    await refuses(deployApply(s.make, { ...s.opts, planPath: strict.planPath, confirmOverride: keep.digest.slice(0, 12) }, s.deps), 'DEPLOY_STALE_PLAN');
    const applied = await deployApply(s.make, { ...s.opts, planPath: strict.planPath,
      confirmOverride: strict.digest.slice(0, 12) }, s.deps);
    assert.equal(applied.stage, 'saved-unverified');
    assert.deepEqual(s.p.tags(), []);
    const receipt = readReceipt(applied.receiptPath);
    assert.equal(receipt.mode, 'override-make');
    assert.equal(receipt.makeBefore.inventory.length, Object.keys(BASE).length + 1);
    assert.ok(receipt.files.filter(file => ['modify', 'delete'].includes(file.op)).every(file =>
      file.backupPath && sha256(readFileSync(file.backupPath)) === file.beforeSha256));
    const verified = await deployVerify(s.make, { ...s.opts, receiptPath: applied.receiptPath }, s.deps);
    assert.equal(verified.stage, 'deployed');
    assert.deepEqual(s.p.tags(), ['make-deploy/0']);
    const tagMessage = sh(s.p.origin, 'cat-file', 'tag', 'make-deploy/0');
    const shared = JSON.parse(tagMessage.slice(tagMessage.indexOf('{')));
    assert.equal(shared.mode, undefined);
    assert.equal(shared.keptMakeOnly, undefined);
    assert.equal(shared.makeBefore.inventory, undefined, 'private full inventory is not published in the tag');
    assert.equal(s.make.saved.has('src/old.ts'), false);
  });

  it('keeps Make-only files by default and detects stale Make inventory before writing', async t => {
    const s = setup(t);
    target(s);
    const plan = await deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps);
    s.make.working.set('src/old.ts', Buffer.from('changed in Make\n'));
    await refuses(deployApply(s.make, { ...s.opts, planPath: plan.planPath,
      confirmOverride: plan.digest.slice(0, 12) }, s.deps), 'DEPLOY_STALE_PLAN');
    assert.deepEqual(s.make.writes, []);
    s.make.working.set('src/old.ts', Buffer.from(BASE['src/old.ts']));
    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath,
      confirmOverride: plan.digest.slice(0, 12) }, s.deps);
    await deployVerify(s.make, { ...s.opts, receiptPath: applied.receiptPath }, s.deps);
    assert.equal(s.make.saved.get('src/old.ts').toString(), BASE['src/old.ts']);
  });

  it('aborts create, modify and delete from read-back backups after a save refusal', async t => {
    const s = setup(t);
    target(s);
    const original = new Map(s.make.working);
    s.make.hooks.save = 'refused';
    const plan = await deployPlan(s.make, { ...s.opts, overrideMake: true, deleteMakeOnly: true }, s.deps);
    const error = await deployApply(s.make, { ...s.opts, planPath: plan.planPath,
      confirmOverride: plan.digest.slice(0, 12) }, s.deps).catch(cause => cause);
    assert.equal(error.code, 'DEPLOY_WRITE_FAILED');
    assert.equal(readReceipt(error.receiptPath).stage, 'written');
    const abort = await deployAbort(s.make, { receiptPath: error.receiptPath }, s.deps);
    assert.equal(abort.outcome, 'aborted');
    assert.deepEqual([...s.make.working].map(([path, bytes]) => [path, bytes.toString()]).sort(),
      [...original].map(([path, bytes]) => [path, bytes.toString()]).sort());
    assert.deepEqual(s.p.tags(), []);
  });

  it('recovers after a refused save reloads saved v2 over sandbox v1', async t => {
    const prepareAhead = s => {
      landChange(s, { 'src/App.tsx': 'export const App = 3;\n' });
      s.make.saved.set('src/App.tsx', Buffer.from('export const App = 2;\n'));
      s.make.savedVersion = sha256('saved v2').slice(0, 40);
      s.make.hasBaseline = false;
      s.make.trackerError = true;
      s.make.head = 'b'.repeat(40);
      s.make.sandbox = new Map(s.make.working);
      s.make.hooks.save = 'refused';
    };
    const abortCase = setup(t);
    prepareAhead(abortCase);
    const abortPlan = await deployPlan(abortCase.make, { ...abortCase.opts, overrideMake: true }, abortCase.deps);
    const abortError = await deployApply(abortCase.make, { ...abortCase.opts, planPath: abortPlan.planPath,
      confirmOverride: abortPlan.digest.slice(0, 12) }, abortCase.deps).catch(cause => cause);
    assert.equal(abortError.code, 'DEPLOY_WRITE_FAILED');
    const receipt = readReceipt(abortError.receiptPath);
    assert.equal(receipt.makeBefore.savedInventory.find(file => file.path === 'src/App.tsx').sha256,
      sha256('export const App = 2;\n'));
    await abortCase.make.reloadPage();
    const aborted = await deployAbort(abortCase.make, { receiptPath: abortError.receiptPath }, abortCase.deps);
    assert.equal(aborted.outcome, 'aborted');
    assert.equal(abortCase.make.working.get('src/App.tsx').toString(), BASE['src/App.tsx']);
    assert.deepEqual(abortCase.p.tags(), []);

    const resumeCase = setup(t);
    prepareAhead(resumeCase);
    const resumePlan = await deployPlan(resumeCase.make, { ...resumeCase.opts, overrideMake: true }, resumeCase.deps);
    const resumeError = await deployApply(resumeCase.make, { ...resumeCase.opts, planPath: resumePlan.planPath,
      confirmOverride: resumePlan.digest.slice(0, 12) }, resumeCase.deps).catch(cause => cause);
    assert.equal(resumeError.code, 'DEPLOY_WRITE_FAILED');
    delete resumeCase.make.hooks.save;
    const resumed = await deployResume(resumeCase.make, { ...resumeCase.opts, receiptPath: resumeError.receiptPath }, resumeCase.deps);
    assert.equal(resumed.stage, 'saved-unverified');
    assert.equal(resumeCase.make.saved.get('src/App.tsx').toString(), 'export const App = 3;\n');
    assert.deepEqual(resumeCase.p.tags(), []);
  });

  it('does not tag when a created version leaves the tracker broken', async t => {
    const s = setup(t);
    target(s);
    s.make.hooks.save = 'tracker-not-recovered';
    const plan = await deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps);
    const error = await deployApply(s.make, { ...s.opts, planPath: plan.planPath,
      confirmOverride: plan.digest.slice(0, 12) }, s.deps).catch(cause => cause);
    assert.equal(error.code, 'DEPLOY_SAVE_UNCERTAIN');
    assert.equal(readReceipt(error.receiptPath).stage, 'saved-unverified');
    assert.deepEqual(s.p.tags(), []);
    await refuses(deployVerify(s.make, { ...s.opts, receiptPath: error.receiptPath }, s.deps), 'DEPLOY_VERIFY_FAILED');
    assert.deepEqual(s.p.tags(), []);
  });

  it('keeps an uncertain createVersion call at verify-only when the old pointer reappears', async t => {
    const s = setup(t);
    target(s);
    s.make.hooks.save = 'uncertain-no-save';
    const plan = await deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps);
    const error = await deployApply(s.make, { ...s.opts, planPath: plan.planPath,
      confirmOverride: plan.digest.slice(0, 12) }, s.deps).catch(cause => cause);
    assert.equal(error.code, 'DEPLOY_SAVE_UNCERTAIN');
    assert.equal(readReceipt(error.receiptPath).stage, 'save-uncertain');
    await refuses(deployVerify(s.make, { ...s.opts, receiptPath: error.receiptPath }, s.deps), 'DEPLOY_SAVE_UNCERTAIN');
    assert.equal(readReceipt(error.receiptPath).stage, 'save-uncertain');
    await refuses(deployResume(s.make, { ...s.opts, receiptPath: error.receiptPath }, s.deps), 'DEPLOY_RECEIPT');
    assert.deepEqual(s.p.tags(), []);
  });

  it('shows both hashes for an overwritten Make-ahead path', async t => {
    const s = setup(t);
    landChange(s, { 'src/App.tsx': 'export const App = 2;\n' });
    const first = await deployPlan(s.make, s.opts, s.deps);
    await deployApply(s.make, { ...s.opts, planPath: first.planPath }, s.deps);
    const makeEdit = 'export const App = 3;\n';
    s.make.saved.set('src/App.tsx', Buffer.from(makeEdit));
    s.make.working.set('src/App.tsx', Buffer.from(makeEdit));
    s.make.savedVersion = sha256('make edit').slice(0, 40);
    s.make.head = s.make.savedVersion;
    s.make.sandbox = new Map(s.make.saved);
    landChange(s, { 'src/App.tsx': 'export const App = 4;\n' });
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_MAKE_AHEAD');
    const plan = await deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps);
    assert.deepEqual(plan.makeAhead, [{ path: 'src/App.tsx', makeSha256: sha256(makeEdit),
      mainSha256: sha256('export const App = 4;\n') }]);
  });

  it('does not report main-only changes or Make-only deletions as Make-ahead', async t => {
    const s = setup(t);
    landChange(s, { 'src/App.tsx': 'export const App = 2;\n' });
    const first = await deployPlan(s.make, s.opts, s.deps);
    await deployApply(s.make, { ...s.opts, planPath: first.planPath }, s.deps);
    landChange(s, { 'src/App.tsx': 'export const App = 3;\n' });
    s.make.saved.set('src/make-only.ts', Buffer.from('Make only\n'));
    s.make.working.set('src/make-only.ts', Buffer.from('Make only\n'));
    s.make.sandbox.set('src/make-only.ts', Buffer.from('Make only\n'));
    const plan = await deployPlan(s.make, { ...s.opts, overrideMake: true, deleteMakeOnly: true }, s.deps);
    assert.deepEqual(plan.makeAhead, []);
    assert.ok(plan.files.some(file => file.path === 'src/make-only.ts' && file.op === 'delete'));
  });

  it('shows all override refusals and withholds apply for unsupported paths', async t => {
    const s = setup(t, { makeFiles: { ...BASE, 'src/raw.bin': Buffer.from([0, 255]) } });
    target(s);
    landChange(s, { 'README.md': 'new root file\n', 'src/logo.png': Buffer.from([0, 255]) });
    const plan = await deployPlan(s.make, { ...s.opts, overrideMake: true, deleteMakeOnly: true }, s.deps);
    assert.ok(plan.counts.modify > 0);
    assert.ok(plan.refused.unsupported.includes('README.md'));
    assert.ok(plan.refused.binary.includes('src/logo.png'));
    assert.ok(plan.refused.binary.includes('src/raw.bin'));
    assert.equal(plan.counts.unsupported, 3);
    assert.equal(plan.planPath, undefined);
    assert.deepEqual(s.make.writes, []);
  });

  it('refuses pending Make config and deploy-ignore edits', async t => {
    const s = setup(t);
    target(s);
    landChange(s, { [DEPLOY_IGNORE]: '/src/old.ts\n' });
    s.make.working.set('.figma/make/config.json', Buffer.from('{"dev":true}\n'));
    s.make.working.set('src/old.ts', Buffer.from('pending edit\n'));
    const plan = await deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps);
    assert.deepEqual(plan.refused.pendingExcluded, ['.figma/make/config.json', 'src/old.ts']);
    assert.equal(plan.planPath, undefined);
    assert.deepEqual(s.make.writes, []);
  });

  it('refuses saved-only changes to protected Make paths', async t => {
    const configPath = '.figma/make/config.json';
    const s = setup(t, { makeFiles: { ...BASE, [configPath]: '{"version":1}\n', [DEPLOY_IGNORE]: '/src/private.ts\n' } });
    target(s);
    const clean = await deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps);
    assert.ok(clean.planPath);
    s.make.saved.set(configPath, Buffer.from('{"version":2}\n'));
    s.make.saved.set(DEPLOY_IGNORE, Buffer.from('/src/private-v2.ts\n'));
    assert.deepEqual(s.make.pending(), []);
    const refused = await deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps);
    assert.deepEqual(refused.refused.pendingExcluded, [configPath, DEPLOY_IGNORE].sort());
    assert.equal(refused.planPath, undefined);
    await refuses(deployApply(s.make, { ...s.opts, planPath: clean.planPath,
      confirmOverride: clean.digest.slice(0, 12) }, s.deps), 'DEPLOY_STALE_PLAN');
    assert.deepEqual(s.make.writes, []);
  });

  it('allows one reload-and-resume after save refusal, then stops', async t => {
    const s = setup(t);
    target(s);
    s.make.hooks.save = 'refused';
    const plan = await deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps);
    const error = await deployApply(s.make, { ...s.opts, planPath: plan.planPath,
      confirmOverride: plan.digest.slice(0, 12) }, s.deps).catch(cause => cause);
    assert.equal(error.code, 'DEPLOY_WRITE_FAILED');
    await refuses(deployResume(s.make, { ...s.opts, receiptPath: error.receiptPath }, s.deps), 'DEPLOY_WRITE_FAILED');
    assert.equal(readReceipt(error.receiptPath).saveRefusals, 2);
    await refuses(deployResume(s.make, { ...s.opts, receiptPath: error.receiptPath }, s.deps), 'DEPLOY_RECEIPT');
  });

  it('keeps the other deploy refusals under override', async t => {
    const s = setup(t);
    target(s);
    s.make.ui.busy = true;
    await refuses(deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps), 'DEPLOY_MAKE_BUSY');
    s.make.ui.busy = false;
    s.make.hasBaseline = false;
    s.make.trackerError = false;
    await refuses(deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps), 'DEPLOY_MAKE_STATE');
    s.make.trackerError = true;
    s.make.working.set(PROJECT_MARKER, Buffer.from(markerContent(KEY, 'owner/other')));
    s.make.projectMarker = async () => Buffer.from(MARKER);
    await refuses(deployPlan(s.make, { ...s.opts, overrideMake: true }, s.deps), 'DEPLOY_MAKE_STATE');
  });
});

describe('make deploy guards', () => {
  it('refuses a solo file, which has nothing to deploy from', async t => {
    const s = setup(t, { make: { marker: false } });
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_SOLO', /solo mode.*nothing to deploy/);
    assert.deepEqual(s.make.writes, []);
  });

  it('reports a stale client VFS without the marker as a Make-state problem, not solo', async t => {
    const s = setup(t);
    s.make.projectMarker = async () => null;
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_MAKE_STATE', /disagree/);
    assert.deepEqual(s.make.writes, []);
  });

  it('refuses a marker for another file', async t => {
    const s = setup(t);
    s.make.working.set(PROJECT_MARKER, Buffer.from(markerContent('OtherKey', REPO)));
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_NOT_TEAM', /OtherKey/);
  });

  it('refuses a caller who is not a repo admin, or when gh cannot tell', async t => {
    const s = setup(t, { gh: { permission: 'write' } });
    landChange(s);
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_NOT_ADMIN', /permission is write/);
    const down = setup(t, { gh: { down: true } });
    await refuses(deployPlan(down.make, down.opts, down.deps), 'DEPLOY_GH_FAILED');
  });

  it('refuses a clone that is not on a clean main equal to GitHub main', async t => {
    const s = setup(t);
    sh(s.p.clone, 'switch', '-q', '-c', 'octo/task');
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_NOT_MAIN');
    sh(s.p.clone, 'switch', '-q', 'main');
    write(s.p.clone, { 'scratch.txt': 'x' });
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_DIRTY', /uncommitted or untracked/);
    rmSync(join(s.p.clone, 'scratch.txt'));
    s.p.land({ 'src/App.tsx': 'later\n' });
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_NOT_CURRENT', /make pull/);
    commit(s.p.clone, { 'src/local.ts': 'x\n' });
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_NOT_CURRENT');
  });

  it('refuses a clone of another repo', async t => {
    const s = setup(t, { marker: false, run: { originUrl: 'https://github.com/owner/other.git' } });
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_REPO_MISMATCH', /owner\/other/);
  });

  it('refuses a main commit that did not come from a merged pull request', async t => {
    const s = setup(t, { gh: { reviewed: () => false } });
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_UNREVIEWED', /merged into main/);
  });

  it('refuses when the install or the build fails, or the build leaves files behind', async t => {
    const s = setup(t, { install: () => { throw new Error('pnpm install --frozen-lockfile failed'); } });
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_INSTALL_FAILED', /frozen-lockfile/);
    const b = setup(t, { run: { build: 1 } });
    await refuses(deployPlan(b.make, b.opts, b.deps), 'DEPLOY_BUILD_FAILED', /TS2304/);
    const d = setup(t, { run: { onBuild: cwd => writeFileSync(join(cwd, 'dist.js'), 'x') } });
    await refuses(deployPlan(d.make, d.opts, d.deps), 'DEPLOY_DIRTY', /\.gitignore/);
    const none = setup(t, { files: { ...BASE, 'package.json': { name: 'app' } } });
    await refuses(deployPlan(none.make, none.opts, none.deps), 'DEPLOY_BUILD_FAILED', /no build script/);
  });

  it('refuses Make with unsaved edits, no baseline, a running generation or a busy editor', async t => {
    const s = setup(t);
    s.make.working.set('src/App.tsx', Buffer.from('edited in Make\n'));
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_MAKE_AHEAD', /unsaved/);
    s.make.working = new Map(s.make.saved);
    s.make.working.set('.github/notes.md', Buffer.from('unlisted\n'));
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_MAKE_AHEAD', /working copy has unsaved edits/);
    s.make.working = new Map(s.make.saved);
    s.make.hasBaseline = false;
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_MAKE_STATE');
    s.make.hasBaseline = true;
    s.make.generating = true;
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_MAKE_BUSY', /generation/);
    s.make.generating = false;
    s.make.ui = { busy: true };
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_MAKE_BUSY');
    assert.deepEqual(s.make.writes, []);
  });

  it('refuses binary, LFS and root-level changes Make cannot take', async t => {
    const bin = setup(t);
    landChange(bin, { 'src/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]) });
    await refuses(deployPlan(bin.make, bin.opts, bin.deps), 'DEPLOY_BINARY', /src\/logo\.png/);
    const lfs = setup(t);
    landChange(lfs, { '.gitattributes': '*.psd filter=lfs diff=lfs merge=lfs -text\n', 'src/art.psd': 'version https://git-lfs.github.com/spec/v1\n' });
    await refuses(deployPlan(lfs.make, lfs.opts, lfs.deps), 'DEPLOY_LFS', /src\/art\.psd/);
    const root = setup(t);
    landChange(root, { 'README.md': '# hi\n' });
    await refuses(deployPlan(root.make, root.opts, root.deps), 'DEPLOY_UNSUPPORTED_PATH', /README\.md/);
    const folder = setup(t);
    landChange(folder, { 'docs/guide.md': '# guide\n' });
    await refuses(deployPlan(folder.make, folder.opts, folder.deps), 'DEPLOY_UNSUPPORTED_PATH', /new.*top-level folder/);
  });

  it('refuses a main marker that would change the team mode', async t => {
    const s = setup(t);
    landChange(s, { [PROJECT_MARKER]: markerContent('OtherKey', REPO) });
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_MARKER', /OtherKey/);
  });
});

describe('make deploy dry run, apply and verify', () => {
  it('crosses many newly created folders in one apply with exact tree refreshes', async t => {
    const s = setup(t);
    const additions = Object.fromEntries(Array.from({ length: 12 }, (_, index) =>
      [`src/vendor/atomic-aui/lib/field-${index}/Input.tsx`, `export const field${index} = true;\n`]));
    landChange(s, additions);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    assert.equal(plan.counts.add, 12);
    let beforeEntries;
    let beforeRows;
    let checked = 0;
    s.make.hooks.beforeWrite = path => {
      if (path in additions) beforeEntries = listMakeFiles(writtenTree(s.make.working.keys()), {
        onSnapshot: snapshot => { beforeRows = snapshot.rows; },
      });
    };
    s.make.hooks.afterWrite = async path => {
      if (!(path in additions)) return;
      const entries = await listMakeFiles(writtenTree(s.make.working.keys(), { refuseFirstExpand: true }), {
        expectedChange: { beforeEntries: await beforeEntries, beforeRows, writtenPath: path },
      });
      assert.ok(entries.some(entry => entry.path === path));
      checked++;
    };
    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps);
    assert.equal(applied.stage, 'deployed');
    assert.equal(checked, 12);
    assert.equal(s.make.saved.size, s.make.working.size);
  });

  it('plans without writing, then applies, records the receipt, tags main and verifies after a reload', async t => {
    const s = setup(t, { marker: false });
    const sha = landChange(s);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    assert.equal(plan.dryRun, true);
    assert.deepEqual(plan.counts, { add: 1, modify: 1, delete: 1 });
    assert.deepEqual(plan.files, [{ path: 'src/App.tsx', op: 'modify' }, { path: 'src/Card.tsx', op: 'add' }, { path: 'src/old.ts', op: 'delete' }]);
    assert.deepEqual(plan.excluded.map(entry => entry.path), [PROJECT_MARKER]);
    assert.equal(plan.base.source, 'first-deploy');
    assert.equal(plan.tag, 'make-deploy/0');
    assert.equal(plan.mainCommit, sha);
    assert.ok(existsSync(plan.planPath));
    assert.match(plan.summary, /Nothing was changed yet/);
    assert.deepEqual(s.make.writes, []);

    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps);
    assert.equal(applied.outcome, 'ok');
    assert.equal(applied.stage, 'deployed');
    assert.equal(applied.makeAfter.versionNumber, 4);
    assert.equal(applied.verification, 'saved-clean-tree-matched');
    assert.deepEqual(s.make.writes.map(([kind, path]) => [kind, path]), [['write', 'src/App.tsx'], ['write', 'src/Card.tsx'], ['delete', 'src/old.ts'], ['save', `deploy ${sha.slice(0, 7)}`]]);
    assert.equal(s.make.saved.get('src/Card.tsx').toString(), 'export const Card = 1;\n');
    assert.ok(!s.make.saved.has('src/old.ts'));
    assert.ok(s.make.saved.has(PROJECT_MARKER), 'Make keeps its marker when main has none');

    const receipt = readReceipt(applied.receiptPath);
    assert.ok(applied.receiptPath.startsWith(join(s.p.home, '.figma-cli', 'deploys')));
    assert.equal(receipt.schema, 'figma-cli/make-deploy-receipt@1');
    for (const field of ['deployId', 'who', 'at', 'repo', 'mainCommit', 'mainTree', 'fileKey', 'makeBefore', 'makeAfter', 'planDigest', 'files', 'excluded', 'outcome', 'verification']) {
      assert.ok(field in receipt, field);
    }
    assert.equal(receipt.who, 'octo');
    assert.equal(receipt.files.find(file => file.path === 'src/App.tsx').backupPath.endsWith('original.txt'), true);

    assert.deepEqual(s.p.tags(), ['make-deploy/0']);
    assert.equal(sh(s.p.origin, 'rev-parse', 'make-deploy/0^{commit}'), sha);
    const message = sh(s.p.origin, 'cat-file', 'tag', 'make-deploy/0');
    const shared = JSON.parse(message.slice(message.indexOf('{')));
    assert.equal(shared.mainTree, sh(s.p.origin, 'rev-parse', `${sha}^{tree}`));
    assert.equal(shared.makeAfter.versionNumber, 4);
    assert.ok(!message.includes('backupPath') && !message.includes(s.p.home), 'the tag carries no local paths');

    const verified = await deployVerify(s.make, { ...s.opts, receiptPath: applied.receiptPath }, s.deps);
    assert.equal(verified.verification, 'saved-clean-tree-matched, fresh-sandbox-verified');
    assert.equal(s.make.calls.filter(([kind]) => kind === 'reload').length, 1);

    const again = await deployPlan(s.make, s.opts, s.deps);
    assert.equal(again.counts.add + again.counts.modify + again.counts.delete, 0);
    assert.equal(again.base.tag, 'make-deploy/0');
    assert.match(again.summary, /nothing to deploy/);

    const next = landChange(s, { 'src/App.tsx': 'export const App = () => "v3";\n' });
    const second = await deployPlan(s.make, s.opts, s.deps);
    assert.equal(second.tag, 'make-deploy/1');
    assert.deepEqual(second.files, [{ path: 'src/App.tsx', op: 'modify' }]);
    const done = await deployApply(s.make, { ...s.opts, planPath: second.planPath }, s.deps);
    assert.equal(done.mainCommit, next);
    assert.deepEqual(s.p.tags().sort(), ['make-deploy/0', 'make-deploy/1']);
  });

  it('skips the repo-only _vaults/ notes, applies the rest and then reads as nothing to deploy', async t => {
    const s = setup(t, { marker: false });
    const sha = landChange(s, { 'src/App.tsx': 'export const App = () => "v2";\n', '_vaults/proto/wiki/index.md': '# vault\n',
      '_vaults/proto/wiki/make/deploy.md': '# deploy notes\n' });
    const plan = await deployPlan(s.make, s.opts, s.deps);
    assert.deepEqual(plan.files, [{ path: 'src/App.tsx', op: 'modify' }]);
    assert.deepEqual(plan.excluded.filter(entry => entry.path.startsWith('_vaults/')).map(entry => [entry.path, entry.reason]),
      [['_vaults/proto/wiki/index.md', 'never deployed: project vault notes stay in the repo'], ['_vaults/proto/wiki/make/deploy.md', 'never deployed: project vault notes stay in the repo']]);
    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps);
    assert.equal(applied.outcome, 'ok');
    assert.equal(applied.mainCommit, sha);
    assert.ok(![...s.make.saved.keys()].some(path => path.startsWith('_vaults')), 'Make never gets a _vaults/ folder');
    const again = await deployPlan(s.make, s.opts, s.deps);
    assert.equal(again.counts.add + again.counts.modify + again.counts.delete, 0);
  });
  it('writes the dependency files last, package.json and then the lockfile, and waits for Make after each', async t => {
    const s = setup(t);
    landChange(s, { 'package.json': { ...PKG, dependencies: { react: '^19.0.0' } }, 'pnpm-lock.yaml': 'lockfileVersion: 9.0\nreact: 19\n', 'src/App.tsx': 'v2\n' });
    const plan = await deployPlan(s.make, s.opts, s.deps);
    assert.deepEqual(plan.files.map(file => file.path), ['src/App.tsx', 'package.json', 'pnpm-lock.yaml']);
    await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps);
    assert.deepEqual(s.make.calls.filter(([kind]) => ['write', 'idle'].includes(kind)).map(([kind, path]) => path ?? kind).filter((item, i, all) => item !== 'idle' || all[i - 1] !== 'idle'),
      ['src/App.tsx', 'package.json', 'idle', 'pnpm-lock.yaml', 'idle']);
  });

  it('deploys a main marker for this file and team mode stays on', async t => {
    const s = setup(t);
    landChange(s, { [PROJECT_MARKER]: { ...JSON.parse(MARKER), areas: { 'src/**': ['octo'] } } });
    const plan = await deployPlan(s.make, s.opts, s.deps);
    assert.deepEqual(plan.files, [{ path: PROJECT_MARKER, op: 'modify' }]);
    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps);
    assert.equal(applied.outcome, 'ok');
    assert.match(s.make.saved.get(PROJECT_MARKER).toString(), /areas/);
  });

  it('refuses Make edited since the last deploy (make-ahead), pointing to rescue', async t => {
    const s = setup(t);
    landChange(s);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps);
    s.make.working.set('src/App.tsx', Buffer.from('an edit made in Make\n'));
    s.make.commitVersion();
    landChange(s, { 'src/main.tsx': 'changed\n' });
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_MAKE_AHEAD', /make rescue/);
  });

  it('takes the base from the tagged commit and refuses a tag receipt naming another tree', async t => {
    const s = setup(t);
    const sha = landChange(s);
    const forged = `deploy\n\n${JSON.stringify({ schema: 'figma-cli/make-deploy-receipt@1', mainTree: 'b'.repeat(40) })}`;
    sh(s.p.upstream, 'tag', '-a', '-m', forged, 'make-deploy/0', sha);
    sh(s.p.upstream, 'push', '-q', 'origin', 'refs/tags/make-deploy/0');
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_MAKE_STATE', /receipt names main tree b{40}/);
    assert.deepEqual(s.make.writes, []);
  });

  it('refuses a stale plan: main moved, Make changed, or the tag number was taken', async t => {
    const s = setup(t);
    landChange(s);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    landChange(s, { 'src/main.tsx': 'newer\n' });
    await refuses(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), 'DEPLOY_MAIN_MOVED', /new dry run/);

    const m = setup(t);
    landChange(m);
    const mplan = await deployPlan(m.make, m.opts, m.deps);
    m.make.working.set('src/main.tsx', Buffer.from('saved in Make\n'));
    m.make.commitVersion();
    await refuses(deployApply(m.make, { ...m.opts, planPath: mplan.planPath }, m.deps), 'DEPLOY_STALE_PLAN');

    const c = setup(t);
    const sha = landChange(c);
    const cplan = await deployPlan(c.make, c.opts, c.deps);
    sh(c.p.upstream, 'tag', '-a', '-m', 'someone else', 'make-deploy/0', sha);
    sh(c.p.upstream, 'push', '-q', 'origin', 'refs/tags/make-deploy/0');
    await refuses(deployApply(c.make, { ...c.opts, planPath: cplan.planPath }, c.deps), 'DEPLOY_TAG_CLASH', /new dry run/);
    assert.deepEqual(c.make.writes, []);

    const tampered = setup(t);
    landChange(tampered);
    const tplan = await deployPlan(tampered.make, tampered.opts, tampered.deps);
    const body = JSON.parse(readFileSync(tplan.planPath, 'utf8'));
    body.files[0].afterSha256 = '0'.repeat(64);
    writeFileSync(tplan.planPath, JSON.stringify(body));
    await refuses(deployApply(tampered.make, { ...tampered.opts, planPath: tplan.planPath }, tampered.deps), 'DEPLOY_STALE_PLAN', /unmodified/);
  });

  it('records a tag clash after the save and plans the next deploy from that version', async t => {
    let once = true;
    const s = setup(t, { run: { onTagPush: () => {
      if (!once) return;
      once = false;
      sh(s.p.upstream, 'fetch', '-q', 'origin');
      sh(s.p.upstream, 'tag', '-a', '-m', 'raced', 'make-deploy/0', sh(s.p.upstream, 'rev-parse', 'origin/main'));
      sh(s.p.upstream, 'push', '-q', 'origin', 'refs/tags/make-deploy/0');
    } } });
    landChange(s);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    await refuses(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), 'DEPLOY_TAG_CLASH', /taken by another deploy/);
    const receipt = JSON.parse(readFileSync(join(s.p.home, '.figma-cli', 'deploys', readdirReceipt(s.p.home)), 'utf8'));
    assert.equal(receipt.stage, 'tag-clash');
    assert.equal(receipt.outcome, 'uncertain');
    const next = await deployPlan(s.make, s.opts, s.deps);
    assert.equal(next.base.source, 'receipt');
    assert.equal(next.tag, 'make-deploy/1');
  });
});

const readdirReceipt = home => readdirSync(join(home, '.figma-cli', 'deploys')).find(name => name.endsWith('.json'));

describe('make deploy recovery', () => {
  const interrupted = async t => {
    const s = setup(t);
    landChange(s);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    s.make.hooks.beforeWrite = path => { if (path === 'src/Card.tsx') throw new Error('Make operation timed out.'); };
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => {
      assert.equal(error.code, 'DEPLOY_WRITE_FAILED');
      assert.match(error.message, /--resume .* --abort/);
      receiptPath = error.receiptPath;
      return true;
    });
    s.make.hooks.beforeWrite = null;
    return { s, plan, receiptPath };
  };

  it('blocks the next dry run until an interrupted deploy is resumed, then finishes it', async t => {
    const { s, receiptPath } = await interrupted(t);
    const receipt = readReceipt(receiptPath);
    assert.equal(receipt.stage, 'writing');
    assert.deepEqual(receipt.completedWrites.map(write => write.path), ['src/App.tsx']);
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_UNFINISHED', /--resume/);
    await refuses(deployVerify(s.make, { ...s.opts, receiptPath }, s.deps), 'DEPLOY_RECEIPT', /Nothing was saved/);
    const resumed = await deployResume(s.make, { ...s.opts, receiptPath }, s.deps);
    assert.equal(resumed.outcome, 'ok');
    assert.deepEqual(s.make.writes.filter(([kind]) => kind !== 'save').map(([, path]) => path), ['src/App.tsx', 'src/Card.tsx', 'src/Card.tsx', 'src/old.ts']);
    assert.deepEqual(s.p.tags(), ['make-deploy/0']);
    await refuses(deployResume(s.make, { ...s.opts, receiptPath }, s.deps), 'DEPLOY_RECEIPT', /stage deployed/);
  });

  it('refuses to resume over content that is neither the start nor the plan', async t => {
    const { s, receiptPath } = await interrupted(t);
    s.make.working.set('src/App.tsx', Buffer.from('someone typed here\n'));
    await refuses(deployResume(s.make, { ...s.opts, receiptPath }, s.deps), 'DEPLOY_RECEIPT', /Inspect it by hand/);
    s.make.working.set('src/main.tsx', Buffer.from('outside the plan\n'));
    await refuses(deployResume(s.make, { ...s.opts, receiptPath }, s.deps), 'DEPLOY_MAKE_AHEAD');
  });

  it('aborts an interrupted deploy by restoring the written paths from backups', async t => {
    const { s, receiptPath } = await interrupted(t);
    const before = new Map(s.make.saved);
    const aborted = await deployAbort(s.make, { receiptPath }, s.deps);
    assert.equal(aborted.outcome, 'aborted');
    assert.deepEqual([...s.make.working.keys()].sort(), [...before.keys()].sort());
    for (const [path, bytes] of before) assert.ok(s.make.working.get(path).equals(bytes), path);
    assert.equal(s.make.calls.filter(([kind]) => kind === 'save').length, 0);
    const next = await deployPlan(s.make, s.opts, s.deps);
    assert.equal(next.counts.modify, 1);
  });

  it('keeps the restored list across a partial abort and its retry', async t => {
    const s = setup(t);
    landChange(s, { 'src/App.tsx': 'v2\n', 'src/Board.tsx': 'board\n', 'src/Card.tsx': 'card\n', 'src/old.ts': null });
    const plan = await deployPlan(s.make, s.opts, s.deps);
    s.make.hooks.beforeWrite = path => { if (path === 'src/old.ts') throw new Error('Make operation timed out.'); };
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => {
      receiptPath = error.receiptPath;
      return error.code === 'DEPLOY_WRITE_FAILED';
    });
    s.make.hooks.beforeWrite = path => { if (path === 'src/Card.tsx') throw new Error('Make operation timed out.'); };
    await refuses(deployAbort(s.make, { receiptPath }, s.deps), 'DEPLOY_WRITE_FAILED');
    assert.deepEqual(readReceipt(receiptPath).restored, ['src/App.tsx', 'src/Board.tsx']);
    // A previous CLI release could replace this list on the next abort run.
    const damaged = readReceipt(receiptPath);
    damaged.restored = ['src/Board.tsx'];
    writeFileSync(receiptPath, JSON.stringify(damaged));
    s.make.hooks.beforeWrite = null;
    const aborted = await deployAbort(s.make, { receiptPath }, s.deps);
    assert.equal(aborted.outcome, 'aborted');
    assert.deepEqual(new Set(readReceipt(receiptPath).restored), new Set(['src/App.tsx', 'src/Board.tsx', 'src/Card.tsx']));
    assert.equal((await s.make.projectStatus()).workingTree, readReceipt(receiptPath).makeBefore.tree);
  });

  it('does not count a path whose only apply write was uncertain and never landed as restored, and lists it apart', async t => {
    const s = setup(t);
    landChange(s, { 'src/App.tsx': 'v2\n', 'src/Board.tsx': 'board\n' });
    const plan = await deployPlan(s.make, s.opts, s.deps);
    const boardBefore = s.make.working.get('src/Board.tsx');
    s.make.hooks.beforeWrite = path => {
      if (path === 'src/Board.tsx') throw Object.assign(new Error('Make operation timed out.'), { backupPath: join(s.p.home, 'uncertain-board') });
    };
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => {
      receiptPath = error.receiptPath;
      return error.code === 'DEPLOY_WRITE_FAILED';
    });
    s.make.hooks.beforeWrite = null;
    assert.ok(readReceipt(receiptPath).completedWrites.some(write => write.path === 'src/Board.tsx' && write.uncertain));
    assert.deepEqual(s.make.working.get('src/Board.tsx'), boardBefore, 'the uncertain write never landed');
    // A previous abort run left a non-empty list, so recovery runs.
    const damaged = readReceipt(receiptPath);
    damaged.restored = ['src/App.tsx'];
    writeFileSync(receiptPath, JSON.stringify(damaged));
    const aborted = await deployAbort(s.make, { receiptPath }, s.deps);
    assert.equal(aborted.outcome, 'aborted');
    assert.deepEqual(readReceipt(receiptPath).restored, ['src/App.tsx']);
    assert.deepEqual(aborted.restoredUncertain, ['src/Board.tsx']);
  });

  it('keeps a path whose uncertain write landed and a partial abort restored, listed apart as at saved content', async t => {
    const s = setup(t);
    landChange(s, { 'src/App.tsx': 'v2\n', 'src/Board.tsx': 'board\n' });
    const plan = await deployPlan(s.make, s.opts, s.deps);
    s.make.hooks.beforeWrite = path => {
      if (path === 'src/Board.tsx') {
        s.make.working.set(path, Buffer.from('board\n'));
        throw Object.assign(new Error('Make operation timed out.'), { backupPath: join(s.p.home, 'uncertain-board') });
      }
    };
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => {
      receiptPath = error.receiptPath;
      return error.code === 'DEPLOY_WRITE_FAILED';
    });
    assert.equal(s.make.working.get('src/Board.tsx').toString(), 'board\n', 'the uncertain write landed');
    // The partial abort removes the board, then reports an error and stops.
    s.make.hooks.beforeWrite = path => {
      if (path === 'src/Board.tsx') {
        s.make.working.delete(path);
        throw new Error('Make operation timed out.');
      }
    };
    await refuses(deployAbort(s.make, { receiptPath }, s.deps), 'DEPLOY_WRITE_FAILED');
    assert.deepEqual(readReceipt(receiptPath).restored, ['src/App.tsx']);
    s.make.hooks.beforeWrite = null;
    const aborted = await deployAbort(s.make, { receiptPath }, s.deps);
    assert.equal(aborted.outcome, 'aborted');
    assert.deepEqual(readReceipt(receiptPath).restored, ['src/App.tsx']);
    assert.deepEqual(aborted.restoredUncertain, ['src/Board.tsx']);
    assert.deepEqual(readReceipt(receiptPath).restoredUncertain, ['src/Board.tsx']);
    assert.match(aborted.summary, /1 more whose write outcome is uncertain/);
    assert.equal((await s.make.projectStatus()).workingTree, readReceipt(receiptPath).makeBefore.tree);
  });

  it('waits and rechecks the plan when Make changes pending files under an abort delete', async t => {
    const s = setup(t);
    landChange(s);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    s.make.hooks.beforeWrite = path => { if (path === 'src/old.ts') throw new Error('Make operation timed out.'); };
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => {
      receiptPath = error.receiptPath;
      return error.code === 'DEPLOY_WRITE_FAILED';
    });
    let once = true;
    s.make.hooks.beforeWrite = path => {
      if (path === 'src/Card.tsx' && once) {
        once = false;
        s.make.install = () => ({ 'src/App.tsx': 'export const App = () => "v2";\n' });
        s.make.installing = true;
      }
    };
    const aborted = await deployAbort(s.make, { receiptPath }, s.deps);
    assert.equal(aborted.outcome, 'aborted');
    assert.equal(once, false);
    assert.equal((await s.make.projectStatus()).workingTree, readReceipt(receiptPath).makeBefore.tree);
    assert.ok(s.make.calls.filter(([kind, path]) => kind === 'delete' && path === 'src/Card.tsx').length >= 2);
  });

  it('reports a working-tree mismatch and leaves the abort unfinished', async t => {
    const { s, receiptPath } = await interrupted(t);
    const projectStatus = s.make.projectStatus.bind(s.make);
    s.make.projectStatus = async () => ({ ...await projectStatus(), workingTree: 'f'.repeat(40) });
    await refuses(deployAbort(s.make, { receiptPath }, s.deps), 'DEPLOY_WRITE_FAILED', /working tree f+ != saved tree/);
    const receipt = readReceipt(receiptPath);
    assert.equal(receipt.stage, 'writing');
    assert.equal(receipt.outcome, 'uncertain');
    assert.deepEqual(receipt.restored, ['src/App.tsx']);
  });

  it('refuses to abort for a caller who is not a repo admin', async t => {
    const { s, receiptPath } = await interrupted(t);
    const writes = s.make.writes.length;
    await refuses(deployAbort(s.make, { receiptPath }, { ...s.deps, gh: fakeGh({ permission: 'write' }).gh }), 'DEPLOY_NOT_ADMIN');
    assert.equal(s.make.writes.length, writes);
    assert.equal(readReceipt(receiptPath).stage, 'writing');
  });

  it('verify does not adopt a saved version that holds Make edits, and keeps the receipt blocking', async t => {
    const s = setup(t);
    landChange(s);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    s.make.hooks.save = 'uncertain';
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => {
      receiptPath = error.receiptPath;
      return error.code === 'DEPLOY_SAVE_UNCERTAIN';
    });
    s.make.hooks.save = null;
    const before = readReceipt(receiptPath);
    s.make.working.set('src/main.tsx', Buffer.from('a designer edit\n'));
    s.make.commitVersion();
    await refuses(deployVerify(s.make, { ...s.opts, receiptPath }, s.deps), 'DEPLOY_VERIFY_FAILED', /not this deploy's.*stays at stage/);
    const after = readReceipt(receiptPath);
    assert.equal(after.stage, before.stage);
    assert.equal(after.makeAfter, null);
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_UNFINISHED', /--verify/);
    assert.deepEqual(s.p.tags(), []);
  });

  it('never retries a save whose outcome is unknown; verify finalises it after a reload', async t => {
    const s = setup(t);
    landChange(s);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    s.make.hooks.save = 'uncertain';
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => {
      assert.equal(error.code, 'DEPLOY_SAVE_UNCERTAIN');
      assert.match(error.message, /Never retry the save/);
      receiptPath = error.receiptPath;
      return true;
    });
    s.make.hooks.save = null;
    assert.equal(s.make.calls.filter(([kind]) => kind === 'save').length, 1);
    await refuses(deployResume(s.make, { ...s.opts, receiptPath }, s.deps), 'DEPLOY_RECEIPT', /--verify/);
    await refuses(deployAbort(s.make, { receiptPath }, s.deps), 'DEPLOY_RECEIPT');
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_UNFINISHED', /--verify/);
    assert.deepEqual(s.p.tags(), []);
    const verified = await deployVerify(s.make, { ...s.opts, receiptPath }, s.deps);
    assert.equal(verified.outcome, 'ok');
    assert.equal(verified.makeAfter.versionNumber, 4);
    assert.match(verified.verification, /fresh-sandbox-verified/);
    assert.deepEqual(s.p.tags(), ['make-deploy/0']);
    assert.equal(s.make.calls.filter(([kind]) => kind === 'save').length, 1);
  });

  it('keeps a version Make created but did not confirm, and verify confirms it', async t => {
    const s = setup(t);
    landChange(s);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    s.make.hooks.save = 'unconfirmed';
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => {
      assert.equal(error.code, 'DEPLOY_SAVE_UNCERTAIN');
      receiptPath = error.receiptPath;
      return true;
    });
    s.make.hooks.save = null;
    assert.equal(readReceipt(receiptPath).makeAfter.versionNumber, 4);
    const verified = await deployVerify(s.make, { ...s.opts, receiptPath }, s.deps);
    assert.equal(verified.stage, 'deployed');
  });

  it('verify pushes a pending tag even after Make has changed since the checked save', async t => {
    const s = setup(t);
    landChange(s);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    let pushFails = true;
    const run = (command, args, options) => {
      if (pushFails && command === 'git' && args[0] === 'push') { pushFails = false; return { status: 1, stdout: '', stderr: 'network down' }; }
      return s.deps.run(command, args, options);
    };
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, { ...s.deps, run }), error => {
      receiptPath = error.receiptPath;
      return error.code === 'DEPLOY_TAG_FAILED';
    });
    assert.equal(readReceipt(receiptPath).stage, 'tag-pending');
    s.make.working.set('src/main.tsx', Buffer.from('a designer edit\n'));
    s.make.commitVersion();
    const verified = await deployVerify(s.make, { ...s.opts, receiptPath }, s.deps);
    assert.equal(verified.stage, 'deployed');
    assert.equal(verified.outcome, 'ok');
    assert.equal(verified.verification, 'saved-clean-tree-matched');
    assert.deepEqual(s.p.tags(), ['make-deploy/0']);
    landChange(s, { 'src/App.tsx': 'v3\n' });
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_MAKE_AHEAD', /make rescue/);
  });

  it('treats its own tag as pushed when the push reported failure after GitHub took it', async t => {
    const s = setup(t);
    landChange(s);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    let dropOnce = true;
    const run = (command, args, options) => {
      const result = s.deps.run(command, args, options);
      if (dropOnce && command === 'git' && args[0] === 'push' && result.status === 0) { dropOnce = false; return { status: 1, stdout: '', stderr: 'connection reset' }; }
      return result;
    };
    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, { ...s.deps, run });
    assert.equal(applied.stage, 'deployed');
    assert.equal(applied.outcome, 'ok');
    assert.deepEqual(s.p.tags(), ['make-deploy/0']);
  });

  it('verify finishes a tag-pending receipt whose earlier push did land', async t => {
    const s = setup(t);
    landChange(s);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    let pushes = 0;
    let hideTags = false;
    const run = (command, args, options) => {
      if (command === 'git' && args[0] === 'push' && pushes++ === 0) {
        s.deps.run(command, args, options);
        hideTags = true;
        return { status: 1, stdout: '', stderr: 'connection reset' };
      }
      if (hideTags && command === 'git' && args[0] === 'ls-remote') { hideTags = false; return { status: 0, stdout: '', stderr: '' }; }
      return s.deps.run(command, args, options);
    };
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, { ...s.deps, run }), error => {
      receiptPath = error.receiptPath;
      return error.code === 'DEPLOY_TAG_FAILED';
    });
    assert.deepEqual(s.p.tags(), ['make-deploy/0']);
    const verified = await deployVerify(s.make, { ...s.opts, receiptPath }, s.deps);
    assert.equal(verified.stage, 'deployed');
    assert.equal(verified.outcome, 'ok');
  });

  it('verify records saved-drift when Make moved past a saved version whose drift check could not run', async t => {
    const s = setup(t);
    landChange(s);
    const first = await deployPlan(s.make, s.opts, s.deps);
    await deployApply(s.make, { ...s.opts, planPath: first.planPath }, s.deps);
    landChange(s, { 'src/App.tsx': 'v3\n' });
    const plan = await deployPlan(s.make, s.opts, s.deps);
    const status = s.make.projectStatus.bind(s.make);
    s.make.projectStatus = async () => {
      if (s.make.calls.at(-1)?.[0] === 'save') { s.make.projectStatus = status; throw new Error('Make operation timed out.'); }
      return status();
    };
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => {
      receiptPath = error.receiptPath;
      return error.code === 'DEPLOY_DRIFT';
    });
    assert.equal(readReceipt(receiptPath).stage, 'saved');
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_UNFINISHED', /--verify/);
    s.make.working.set('src/main.tsx', Buffer.from('a designer edit\n'));
    s.make.commitVersion();
    await refuses(deployVerify(s.make, { ...s.opts, receiptPath }, s.deps), 'DEPLOY_VERIFY_FAILED', /moved past version/);
    const receipt = readReceipt(receiptPath);
    assert.equal(receipt.stage, 'saved-drift');
    assert.equal(receipt.outcome, 'uncertain');
    assert.equal(receipt.makeAfter.versionNumber, 5);
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_MAKE_AHEAD', /make rescue/);
    assert.deepEqual(s.p.tags(), ['make-deploy/0']);
  });

  it('reports a verify that finds Make no longer holding the deploy', async t => {
    const s = setup(t);
    landChange(s);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps);
    s.make.working.set('src/App.tsx', Buffer.from('changed later\n'));
    s.make.commitVersion();
    await refuses(deployVerify(s.make, { ...s.opts, receiptPath: applied.receiptPath }, s.deps), 'DEPLOY_VERIFY_FAILED', /no longer holds/);
    assert.equal(readReceipt(applied.receiptPath).outcome, 'ok');
  });
});

describe('make deploy with dependency changes and Make\'s own install', () => {
  const NEW_PKG = { ...PKG, dependencies: { react: '^19.0.0' } };
  // Make holds a consistent lockfile; main changes package.json, its lockfile
  // and one source file. Make's install rewrites the lockfile for whatever
  // package.json it then holds, as `install(pkg)` decides.
  const dependencyChange = (t, install = pkg => ({ 'pnpm-lock.yaml': lockFor(pkg) })) => {
    const files = { ...BASE, 'pnpm-lock.yaml': lockFor(PKG) };
    const s = setup(t, { files });
    s.make.install = install;
    landChange(s, { 'package.json': NEW_PKG, 'pnpm-lock.yaml': lockFor(NEW_PKG), 'src/App.tsx': 'v2\n' });
    return s;
  };
  const lock = s => s.make.working.get('pnpm-lock.yaml').toString();

  it('completes a deploy whose lockfile write makes Make reinstall and revert the lockfile', async t => {
    const s = dependencyChange(t);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps);
    assert.equal(applied.outcome, 'ok');
    assert.equal(s.make.saved.get('pnpm-lock.yaml').toString(), lockFor(NEW_PKG));
    assert.equal(s.make.saved.get('package.json').toString(), text(NEW_PKG));
    assert.deepEqual(s.make.calls.filter(([kind]) => kind === 'save').length, 1);
    const verified = await deployVerify(s.make, { ...s.opts, receiptPath: applied.receiptPath }, s.deps);
    assert.match(verified.summary, /Verified after a fresh reload/);
  });

  it('waits and re-checks when Make\'s install lands under a write, then retries that path', async t => {
    const s = dependencyChange(t);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    // A reaction lands while src/App.tsx is written: the listed pending set
    // changes (package.json) and the lockfile is neither main's nor Make's.
    let once = true;
    s.make.hooks.beforeWrite = path => {
      if (path === 'src/App.tsx' && once) {
        once = false;
        s.make.install = () => ({ 'package.json': NEW_PKG, 'pnpm-lock.yaml': 'regenerated by Make\n' });
        s.make.installing = true;
      }
      else s.make.install = pkg => ({ 'pnpm-lock.yaml': lockFor(pkg) });
    };
    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps);
    assert.equal(applied.outcome, 'ok');
    assert.deepEqual(s.make.writes.filter(([kind]) => kind === 'write').map(([, path]) => path),
      ['src/App.tsx', 'src/App.tsx', 'package.json', 'pnpm-lock.yaml', 'pnpm-lock.yaml']);
    assert.equal(s.make.saved.get('package.json').toString(), text(NEW_PKG));
    assert.equal(s.make.saved.get('pnpm-lock.yaml').toString(), lockFor(NEW_PKG));
  });

  it('writes a regenerated lockfile again once Make is idle, and stops when Make keeps changing it', async t => {
    // Make resolves the new package.json to a lockfile other than main's.
    const s = dependencyChange(t, pkg => ({ 'pnpm-lock.yaml': pkg.equals(Buffer.from(text(NEW_PKG))) ? `${lockFor(pkg)}# make resolved\n` : lockFor(pkg) }));
    const plan = await deployPlan(s.make, s.opts, s.deps);
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => {
      assert.equal(error.code, 'DEPLOY_WRITE_FAILED', error.message);
      assert.match(error.message, /keeps changing \["pnpm-lock\.yaml"\]/);
      receiptPath = error.receiptPath;
      return true;
    });
    assert.equal(s.make.calls.filter(([kind]) => kind === 'save').length, 0, 'never saves');
    assert.ok(s.make.writes.filter(([, path]) => path === 'pnpm-lock.yaml').length > 2, 'the lockfile was written again');
    assert.equal(readReceipt(receiptPath).stage, 'written');
    // Abort restores everything, including the lockfile Make regenerated.
    const aborted = await deployAbort(s.make, { receiptPath }, s.deps);
    assert.equal(aborted.outcome, 'aborted');
    for (const [path, bytes] of s.make.saved) assert.ok(s.make.working.get(path).equals(bytes), path);
  });

  // The Hinge failure: the lockfile was written, Make's install regenerated
  // it, and a later write stopped. Nothing was saved.
  const regeneratedAfterStop = async t => {
    const s = dependencyChange(t, null);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    s.make.hooks.beforeWrite = path => {
      if (path === 'package.json') {
        s.make.working.set('pnpm-lock.yaml', Buffer.from('regenerated by Make\n'));
        throw new Error('Make operation timed out.');
      }
    };
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => {
      assert.equal(error.code, 'DEPLOY_WRITE_FAILED', error.message);
      receiptPath = error.receiptPath;
      return true;
    });
    s.make.hooks.beforeWrite = null;
    assert.equal(lock(s), 'regenerated by Make\n');
    return { s, receiptPath };
  };

  it('aborts over a planned lockfile Make regenerated, restoring it from its backup', async t => {
    const { s, receiptPath } = await regeneratedAfterStop(t);
    const aborted = await deployAbort(s.make, { receiptPath }, s.deps);
    assert.equal(aborted.outcome, 'aborted');
    assert.deepEqual([...s.make.working.keys()].sort(), [...s.make.saved.keys()].sort());
    for (const [path, bytes] of s.make.saved) assert.ok(s.make.working.get(path).equals(bytes), path);
    assert.ok(readReceipt(receiptPath).restored.includes('pnpm-lock.yaml'));
  });

  it('restores package.json before the lockfile and waits out both install reactions', async t => {
    const s = dependencyChange(t);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    s.make.hooks.beforeWrite = path => { if (path === 'pnpm-lock.yaml') throw new Error('Make operation timed out.'); };
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => {
      receiptPath = error.receiptPath;
      return error.code === 'DEPLOY_WRITE_FAILED';
    });
    s.make.hooks.beforeWrite = null;
    const start = s.make.calls.length;
    const aborted = await deployAbort(s.make, { receiptPath }, s.deps);
    assert.equal(aborted.outcome, 'aborted');
    assert.deepEqual(s.make.calls.slice(start).filter(([kind]) => kind === 'write').map(([, path]) => path),
      ['src/App.tsx', 'package.json', 'pnpm-lock.yaml']);
    assert.equal((await s.make.projectStatus()).workingTree, readReceipt(receiptPath).makeBefore.tree);
    assert.equal(s.make.calls.filter(([kind]) => kind === 'save').length, 0);
  });

  it('records a lockfile restore whose write landed before it reported an error', async t => {
    const s = dependencyChange(t);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    s.make.hooks.beforeWrite = path => { if (path === 'pnpm-lock.yaml') throw new Error('Make operation timed out.'); };
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => {
      receiptPath = error.receiptPath;
      return error.code === 'DEPLOY_WRITE_FAILED';
    });
    s.make.hooks.beforeWrite = path => {
      if (path === 'pnpm-lock.yaml') {
        s.make.working.set(path, s.make.saved.get(path));
        throw new Error('Make operation timed out.');
      }
    };
    const aborted = await deployAbort(s.make, { receiptPath }, s.deps);
    assert.equal(aborted.outcome, 'aborted');
    assert.equal(lock(s), s.make.saved.get('pnpm-lock.yaml').toString());
    assert.deepEqual(new Set(readReceipt(receiptPath).restored), new Set(['src/App.tsx', 'package.json', 'pnpm-lock.yaml']));
  });

  it('resumes over a planned lockfile Make regenerated', async t => {
    const { s, receiptPath } = await regeneratedAfterStop(t);
    const resumed = await deployResume(s.make, { ...s.opts, receiptPath }, s.deps);
    assert.equal(resumed.outcome, 'ok');
    assert.equal(s.make.saved.get('pnpm-lock.yaml').toString(), lockFor(NEW_PKG));
    assert.equal(s.make.saved.get('package.json').toString(), text(NEW_PKG));
  });

  it('resumes over a lockfile Make\'s install already set to main\'s, writing it through the client', async t => {
    const s = dependencyChange(t);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    s.make.hooks.beforeWrite = path => { if (path === 'pnpm-lock.yaml') throw new Error('Make operation timed out.'); };
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => {
      assert.equal(error.code, 'DEPLOY_WRITE_FAILED', error.message);
      receiptPath = error.receiptPath;
      return true;
    });
    s.make.hooks.beforeWrite = null;
    assert.equal(lock(s), lockFor(NEW_PKG));
    assert.ok(!s.make.clientWrote.has('pnpm-lock.yaml'));
    const resumed = await deployResume(s.make, { ...s.opts, receiptPath }, s.deps);
    assert.equal(resumed.outcome, 'ok');
    assert.equal(s.make.saved.get('pnpm-lock.yaml').toString(), lockFor(NEW_PKG));
    assert.equal(s.make.saved.get('package.json').toString(), text(NEW_PKG));
  });

  it('names an unbacked lockfile that keeps the working tree different, and finishes once Make holds the saved lockfile', async t => {
    const s = dependencyChange(t);
    s.make.saved.set('package.json', Buffer.from(text(NEW_PKG)));
    s.make.working = new Map(s.make.saved);
    s.make.working.set('pnpm-lock.yaml', Buffer.from(lockFor(NEW_PKG)));
    const plan = await deployPlan(s.make, s.opts, s.deps);
    s.make.hooks.beforeWrite = path => { if (path === 'pnpm-lock.yaml') throw new Error('Make operation timed out.'); };
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => { receiptPath = error.receiptPath; return true; });
    s.make.hooks.beforeWrite = null;
    assert.ok(!readReceipt(receiptPath).completedWrites.some(write => write.path === 'pnpm-lock.yaml'), 'main\'s lockfile is not backed up as the original');
    const status = await s.make.projectStatus();
    const message = new RegExp(`differs from saved tree ${readReceipt(receiptPath).makeBefore.tree} in pnpm-lock\\.yaml \\(working sha256 ${status.workingSha256.get('pnpm-lock.yaml')}, ` +
      `saved blob ${status.makeFlat.get('pnpm-lock.yaml').blob}\\)\\. The receipt has no backup of it.*check make status\\. If the lockfile still differs, restore saved version .* from Make's version history; do not edit the lockfile by hand\\. Once the lockfile matches the saved version again, run --abort once more to close the receipt\\.`);
    for (let run = 1; run <= 2; run++) {
      await assert.rejects(deployAbort(s.make, { receiptPath }, s.deps), error => {
        assert.equal(error.code, 'DEPLOY_WRITE_FAILED');
        assert.match(error.message, message);
        assert.doesNotMatch(error.message, /Run --abort again/);
        return true;
      });
    }
    assert.equal(readReceipt(receiptPath).stage, 'writing');
    assert.deepEqual(readReceipt(receiptPath).restored, ['src/App.tsx']);
    assert.equal(lock(s), lockFor(NEW_PKG));
    for (const [path, bytes] of s.make.saved) if (path !== 'pnpm-lock.yaml') assert.ok(s.make.working.get(path).equals(bytes), path);
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_UNFINISHED');
    s.make.working.set('pnpm-lock.yaml', s.make.saved.get('pnpm-lock.yaml'));
    const aborted = await deployAbort(s.make, { receiptPath }, s.deps);
    assert.equal(aborted.outcome, 'aborted');
    assert.equal((await s.make.projectStatus()).workingTree, readReceipt(receiptPath).makeBefore.tree);
  });

  it('still refuses unplanned content in a non-dependency file, a path outside the plan, or a lockfile with no backup', async t => {
    const { s, receiptPath } = await regeneratedAfterStop(t);
    s.make.working.set('src/App.tsx', Buffer.from('someone typed here\n'));
    await refuses(deployAbort(s.make, { receiptPath }, s.deps), 'DEPLOY_RECEIPT', /neither started from nor planned in \["src\/App\.tsx"\]/);
    await refuses(deployResume(s.make, { ...s.opts, receiptPath }, s.deps), 'DEPLOY_RECEIPT', /Inspect it by hand/);
    s.make.working.set('src/App.tsx', Buffer.from('v2\n'));
    s.make.working.set('src/main.tsx', Buffer.from('outside the plan\n'));
    await refuses(deployAbort(s.make, { receiptPath }, s.deps), 'DEPLOY_MAKE_AHEAD');
    await refuses(deployResume(s.make, { ...s.opts, receiptPath }, s.deps), 'DEPLOY_MAKE_AHEAD');

    // The lockfile's start was backed up before any write; without that
    // backup abort refuses rather than guess.
    const n = dependencyChange(t, null);
    const plan = await deployPlan(n.make, n.opts, n.deps);
    n.make.hooks.beforeWrite = path => { if (path === 'src/App.tsx') throw new Error('Make operation timed out.'); };
    let early;
    await assert.rejects(deployApply(n.make, { ...n.opts, planPath: plan.planPath }, n.deps), error => { early = error.receiptPath; return true; });
    n.make.hooks.beforeWrite = null;
    assert.ok(readReceipt(early).completedWrites.some(write => write.path === 'pnpm-lock.yaml' && write.backupOnly));
    rmSync(join(n.p.home, '.figma-cli', 'deploys', 'backups'), { recursive: true, force: true });
    n.make.working.set('pnpm-lock.yaml', Buffer.from('regenerated by Make\n'));
    const writes = n.make.writes.length;
    await refuses(deployAbort(n.make, { receiptPath: early }, n.deps), 'DEPLOY_RECEIPT', /No backup of pnpm-lock\.yaml/);
    assert.equal(n.make.writes.length, writes, 'nothing was changed');
  });

  it('plans from a version that kept the old lockfile while Make\'s install holds main\'s, and saves it through the client', async t => {
    const s = dependencyChange(t);
    // Make saved main's package.json with the old lockfile; its install then
    // put main's lockfile in the working copy, unsaved and unlisted.
    s.make.saved.set('package.json', Buffer.from(text(NEW_PKG)));
    s.make.saved.set('src/App.tsx', Buffer.from('v2\n'));
    s.make.working = new Map(s.make.saved);
    s.make.working.set('pnpm-lock.yaml', Buffer.from(lockFor(NEW_PKG)));
    const plan = await deployPlan(s.make, s.opts, s.deps);
    assert.deepEqual(plan.files, [{ path: 'pnpm-lock.yaml', op: 'modify' }]);
    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps);
    assert.equal(applied.outcome, 'ok');
    assert.equal(s.make.saved.get('pnpm-lock.yaml').toString(), lockFor(NEW_PKG));
    // Any other lockfile content in the working copy is still an edit.
    const other = dependencyChange(t);
    other.make.working.set('pnpm-lock.yaml', Buffer.from('typed in Make\n'));
    await refuses(deployPlan(other.make, other.opts, other.deps), 'DEPLOY_MAKE_AHEAD', /pnpm-lock\.yaml/);
  });

  it('stops when Make\'s reaction under a write changes a path outside the plan', async t => {
    const s = dependencyChange(t);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    s.make.hooks.beforeWrite = path => {
      if (path === 'src/App.tsx') { s.make.install = () => ({ 'src/main.tsx': 'changed by Make\n' }); s.make.installing = true; }
    };
    await refuses(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), 'DEPLOY_MAKE_AHEAD', /outside the deploy \["src\/main\.tsx"\]/);
    assert.equal(s.make.calls.filter(([kind]) => kind === 'save').length, 0);
  });
});

// The LMA shape: main carries repo-only development files, Make carries
// Make-only template files at the root, and main's deploy ignore list names both.
const MAKE_ONLY = { 'AGENTS.md': '# Make agent notes\n', 'CLAUDE.md': '# Make claude notes\n', '.gitattributes': '* text=auto\n', '.mise.toml': '[tools]\n' };
const REPO_DEV = { 'README.md': '# proto\n', 'playwright.config.ts': 'export default {};\n', 'playwright.pages.config.ts': 'export default {};\n',
  'docs/guide.md': '# guide\n', 'docs/deep/notes.md': '# notes\n', 'scripts/check.sh': 'echo ok\n', 'tests/app.spec.ts': 'test();\n' };
const IGNORE = '# Repo-only development files\n/docs/\n/scripts/\n/tests/\n/README.md\n/playwright*.config.ts\n\n' +
  '# Make-only template files\n/.gitattributes\n/.mise.toml\n/AGENTS.md\n/CLAUDE.md\n';
const ignoredSetup = t => setup(t, { makeFiles: { ...BASE, ...MAKE_ONLY } });

describe('make deploy ignore list', () => {
  it('matches gitignore-style patterns on a path or any of its folders, and always the list itself', () => {
    const ignored = ignoreMatcher(ignorePatterns(Buffer.from(IGNORE)));
    for (const path of ['docs/guide.md', 'docs/deep/notes.md', 'tests/app.spec.ts', 'README.md', 'playwright.config.ts', 'playwright.shell.config.ts',
      'AGENTS.md', '.mise.toml', DEPLOY_IGNORE]) assert.equal(ignored(path), true, path);
    for (const path of ['src/docs/x.md', 'src/README.md', 'src/AGENTS.md', 'docsite/a.md', 'package.json', 'src/App.tsx', PROJECT_MARKER]) {
      assert.equal(ignored(path), false, path);
    }
    const unanchored = ignoreMatcher(['docs/', '*.md', '!keep.md']);
    assert.equal(unanchored('src/docs/a.ts'), true);
    assert.equal(unanchored('src/keep.md'), false);
    assert.equal(ignoreMatcher([])('docs/a.md'), false);
    assert.throws(() => ignorePatterns(Buffer.from([0xff, 0xfe, 0x00])), error => error.code === 'DEPLOY_IGNORE');
  });

  it('reads a list saved with a UTF-8 byte order mark', () => {
    const patterns = ignorePatterns(Buffer.from(`\uFEFF/docs/\n/AGENTS.md\n`));
    assert.deepEqual(patterns, ['/docs/', '/AGENTS.md']);
    assert.equal(ignoreMatcher(patterns)('docs/guide.md'), true);
    assert.deepEqual(ignorePatterns(Buffer.from(`\uFEFF# comment\n/docs/\n`)), ['/docs/']);
  });

  it('never writes or deletes Make\'s own .figma/make config or files under .figma/design-context', async t => {
    const MAKE_CONFIG = { '.figma/make/dev.json': '{"dev":1}\n', '.figma/make/site.json': '{"site":1}\n' };
    const s = setup(t, { makeFiles: { ...BASE, ...MAKE_CONFIG } });
    landChange(s, { '.figma/design-context/x.json': '{"x":1}\n', 'src/App.tsx': 'v2\n' });
    const plan = await deployPlan(s.make, s.opts, s.deps);
    assert.deepEqual(plan.files, [{ path: 'src/App.tsx', op: 'modify' }]);
    const reason = path => plan.excluded.find(entry => entry.path === path)?.reason;
    for (const path of Object.keys(MAKE_CONFIG)) assert.match(reason(path), /Make manages its own config/, path);
    assert.match(reason('.figma/design-context/x.json'), /never deployed/);
    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps);
    assert.equal(applied.outcome, 'ok');
    assert.ok(!s.make.writes.some(([, path]) => String(path).startsWith('.figma/')), 'nothing under .figma is written or deleted');
    for (const [path, content] of Object.entries(MAKE_CONFIG)) assert.equal(s.make.saved.get(path).toString(), content, `Make keeps ${path}`);
    assert.equal(s.make.saved.has('.figma/design-context/x.json'), false);
    const verified = await deployVerify(s.make, { ...s.opts, receiptPath: applied.receiptPath }, s.deps);
    assert.equal(verified.verification, 'saved-clean-tree-matched, fresh-sandbox-verified');
  });

  it('refuses the LMA shape without a list, exactly as before', async t => {
    const s = ignoredSetup(t);
    landChange(s, { ...REPO_DEV, 'src/App.tsx': 'v2\n' });
    await assert.rejects(deployPlan(s.make, s.opts, s.deps), error => {
      assert.equal(error.code, 'DEPLOY_UNSUPPORTED_PATH');
      assert.deepEqual(error.paths, [...Object.keys(MAKE_ONLY), ...Object.keys(REPO_DEV)].sort());
      return true;
    });
    assert.deepEqual(s.make.writes, []);
  });

  it('plans, applies, verifies and redeploys with excluded paths left as they are on each side', async t => {
    const s = ignoredSetup(t);
    const sha = landChange(s, { ...REPO_DEV, [DEPLOY_IGNORE]: IGNORE, 'src/App.tsx': 'v2\n', 'src/old.ts': null });
    const plan = await deployPlan(s.make, s.opts, s.deps);
    assert.deepEqual(plan.files, [{ path: 'src/App.tsx', op: 'modify' }, { path: 'src/old.ts', op: 'delete' }]);
    assert.equal(plan.excludedCount, 12);
    assert.deepEqual(plan.excluded.map(entry => entry.path), [DEPLOY_IGNORE, ...Object.keys(MAKE_ONLY), ...Object.keys(REPO_DEV)].sort());
    const reason = path => plan.excluded.find(entry => entry.path === path).reason;
    assert.match(reason('docs/guide.md'), /stays in the repo, never created in Make/);
    assert.match(reason('AGENTS.md'), /Make keeps its own, never deleted/);
    assert.match(reason(DEPLOY_IGNORE), /ignore list stays in the repo/);
    assert.equal(plan.ignore.path, DEPLOY_IGNORE);
    assert.ok(plan.ignore.patterns.includes('/docs/') && !plan.ignore.patterns.some(line => line.startsWith('#')));
    assert.match(plan.summary, /12 excluded path\(s\) stay as they are on each side/);

    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps);
    assert.equal(applied.outcome, 'ok');
    assert.equal(applied.excludedCount, 12);
    assert.deepEqual(s.make.writes.map(([kind, path]) => [kind, path]), [['write', 'src/App.tsx'], ['delete', 'src/old.ts'], ['save', `deploy ${sha.slice(0, 7)}`]]);
    for (const [path, content] of Object.entries(MAKE_ONLY)) assert.equal(s.make.saved.get(path).toString(), content, `Make keeps ${path}`);
    assert.ok(![...s.make.saved.keys()].some(path => path in REPO_DEV || path === DEPLOY_IGNORE), 'Make never gets repo-only files');
    const receipt = readReceipt(applied.receiptPath);
    assert.equal(receipt.excludedCount, 12);
    assert.equal(receipt.excluded.length, 12);
    const message = sh(s.p.origin, 'cat-file', 'tag', 'make-deploy/0');
    assert.equal(JSON.parse(message.slice(message.indexOf('{'))).excludedCount, 12);

    const verified = await deployVerify(s.make, { ...s.opts, receiptPath: applied.receiptPath }, s.deps);
    assert.equal(verified.verification, 'saved-clean-tree-matched, fresh-sandbox-verified');

    // The tag's tree holds docs/ and no AGENTS.md: still not make-ahead.
    const again = await deployPlan(s.make, s.opts, s.deps);
    assert.equal(again.base.tag, 'make-deploy/0');
    assert.equal(again.counts.add + again.counts.modify + again.counts.delete, 0);
    assert.match(again.summary, /nothing to deploy\. 12 excluded/);
    landChange(s, { 'src/App.tsx': 'v3\n', 'docs/guide.md': '# guide v2\n', 'tests/more.spec.ts': 'more();\n' });
    const second = await deployPlan(s.make, s.opts, s.deps);
    assert.deepEqual(second.files, [{ path: 'src/App.tsx', op: 'modify' }]);
    const done = await deployApply(s.make, { ...s.opts, planPath: second.planPath }, s.deps);
    assert.equal(done.tag.name, 'make-deploy/1');
  });

  it('still refuses every unsupported path the list does not name', async t => {
    const s = ignoredSetup(t);
    landChange(s, { ...REPO_DEV, [DEPLOY_IGNORE]: '/docs/\n/AGENTS.md\n', 'NOTES.md': '# root\n', 'tools/run.ts': 'x\n' });
    await assert.rejects(deployPlan(s.make, s.opts, s.deps), error => {
      assert.equal(error.code, 'DEPLOY_UNSUPPORTED_PATH');
      assert.deepEqual(error.paths, ['.gitattributes', '.mise.toml', 'CLAUDE.md', 'NOTES.md', 'README.md', 'playwright.config.ts',
        'playwright.pages.config.ts', 'scripts/check.sh', 'tests/app.spec.ts', 'tools/run.ts']);
      return true;
    });
    const bad = ignoredSetup(t);
    landChange(bad, { [DEPLOY_IGNORE]: Buffer.from([0xff, 0xfe, 0x00]) });
    await refuses(deployPlan(bad.make, bad.opts, bad.deps), 'DEPLOY_IGNORE', /not UTF-8/);
    assert.deepEqual([...s.make.writes, ...bad.make.writes], []);
  });

  it('meets the guards again when main drops a pattern after a deploy', async t => {
    const s = ignoredSetup(t);
    landChange(s, { ...REPO_DEV, [DEPLOY_IGNORE]: IGNORE, 'src/App.tsx': 'v2\n' });
    const plan = await deployPlan(s.make, s.opts, s.deps);
    await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps);
    landChange(s, { [DEPLOY_IGNORE]: IGNORE.replace('/AGENTS.md\n', '') });
    // AGENTS.md was outside the last deploy, so it is not make-ahead; deleting it is a root delete.
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_UNSUPPORTED_PATH', /\["AGENTS\.md"\]/);
  });

  it('resumes an interrupted deploy and checks drift without the excluded paths', async t => {
    const s = ignoredSetup(t);
    landChange(s, { ...REPO_DEV, [DEPLOY_IGNORE]: IGNORE, 'src/App.tsx': 'v2\n', 'src/Card.tsx': 'card\n' });
    const plan = await deployPlan(s.make, s.opts, s.deps);
    s.make.hooks.beforeWrite = path => { if (path === 'src/Card.tsx') throw new Error('Make operation timed out.'); };
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => { receiptPath = error.receiptPath; return error.code === 'DEPLOY_WRITE_FAILED'; });
    s.make.hooks.beforeWrite = null;
    const resumed = await deployResume(s.make, { ...s.opts, receiptPath }, s.deps);
    assert.equal(resumed.stage, 'deployed');
    const receipt = readReceipt(receiptPath);
    const status = await s.make.projectStatus();
    const mainFlat = new Map([...status.makeFlat, ...Object.keys(REPO_DEV).map(path => [path, { mode: '100644', blob: 'f'.repeat(40) }])]);
    for (const path of Object.keys(MAKE_ONLY)) mainFlat.delete(path);
    assert.deepEqual(driftProblems(status, receipt, mainFlat), []);
    // A Make-only file the list names, added later, is outside the check too; any other path is not.
    for (const flat of [status.makeFlat, status.workingFlat]) flat.set('scripts/later.sh', { mode: '100644', blob: 'e'.repeat(40) });
    assert.deepEqual(driftProblems(status, receipt, mainFlat), []);
    for (const flat of [status.makeFlat, status.workingFlat]) flat.set('src/extra.ts', { mode: '100644', blob: 'e'.repeat(40) });
    assert.match(driftProblems(status, receipt, mainFlat).join(), /src\/extra\.ts/);
  });
});

// The LMA deploy (figma-cli 8c9f907): Make's only public/ file is deleted
// while main adds files below public/. Run first, that delete dropped public/
// from Make's tree and every later public/ create refused.
describe('make deploy across a top-level folder it empties', () => {
  const FONT = { 'public/fonts/OFL.txt': 'SIL Open Font License\n', 'public/fonts/inter.css': '@font-face { font-family: Inter; }\n' };
  const CHANGE = { '.github/workflows/build.yml': 'on: push\n', 'src/App.tsx': 'export const App = () => "v2";\n', 'public/favicon.svg': null, ...FONT };
  const start = t => {
    const s = setup(t, { files: { ...BASE, 'public/favicon.svg': '<svg/>\n' } });
    landChange(s, CHANGE);
    return s;
  };
  // The receipt 8c9f907 left: its order ran the delete before the public/
  // adds, and the first of those refused once public/ was gone.
  const lmaReceipt = async t => {
    const s = start(t);
    const plan = await deployPlan(s.make, s.opts, s.deps);
    s.make.hooks.beforeWrite = () => { throw new Error('stopped before the old write order'); };
    let receiptPath;
    await assert.rejects(deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps), error => { receiptPath = error.receiptPath; return true; });
    s.make.hooks.beforeWrite = null;
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const backupDir = join(s.p.home, '.figma-cli', 'deploys', 'backups', receipt.deployId);
    const done = [];
    for (const path of ['.github/workflows/build.yml', 'src/App.tsx', 'public/favicon.svg']) {
      const file = receipt.plan.files.find(item => item.path === path);
      const result = file.op === 'delete'
        ? await s.make.deleteDurable(path, { expectedSha256: file.beforeSha256, backupDir })
        : await s.make.writeDurable(path, CHANGE[path], { expectedSha256: file.beforeSha256 ?? undefined, backupDir });
      done.push({ path, op: file.op, backupPath: result.backupPath ?? null });
    }
    await assert.rejects(s.make.writeDurable('public/fonts/OFL.txt', FONT['public/fonts/OFL.txt'], { backupDir }),
      /cannot prove public\/fonts\/OFL\.txt absent: only files below an existing top-level folder/);
    receipt.completedWrites = done;
    receipt.error = 'Make cannot prove public/fonts/OFL.txt absent: only files below an existing top-level folder can be created or deleted.';
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    assert.ok(![...s.make.working.keys()].some(path => path.startsWith('public/')));
    return { s, receiptPath };
  };

  it('applies the adds below the folder before deleting its only file, and keeps dependency files last', async t => {
    const s = start(t);
    const pkg = `${JSON.stringify({ ...PKG, version: '2.0.0' }, null, 2)}\n`;
    s.p.land({ 'package.json': pkg });
    s.p.pull();
    const plan = await deployPlan(s.make, s.opts, s.deps);
    assert.deepEqual(plan.counts, { add: 3, modify: 2, delete: 1 });
    const applied = await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps);
    assert.equal(applied.stage, 'deployed');
    assert.deepEqual(s.make.writes.filter(([kind]) => kind !== 'save').map(([kind, path]) => `${kind} ${path}`), [
      'write .github/workflows/build.yml', 'write public/fonts/OFL.txt', 'write public/fonts/inter.css', 'write src/App.tsx',
      'delete public/favicon.svg', 'write package.json']);
    assert.deepEqual([...s.make.saved.keys()].filter(path => path.startsWith('public/')).sort(), Object.keys(FONT).sort());
  });

  it('resumes the receipt whose delete emptied the folder and creates every file below it', async t => {
    const { s, receiptPath } = await lmaReceipt(t);
    const before = s.make.writes.length;
    const resumed = await deployResume(s.make, { ...s.opts, receiptPath }, s.deps);
    assert.equal(resumed.outcome, 'ok');
    assert.deepEqual(s.make.writes.slice(before).filter(([kind]) => kind !== 'save').map(([kind, path]) => `${kind} ${path}`),
      ['write public/fonts/OFL.txt', 'write public/fonts/inter.css']);
    for (const [path, content] of Object.entries(FONT)) assert.equal(s.make.saved.get(path).toString(), content);
    assert.equal(s.make.saved.has('public/favicon.svg'), false);
    assert.deepEqual(s.p.tags(), ['make-deploy/0']);
    assert.equal((await deployVerify(s.make, { ...s.opts, receiptPath }, s.deps)).outcome, 'ok');
  });

  it('aborts the receipt, restoring the deleted file into the emptied folder before the adds go', async t => {
    const { s, receiptPath } = await lmaReceipt(t);
    const before = s.make.writes.length;
    const aborted = await deployAbort(s.make, { receiptPath }, s.deps);
    assert.equal(aborted.outcome, 'aborted');
    assert.deepEqual(s.make.writes.slice(before).map(([kind, path]) => `${kind} ${path}`),
      ['write public/favicon.svg', 'write src/App.tsx', 'delete .github/workflows/build.yml']);
    assert.deepEqual(s.make.changed(), []);
    assert.equal(s.make.calls.filter(([kind]) => kind === 'save').length, 0);
  });

  it('still refuses a new top-level folder and a new root file the saved base does not hold', async t => {
    const s = start(t);
    await assert.rejects(s.make.writeDurable('docs/probe.md', 'x\n', { baseFolders: ['public', 'src'] }), /cannot prove docs\/probe\.md absent/);
    await assert.rejects(s.make.writeDurable('NOTES.md', 'x\n', { baseFolders: ['NOTES.md'] }), /cannot prove NOTES\.md absent/);
    s.p.land({ 'docs/guide.md': 'guide\n' });
    s.p.pull();
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_UNSUPPORTED_PATH', /docs\/guide\.md/);
  });
});
