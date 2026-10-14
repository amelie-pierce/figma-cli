import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBlobSha, gitTreeSha } from '../src/git-tree.js';
import { deployAbort, deployApply, deployPlan, deployResume, deployVerify, readReceipt } from '../src/make-deploy.js';
import { markerContent } from '../src/make-mode.js';
import { PROJECT_MARKER } from '../src/make-project.js';
import { defaultRun } from '../src/make-team.js';

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

// A stateful Make: saved and working files, the listed pending set (Make does
// not list dot-folder paths), versions, private backups and failure hooks.
class FakeMake {
  constructor(files, { marker = true } = {}) {
    this.fileKey = KEY;
    this.saved = new Map(Object.entries({ ...files, ...(marker ? { [PROJECT_MARKER]: MARKER } : {}) }).map(([p, c]) => [p, Buffer.from(text(c))]));
    this.working = new Map(this.saved);
    this.version = 3;
    this.savedVersion = 'a'.repeat(40);
    this.calls = [];
    this.ui = { busy: false };
    this.hooks = {};
    this.hasBaseline = true;
    this.generating = false;
  }
  flat(files) { return new Map([...files].map(([path, bytes]) => [path, { mode: '100644', blob: gitBlobSha(bytes) }])); }
  tree(files) { return gitTreeSha([...this.flat(files)].map(([path, entry]) => ({ path, ...entry }))); }
  changed() {
    return [...new Set([...this.saved.keys(), ...this.working.keys()])]
      .filter(path => !(this.saved.has(path) && this.working.has(path) && this.saved.get(path).equals(this.working.get(path)))).sort();
  }
  pending() { return this.changed().filter(path => !path.split('/').some(part => part.startsWith('.'))); }
  async inspect() { return { fileKey: KEY, ...this.ui }; }
  async projectMarker() { return this.working.get(PROJECT_MARKER) ?? null; }
  async projectStatus() {
    this.calls.push(['status']);
    const pendingPaths = this.pending();
    return {
      persistence: { mode: 'git', hasBaseline: this.hasBaseline, savedVersion: this.hasBaseline ? this.savedVersion : null,
        pendingCount: pendingPaths.length, pendingPaths, isLoading: false, error: false },
      history: { generationInProgress: this.generating, latest: { versionNumber: this.version, gitSha: this.savedVersion } },
      head: this.savedVersion, treeSource: this.hasBaseline ? 'saved-version' : 'sandbox-head',
      makeFlat: this.flat(this.saved), workingFlat: this.flat(this.working), makeTree: this.tree(this.saved), workingTree: this.tree(this.working),
      workingSha256: new Map([...this.working].map(([path, bytes]) => [path, sha256(bytes)])),
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
  async writeDurable(path, content, { expectedSha256, backupDir } = {}) {
    this.calls.push(['write', path]);
    this.hooks.beforeWrite?.(path);
    const current = this.working.get(path);
    if ((current != null) !== (expectedSha256 != null)) throw new Error('Expected SHA-256 is required for an existing file and forbidden for a new file.');
    if (current && sha256(current) !== expectedSha256) throw new Error('Make source changed; SHA-256 does not match.');
    const backupPath = current ? this.backup(path, current, backupDir) : null;
    this.working.set(path, Buffer.from(content));
    return { path, changed: true, backupPath };
  }
  async deleteDurable(path, { expectedSha256, backupDir } = {}) {
    this.calls.push(['delete', path]);
    this.hooks.beforeWrite?.(path);
    const current = this.working.get(path);
    if (!current || sha256(current) !== expectedSha256) throw new Error('Make source is missing or changed; delete refused.');
    const backupPath = this.backup(path, current, backupDir);
    this.working.delete(path);
    return { path, backupPath };
  }
  commitVersion() {
    this.saved = new Map(this.working);
    this.version += 1;
    this.savedVersion = sha256(`v${this.version}`).slice(0, 40);
    return { versionId: `id-${this.version}`, versionNumber: this.version, gitSha: this.savedVersion, tree: this.tree(this.saved) };
  }
  async saveCheckedVersion(title, expectedPaths, { listed } = {}) {
    this.calls.push(['save', title, [...expectedPaths].sort()]);
    assert.equal(listed, true);
    const others = this.pending().filter(path => !expectedPaths.includes(path));
    if (others.length) throw new Error(`Make lists other pending changes ${JSON.stringify(others)}`);
    assert.deepEqual(this.changed(), [...expectedPaths].sort());
    if (this.hooks.save === 'uncertain') {
      this.commitVersion();
      const error = new Error('Make version outcome is uncertain: socket closed. Inspect versions before retrying.');
      error.createVersionCalled = true;
      throw error;
    }
    const version = this.commitVersion();
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
  const deps = { run: run.run, gh: gh.gh, home: p.home, install: install ?? (() => {}), now: () => new Date('2026-10-15T01:02:03.000Z') };
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

describe('make deploy guards', () => {
  it('refuses a solo file, which has nothing to deploy from', async t => {
    const s = setup(t, { make: { marker: false } });
    await refuses(deployPlan(s.make, s.opts, s.deps), 'DEPLOY_SOLO', /solo mode.*nothing to deploy/);
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

  it('writes the lockfile first and package.json last, so Make\'s own reinstall finds them consistent', async t => {
    const s = setup(t);
    landChange(s, { 'package.json': { ...PKG, dependencies: { react: '^19.0.0' } }, 'pnpm-lock.yaml': 'lockfileVersion: 9.0\nreact: 19\n', 'src/App.tsx': 'v2\n' });
    const plan = await deployPlan(s.make, s.opts, s.deps);
    assert.deepEqual(plan.files.map(file => file.path), ['pnpm-lock.yaml', 'src/App.tsx', 'package.json']);
    await deployApply(s.make, { ...s.opts, planPath: plan.planPath }, s.deps);
    assert.deepEqual(s.make.writes.filter(([kind]) => kind === 'write').map(([, path]) => path), ['pnpm-lock.yaml', 'src/App.tsx', 'package.json']);
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
