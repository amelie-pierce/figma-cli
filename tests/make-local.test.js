import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkToolchain, cloneProject, defaultRun, detectPackageManager, devCommand, findLocalUrl, kitRefusal,
  makeKitDependencies, npmrcTokenWarnings, pullProject, resolveCloneRepo, runDev, satisfies, toolchainExpectations } from '../src/make-local.js';
import { markerContent } from '../src/make-mode.js';

// Local git only: a bare "origin" in a temp folder stands in for GitHub, and
// installs and gh are faked. Nothing here reaches Figma, GitHub or a registry.
const KEY = 'ExactKey';
const REPO = 'owner/proto';
const PKG = { name: 'app', private: true, scripts: { dev: 'vite' }, dependencies: { react: '^19.0.0' } };

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'figma-cli-make-local-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const config = mkdtempSync(join(tmpdir(), 'figma-cli-make-local-git-'));
writeFileSync(join(config, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
const env = { GIT_CONFIG_GLOBAL: join(config, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
Object.assign(process.env, env);
process.on('exit', () => rmSync(config, { recursive: true, force: true }));

const sh = (dir, ...args) => {
  const result = defaultRun('git', args, { cwd: dir });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}
function commit(dir, files, message = 'change') {
  write(dir, files);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', message);
  return sh(dir, 'rev-parse', 'HEAD');
}
// origin (bare) + an upstream working copy that pushes to it.
function remote(t, files = { 'package.json': PKG, 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n' }) {
  const root = temp(t);
  const origin = join(root, 'origin.git');
  const upstream = join(root, 'upstream');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'init', '-q', '-b', 'main', upstream);
  commit(upstream, files, 'initial');
  sh(upstream, 'push', '-q', origin, 'main');
  return { root, origin, upstream };
}
// The fake runner: real git; gh repo clone becomes a local git clone of
// origin; tool versions and installs are recorded instead of run.
function fakeRun({ origin, versions = { node: '22.12.0', pnpm: '10.34.3' }, installStatus = 0 } = {}) {
  const calls = [];
  const run = (command, args, options = {}) => {
    calls.push({ command, args, cwd: options.cwd });
    if (command === 'git') return defaultRun(command, args, options);
    if (command === 'gh') {
      assert.deepEqual(args.slice(0, 2), ['repo', 'clone']);
      const sep = args.indexOf('--');
      return defaultRun('git', ['clone', '-q', ...args.slice(sep + 1), origin, args[3]], options);
    }
    if (args[0] === '--version') return versions[command] ? { status: 0, stdout: `${versions[command]}\n`, stderr: '' } : { status: 127, stdout: '', stderr: '' };
    return { status: installStatus, stdout: '', stderr: '' };
  };
  return { run, calls, installs: () => calls.filter(call => call.args[0] !== '--version' && !['git', 'gh'].includes(call.command)) };
}
const code = (fn, expected) => assert.throws(fn, error => { assert.equal(error.code, expected, error.message); return true; });

describe('make clone: repo resolution', () => {
  it('takes an explicit owner/repo', () => {
    assert.deepEqual(resolveCloneRepo({ repo: REPO }), { repo: REPO, source: 'argument' });
    assert.throws(() => resolveCloneRepo({ repo: 'no-slash' }), /owner\/repo/);
  });
  it('takes the repo from a valid team marker for the open file', () => {
    assert.deepEqual(resolveCloneRepo({ fileKey: KEY, markerBytes: Buffer.from(markerContent(KEY, REPO)) }),
      { repo: REPO, source: 'marker', fileKey: KEY });
  });
  it('refuses no marker, another file\'s marker, an invalid marker, a non-main trunk and both sources', () => {
    code(() => resolveCloneRepo({}), 'MAKE_CLONE_NO_REPO');
    code(() => resolveCloneRepo({ fileKey: KEY, markerBytes: null }), 'MAKE_CLONE_NO_REPO');
    code(() => resolveCloneRepo({ fileKey: KEY, markerBytes: Buffer.from(markerContent('Other', REPO)) }), 'MAKE_CLONE_NO_REPO');
    code(() => resolveCloneRepo({ fileKey: KEY, markerBytes: Buffer.from('{') }), 'MAKE_CLONE_NO_REPO');
    code(() => resolveCloneRepo({ fileKey: KEY, markerBytes: Buffer.from(JSON.stringify({ fileKey: KEY, repo: REPO, trunk: 'develop' })) }), 'MAKE_CLONE_NO_REPO');
    assert.throws(() => resolveCloneRepo({ repo: REPO, fileKey: KEY }), /not both/);
  });
});

describe('make kits, .npmrc and toolchain checks', () => {
  it('finds @make-kits dependencies in every dependency field and kit attachments', () => {
    assert.deepEqual(makeKitDependencies(PKG), []);
    assert.deepEqual(makeKitDependencies({ dependencies: { '@make-kits/atomicaui-7-0': '1.0.1' }, devDependencies: { '@make-kits/b': '1' },
      figma: { kitAttachments: { '@make-kits/c': {} } } }), ['@make-kits/atomicaui-7-0', '@make-kits/b', '@make-kits/c']);
    const message = kitRefusal(['@make-kits/atomicaui-7-0']);
    for (const part of [/@make-kits\/atomicaui-7-0/, /only inside Make/, /Nothing was installed/, /pull request/, /VENDOR\.json/, /~\/\.npmrc, never in the repo/, /never copied/]) {
      assert.match(message, part);
    }
  });
  it('warns on a committed .npmrc credential by path and line, never the value', t => {
    const dir = temp(t);
    write(dir, { '.npmrc': '# _authToken=commented\n@make-kits:registry=https://example.invalid/\n//example.invalid/:_authToken=SECRETVALUE\n',
      'packages/a/.npmrc': '_auth = SECRETVALUE2\n', 'notes.txt': '_authToken=x\n' });
    const warnings = npmrcTokenWarnings(dir, ['.npmrc', 'packages/a/.npmrc', 'notes.txt', 'missing/.npmrc']);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /^\.npmrc:3 holds a registry credential/);
    assert.match(warnings[1], /^packages\/a\/\.npmrc:1 /);
    assert.ok(warnings.every(w => !w.includes('SECRETVALUE')));
    assert.deepEqual(npmrcTokenWarnings(dir, ['notes.txt']), []);
  });
  it('requires pnpm-lock.yaml and refuses a packageManager other than pnpm', t => {
    const dir = temp(t);
    write(dir, { 'package-lock.json': '{}', 'yarn.lock': '' });
    code(() => detectPackageManager(dir, PKG), 'MAKE_NO_LOCKFILE');
    write(dir, { 'pnpm-lock.yaml': '' });
    assert.deepEqual(detectPackageManager(dir, PKG), { name: 'pnpm', lockfile: 'pnpm-lock.yaml', version: null });
    assert.equal(detectPackageManager(dir, { packageManager: 'pnpm@10.34.3+sha512.abc' }).version, '10.34.3');
    for (const packageManager of ['yarn@1.22.0', 'npm@10.9.0', 'bun@1.1.0', 'pnpm']) {
      assert.throws(() => detectPackageManager(dir, { packageManager }), error => error.code === 'MAKE_NO_LOCKFILE' && /install with pnpm/.test(error.message));
    }
  });
  it('reads .mise.toml and engines, warns on mismatches and fails without the package manager', t => {
    const dir = temp(t);
    write(dir, { '.mise.toml': '[tools]\nnode = "22"\n"npm:pnpm" = "10.34.3"\n\n[env]\nnode = "x"\n' });
    const pm = { name: 'pnpm', version: null };
    const expected = toolchainExpectations(dir, { engines: { node: '>=18' } }, pm);
    assert.deepEqual(expected.map(({ tool, range, source }) => `${tool} ${range} ${source}`),
      ['node 22 .mise.toml', 'pnpm 10.34.3 .mise.toml', 'node >=18 package.json engines']);
    assert.deepEqual(checkToolchain(expected, { node: '22.12.0', pnpm: '10.34.3' }, pm), []);
    const warnings = checkToolchain(expected, { node: '24.15.0', pnpm: '10.33.2' }, pm);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /expects node 22; you have 24\.15\.0/);
    code(() => checkToolchain(expected, { node: '22.1.0', pnpm: null }, pm), 'MAKE_TOOLCHAIN_MISSING');
  });
  it('understands the common version range forms', () => {
    const cases = [['22.1.0', '22', true], ['24.0.0', '22', false], ['22.1.0', '>=18', true], ['16.0.0', '>=18', false],
      ['10.34.3', '10.34.3', true], ['10.34.2', '10.34.3', false], ['18.2.0', '^18.1', true], ['19.0.0', '^18', false],
      ['18.2.5', '~18.2.1', true], ['20.1.0', '20.x', true], ['20.1.0', '>=18 <20', false], ['20.1.0', '^18 || ^20', true],
      ['20.1.0', 'lts/*', null]];
    for (const [version, range, expected] of cases) assert.equal(satisfies(version, range), expected, `${version} ${range}`);
  });
});

describe('make clone', () => {
  it('clones main with gh, checks, and installs with a frozen lockfile and --ignore-scripts', t => {
    const { root, origin } = remote(t, { 'package.json': PKG, 'pnpm-lock.yaml': 'v\n', '.mise.toml': '[tools]\nnode = "22"\n' });
    const fake = fakeRun({ origin });
    const result = cloneProject({ repo: REPO, dir: 'work' }, { run: fake.run, cwd: root });
    const gh = fake.calls.find(call => call.command === 'gh');
    assert.deepEqual(gh.args, ['repo', 'clone', REPO, join(root, 'work'), '--', '--branch', 'main']);
    assert.equal(result.branch, 'main');
    assert.equal(result.install.command, 'pnpm install --frozen-lockfile --ignore-scripts');
    assert.deepEqual(fake.installs().map(call => [call.command, ...call.args].join(' ')), ['pnpm install --frozen-lockfile --ignore-scripts']);
    const versionChecks = fake.calls.filter(call => call.args[0] === '--version');
    assert.ok(versionChecks.length && versionChecks.every(call => call.cwd === join(root, 'work')));
  });
  it('refuses a clone without pnpm-lock.yaml before installing', t => {
    const { root, origin } = remote(t, { 'package.json': PKG, 'package-lock.json': '{}\n' });
    const fake = fakeRun({ origin });
    code(() => cloneProject({ repo: REPO }, { run: fake.run, cwd: root }), 'MAKE_NO_LOCKFILE');
    assert.deepEqual(fake.installs(), []);
  });
  it('stops before installing on a @make-kits dependency and says how to fix it', t => {
    const kitPkg = { ...PKG, dependencies: { ...PKG.dependencies, '@make-kits/atomicaui-7-0': '1.0.1' } };
    const { root, origin } = remote(t, { 'package.json': kitPkg, 'pnpm-lock.yaml': 'v\n' });
    const fake = fakeRun({ origin });
    assert.throws(() => cloneProject({ repo: REPO }, { run: fake.run, cwd: root }), error => {
      assert.equal(error.code, 'MAKE_KIT_DEPENDENCY');
      assert.equal(error.dir, join(root, 'proto'));
      assert.match(error.message, /^Cloned owner\/proto to .* at main [0-9a-f]{7}, but did not install\. .*@make-kits\/atomicaui-7-0/);
      return true;
    });
    assert.deepEqual(fake.installs(), []);
  });
  it('warns on a committed .npmrc token and still never copies one', t => {
    const { root, origin } = remote(t, { 'package.json': PKG, 'pnpm-lock.yaml': 'v\n', '.npmrc': '//r.invalid/:_authToken=abc\n' });
    const warnings = [];
    const result = cloneProject({ repo: REPO }, { run: fakeRun({ origin }).run, cwd: root, warn: w => warnings.push(w) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\.npmrc:1 holds a registry credential/);
    assert.deepEqual(result.install.warnings, warnings);
    assert.ok(!warnings[0].includes('abc'));
  });
  it('refuses a non-empty target and a missing package manager', t => {
    const { root, origin } = remote(t);
    write(root, { 'busy/file.txt': 'x' });
    code(() => cloneProject({ repo: REPO, dir: 'busy' }, { run: fakeRun({ origin }).run, cwd: root }), 'MAKE_CLONE_TARGET_EXISTS');
    code(() => cloneProject({ repo: REPO, dir: 'nopnpm' }, { run: fakeRun({ origin, versions: { node: '22.0.0' } }).run, cwd: root }), 'MAKE_TOOLCHAIN_MISSING');
  });
});

describe('make pull', () => {
  function cloned(t, files) {
    const r = remote(t, files);
    const work = join(r.root, 'work');
    sh(r.root, 'clone', '-q', '--branch', 'main', r.origin, work);
    mkdirSync(join(work, 'node_modules'));
    return { ...r, work };
  }
  const push = (r, files) => { const sha = commit(r.upstream, files); sh(r.upstream, 'push', '-q', r.origin, 'main'); return sha; };

  it('reports up to date and changes nothing', t => {
    const r = cloned(t);
    const fake = fakeRun({ origin: r.origin });
    const result = pullProject(r.work, { run: fake.run });
    assert.equal(result.updated, false);
    assert.deepEqual(fake.installs(), []);
  });
  it('fast-forwards main without a reinstall when the lockfile is unchanged', t => {
    const r = cloned(t);
    const sha = push(r, { 'src/App.tsx': 'export default 1\n' });
    const fake = fakeRun({ origin: r.origin });
    const result = pullProject(r.work, { run: fake.run });
    assert.equal(result.updated, true);
    assert.equal(result.lockfileChanged, false);
    assert.equal(result.reinstalled, false);
    assert.equal(sh(r.work, 'rev-parse', 'HEAD'), sha);
    assert.deepEqual(fake.installs(), []);
  });
  it('reinstalls with --ignore-scripts only when the lockfile changed', t => {
    const r = cloned(t);
    push(r, { 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n# changed\n' });
    const fake = fakeRun({ origin: r.origin });
    const result = pullProject(r.work, { run: fake.run });
    assert.equal(result.lockfileChanged, true);
    assert.equal(result.reinstalled, true);
    assert.deepEqual(fake.installs().map(call => [call.command, ...call.args].join(' ')), ['pnpm install --frozen-lockfile --ignore-scripts']);
  });
  it('fast-forwards, then refuses the reinstall when main gained a @make-kits dependency', t => {
    const r = cloned(t);
    push(r, { 'package.json': { ...PKG, dependencies: { '@make-kits/k': '1' } }, 'pnpm-lock.yaml': 'kit\n' });
    const fake = fakeRun({ origin: r.origin });
    assert.throws(() => pullProject(r.work, { run: fake.run }), error => error.code === 'MAKE_KIT_DEPENDENCY' && /Fast-forwarded main by 1/.test(error.message));
    assert.deepEqual(fake.installs(), []);
  });
  it('refuses local commits on main and changes nothing', t => {
    const r = cloned(t);
    push(r, { 'a.txt': 'remote\n' });
    const local = commit(r.work, { 'b.txt': 'local\n' });
    code(() => pullProject(r.work, { run: fakeRun({ origin: r.origin }).run }), 'MAKE_PULL_LOCAL_COMMITS');
    assert.equal(sh(r.work, 'rev-parse', 'HEAD'), local);
  });
  it('refuses uncommitted tracked changes on main', t => {
    const r = cloned(t);
    push(r, { 'a.txt': 'remote\n' });
    writeFileSync(join(r.work, 'package.json'), '{"edited":true}\n');
    code(() => pullProject(r.work, { run: fakeRun({ origin: r.origin }).run }), 'MAKE_PULL_DIRTY');
  });
  it('on a task branch, moves only the local main ref', t => {
    const r = cloned(t);
    sh(r.work, 'checkout', '-q', '-b', 'task');
    const branchHead = commit(r.work, { 'mine.txt': 'x\n' });
    const sha = push(r, { 'pnpm-lock.yaml': 'changed\n' });
    const fake = fakeRun({ origin: r.origin });
    const result = pullProject(r.work, { run: fake.run });
    assert.equal(result.updated, true);
    assert.equal(result.reinstalled, false);
    assert.equal(sh(r.work, 'rev-parse', 'refs/heads/main'), sha);
    assert.equal(sh(r.work, 'rev-parse', 'HEAD'), branchHead);
    assert.deepEqual(fake.installs(), []);
  });
  it('refuses a folder that is not a clone', t => {
    code(() => pullProject(temp(t), { run: fakeRun({}).run }), 'MAKE_NOT_A_CLONE');
  });
});

describe('make dev', () => {
  it('finds the local URL in dev server output', () => {
    assert.equal(findLocalUrl('  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n'), 'http://localhost:5173/');
    assert.equal(findLocalUrl('Network: use --host to expose'), null);
    assert.equal(findLocalUrl('ready on http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  });
  it('runs pnpm run dev from scripts.dev and refuses without one', () => {
    assert.deepEqual(devCommand(PKG), { command: 'pnpm', args: ['run', 'dev'], source: 'package.json scripts.dev' });
    code(() => devCommand({ scripts: {} }), 'MAKE_NO_DEV_SCRIPT');
    code(() => devCommand({}), 'MAKE_NO_DEV_SCRIPT');
  });
  it('mirrors output, prints the URL once, forwards signals and returns the exit code', async t => {
    const dir = temp(t);
    write(dir, { 'package.json': PKG, 'pnpm-lock.yaml': '' });
    code(() => runDev(dir, { spawnFn: () => assert.fail('must not start') }), 'MAKE_NOT_INSTALLED');
    mkdirSync(join(dir, 'node_modules'));
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: [] });
    child.kill = signal => child.killed.push(signal);
    let spawned;
    const out = [];
    const err = [];
    const signals = new EventEmitter();
    const done = runDev(dir, { spawnFn: (command, args, options) => { spawned = { command, args, cwd: options.cwd, stdio: options.stdio }; return child; },
      out: { write: c => out.push(String(c)) }, err: { write: c => err.push(String(c)) }, signals });
    assert.deepEqual(spawned, { command: 'pnpm', args: ['run', 'dev'], cwd: dir, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.emit('data', Buffer.from('  Local:   http://localhost:5'));
    child.stderr.emit('data', Buffer.from('warn\n'));
    child.stdout.emit('data', Buffer.from('173/\n'));
    child.stdout.emit('data', Buffer.from('again http://localhost:5173/\n'));
    signals.emit('SIGINT');
    assert.deepEqual(child.killed, ['SIGINT']);
    child.emit('exit', 0, null);
    const result = await done;
    assert.equal(result.url, 'http://localhost:5173/');
    assert.equal(result.code, 0);
    assert.equal(out.join(''), '  Local:   http://localhost:5173/\nagain http://localhost:5173/\n');
    assert.equal(err.join('').includes('warn\n'), true);
    assert.equal(err.filter(line => line.includes('local URL')).length, 1);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.ok(existsSync(join(dir, 'package.json')) && readFileSync(join(dir, 'package.json'), 'utf8').includes('vite'));
  });
});
