import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseMarker, PROJECT_MARKER, repoName } from './make-project.js';

// Running a team-mode Make project locally: `make clone`, `make install`,
// `make pull` and `make dev`. GitHub `main` is the source of truth; these
// commands clone it with the caller's own gh login, install with a frozen
// lockfile and --ignore-scripts, fast-forward main only and start the dev
// server. figma-cli stores no tokens and never copies Make's .npmrc.

export const TRUNK = 'main';
export const LOCAL_CODES = Object.freeze(['MAKE_KIT_DEPENDENCY', 'MAKE_CLONE_NO_REPO', 'MAKE_CLONE_TARGET_EXISTS', 'MAKE_TOOLCHAIN_MISSING',
  'MAKE_NO_LOCKFILE', 'MAKE_INSTALL_FAILED', 'MAKE_PULL_LOCAL_COMMITS', 'MAKE_PULL_DIRTY', 'MAKE_PULL_NOT_FAST_FORWARD',
  'MAKE_NOT_A_CLONE', 'MAKE_NO_DEV_SCRIPT', 'MAKE_NOT_INSTALLED']);
const fail = (message, code) => { const error = new Error(message); if (code) error.code = code; throw error; };

// The repo to clone: an explicit owner/repo, or the repo the Make file's team
// marker names. A marker for another file, or an unreadable one, is refused.
export function resolveCloneRepo({ repo, fileKey, markerBytes } = {}) {
  if (repo != null && fileKey != null) fail('Pass either owner/repo or --file, not both.');
  if (repo != null) return { repo: repoName(repo), source: 'argument' };
  if (fileKey == null) fail('Name the repo as owner/repo, or pass --file <makeKey> to read it from the Make file\'s team marker.', 'MAKE_CLONE_NO_REPO');
  const marker = parseMarker(markerBytes, fileKey);
  if (marker.state === 'absent') {
    fail(`Make file ${fileKey} has no ${PROJECT_MARKER}, so it is not in team mode and names no repo. Pass owner/repo instead.`, 'MAKE_CLONE_NO_REPO');
  }
  if (marker.state !== 'valid') fail(`Cannot take the repo from ${PROJECT_MARKER}: ${marker.reason}.`, 'MAKE_CLONE_NO_REPO');
  if (marker.trunk !== TRUNK) fail(`${PROJECT_MARKER} names trunk ${marker.trunk}; figma-cli clones and pulls ${TRUNK} only.`, 'MAKE_CLONE_NO_REPO');
  return { repo: marker.repo, source: 'marker', fileKey };
}

export function readPackage(dir) {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) fail(`${path} is missing; this is not a Make project clone.`, 'MAKE_NOT_A_CLONE');
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail(`${path} is not valid JSON: ${error.message}`, 'MAKE_NOT_A_CLONE'); }
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
// Kits attached in Make's UI add @make-kits/* packages that resolve only
// through Make's own registry (scratch test T10: ERR_PNPM_FETCH_404 locally).
export function makeKitDependencies(pkg) {
  const names = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(pkg?.[field] || {})) if (name.startsWith('@make-kits/')) names.add(name);
  }
  for (const name of Object.keys(pkg?.figma?.kitAttachments || {})) if (name.startsWith('@make-kits/')) names.add(name);
  return [...names].sort();
}

export function kitRefusal(names) {
  return `This project depends on ${names.join(', ')}, a kit attached in Figma Make. ` +
    'Kit packages install only inside Make, from Figma\'s own registry, so a local install fails. Nothing was installed. ' +
    'Fix: vendor the kit\'s source into the repo through a pull request (src/vendor/<kit>/ pinned by VENDOR.json) and remove the ' +
    '@make-kits dependency, then run figma-cli make pull or figma-cli make install. Or ask Figma for registry access and put that token in your own ~/.npmrc, never in the repo. ' +
    'Make\'s .npmrc is managed by Figma and is never copied out of Make.';
}

export function requireNoKitDependencies(pkg) {
  const kits = makeKitDependencies(pkg);
  if (kits.length) fail(kitRefusal(kits), 'MAKE_KIT_DEPENDENCY');
}

// A committed .npmrc must never carry registry credentials. Report the path
// and line only, never the value.
const TOKEN_LINE = /(^|[:\s])(_authToken|_auth|_password)\s*=/;
export function npmrcTokenWarnings(dir, files) {
  const warnings = [];
  for (const path of files) {
    if (basename(path) !== '.npmrc') continue;
    const full = join(dir, path);
    if (!existsSync(full)) continue;
    readFileSync(full, 'utf8').split(/\r?\n/).forEach((line, index) => {
      if (!line.trim().startsWith('#') && !line.trim().startsWith(';') && TOKEN_LINE.test(line)) {
        warnings.push(`${path}:${index + 1} holds a registry credential in the repo. Remove it from git, revoke it, and keep tokens in your own ~/.npmrc.`);
      }
    });
  }
  return warnings;
}

const LOCKFILE = 'pnpm-lock.yaml';
const INSTALL = ['pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']];

// Make projects install with pnpm. A packageManager naming anything else, or
// a missing pnpm-lock.yaml, is refused.
export function detectPackageManager(dir, pkg) {
  const declared = pkg?.packageManager == null ? null : /^pnpm(?:@([^+\s]+)|$)/.exec(String(pkg.packageManager));
  if (pkg?.packageManager != null && !declared) {
    fail(`package.json packageManager is ${pkg.packageManager}, but Make projects install with pnpm. Switch it to pnpm through a pull request.`, 'MAKE_NO_LOCKFILE');
  }
  if (!existsSync(join(dir, LOCKFILE))) {
    fail(`The repo has no ${LOCKFILE}, so it cannot be installed reproducibly with pnpm. Add one through a pull request.`, 'MAKE_NO_LOCKFILE');
  }
  return { name: 'pnpm', lockfile: LOCKFILE, version: declared?.[1] ?? null };
}

// Expected tool versions from .mise.toml [tools], package.json engines and
// packageManager. Only the simple forms Make writes are parsed.
export function toolchainExpectations(dir, pkg, pm) {
  const expected = [];
  const mise = join(dir, '.mise.toml');
  if (existsSync(mise)) {
    let section = '';
    for (const raw of readFileSync(mise, 'utf8').split(/\r?\n/)) {
      const line = raw.replace(/#.*/, '').trim();
      const header = /^\[(.+)\]$/.exec(line);
      if (header) { section = header[1].trim(); continue; }
      const entry = /^"?([^"=]+?)"?\s*=\s*"([^"]+)"$/.exec(line);
      if (section !== 'tools' || !entry) continue;
      const tool = entry[1].replace(/^npm:/, '');
      if (['node', 'pnpm'].includes(tool)) expected.push({ tool, range: entry[2], source: '.mise.toml' });
    }
  }
  for (const [tool, range] of Object.entries(pkg?.engines || {})) {
    if (['node', 'pnpm'].includes(tool) && typeof range === 'string') expected.push({ tool, range, source: 'package.json engines' });
  }
  if (pm?.version) expected.push({ tool: pm.name, range: pm.version, source: 'package.json packageManager' });
  return expected;
}

const parts = version => String(version).replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10));
const compare = (a, b) => {
  for (let i = 0; i < 3; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; }
  return 0;
};
// true, false, or null when the range form is not understood.
export function satisfies(version, range) {
  const v = parts(version);
  if (v.some(Number.isNaN)) return null;
  const one = clause => {
    const c = clause.trim();
    if (!c || c === '*' || c === 'latest' || c === 'lts') return true;
    let m = /^(>=|>|<=|<|=)?\s*v?(\d+(?:\.\d+){0,2})$/.exec(c);
    if (m && m[1]) {
      const d = compare(v, parts(m[2]));
      return { '>=': d >= 0, '>': d > 0, '<=': d <= 0, '<': d < 0, '=': d === 0 }[m[1]];
    }
    if (m) { const want = parts(m[2]); return want.every((n, i) => v[i] === n); }
    m = /^\^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(c);
    if (m) return v[0] === Number(m[1]) && compare(v, parts(c.slice(1))) >= 0;
    m = /^~v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(c);
    if (m) return v[0] === Number(m[1]) && v[1] === Number(m[2]) && compare(v, parts(c.slice(1))) >= 0;
    m = /^v?(\d+)(?:\.(\d+))?\.x$/.exec(c);
    if (m) return v[0] === Number(m[1]) && (m[2] == null || v[1] === Number(m[2]));
    return null;
  };
  const alternatives = String(range).split('||').map(alt => alt.trim().split(/\s+/).map(one));
  if (alternatives.some(all => all.every(result => result === true))) return true;
  return alternatives.some(all => all.includes(null)) ? null : false;
}

// Compare expectations with the tools on PATH. A missing package manager
// fails; a version mismatch only warns, since Make's own pins are exact.
export function checkToolchain(expected, actual, pm) {
  const warnings = [];
  if (!actual[pm.name]) {
    fail(`${pm.name} is not installed, and this project installs with it. Install ${pm.name}${pm.version ? ` ${pm.version}` : ''} ` +
      '(for example with mise install, or corepack enable), then retry.', 'MAKE_TOOLCHAIN_MISSING');
  }
  for (const { tool, range, source } of expected) {
    if (!actual[tool]) { warnings.push(`${source} expects ${tool} ${range}, but ${tool} is not installed.`); continue; }
    const ok = satisfies(actual[tool], range);
    if (ok === false) warnings.push(`${source} expects ${tool} ${range}; you have ${actual[tool]}. If the install or dev server misbehaves, switch versions (for example mise install).`);
    if (ok === null) warnings.push(`${source} expects ${tool} ${range}; you have ${actual[tool]} (range not checked).`);
  }
  return warnings;
}

// Run a command and capture its output. `stdio: 'stderr'` streams it to
// stderr instead, so the JSON report on stdout stays clean.
export function defaultRun(command, args, { cwd, stream = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false,
    stdio: stream ? ['ignore', process.stderr, process.stderr] : ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (result.error?.code === 'ENOENT') return { status: 127, stdout: '', stderr: `${command}: not found` };
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

export function toolVersions(run, tools, { cwd } = {}) {
  const versions = {};
  for (const tool of new Set(tools)) {
    const result = run(tool, ['--version'], { cwd });
    versions[tool] = result.status === 0 ? (/(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? null) : null;
  }
  return versions;
}

function git(run, dir, args, what) {
  const result = run('git', args, { cwd: dir });
  if (result.status !== 0) fail(`${what || `git ${args[0]}`} failed: ${(result.stderr || result.stdout).trim().split('\n').pop() || 'unknown error'}`);
  return result.stdout.trim();
}

// Committed credentials are reported first, so every later refusal
// (package.json, lockfile, toolchain, kits) still shows them.
export function install(dir, { run = defaultRun, warn = () => {} } = {}) {
  const tracked = run('git', ['ls-files', '-z'], { cwd: dir });
  const files = tracked.status === 0 ? tracked.stdout.split('\0').filter(Boolean) : ['.npmrc'];
  const warnings = npmrcTokenWarnings(dir, files);
  warnings.forEach(warn);
  const pkg = readPackage(dir);
  const pm = detectPackageManager(dir, pkg);
  const expected = toolchainExpectations(dir, pkg, pm);
  const toolchain = toolVersions(run, ['node', pm.name, ...expected.map(e => e.tool)], { cwd: dir });
  const toolWarnings = checkToolchain(expected, toolchain, pm);
  toolWarnings.forEach(warn);
  warnings.push(...toolWarnings);
  requireNoKitDependencies(pkg);
  const [command, args] = INSTALL;
  const result = run(command, args, { cwd: dir, stream: true });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed (exit ${result.status}); see its output above.`, 'MAKE_INSTALL_FAILED');
  return { packageManager: pm.name, lockfile: pm.lockfile, command: [command, ...args].join(' '), toolchain, warnings };
}

// gh repo clone with the caller's own gh login, always at main.
export function cloneProject({ repo, dir, source = 'argument', fileKey }, { run = defaultRun, warn = () => {}, cwd = process.cwd() } = {}) {
  repoName(repo);
  const target = resolve(cwd, dir || repo.split('/')[1]);
  if (existsSync(target) && (!statSync(target).isDirectory() || readdirSync(target).length)) {
    fail(`${target} already exists and is not empty. Pick another folder, or run figma-cli make pull inside it.`, 'MAKE_CLONE_TARGET_EXISTS');
  }
  const cloned = run('gh', ['repo', 'clone', repo, target, '--', '--branch', TRUNK], { cwd, stream: true });
  if (cloned.status !== 0) fail(`gh repo clone ${repo} failed (exit ${cloned.status}). Check gh auth status and that ${repo} has a ${TRUNK} branch.`);
  const branch = git(run, target, ['symbolic-ref', '--short', 'HEAD']);
  if (branch !== TRUNK) fail(`The clone is on ${branch}, not ${TRUNK}.`);
  const head = git(run, target, ['rev-parse', 'HEAD']);
  const summary = { repo, source, ...(fileKey ? { fileKey } : {}), dir: target, branch, head };
  try { return { ...summary, install: install(target, { run, warn }) }; }
  catch (error) {
    error.message = `Cloned ${repo} to ${target} at ${TRUNK} ${head.slice(0, 7)}, but did not install. ${error.message}`;
    error.dir = target;
    throw error;
  }
}

export function repoRoot(dir, { run = defaultRun } = {}) {
  const result = run('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
  if (result.status !== 0) fail(`${dir} is not inside a git clone. Run figma-cli make clone first.`, 'MAKE_NOT_A_CLONE');
  return result.stdout.trim();
}

const blobAt = (run, dir, rev, path) => {
  const result = run('git', ['rev-parse', '--verify', '--quiet', `${rev}:${path}`], { cwd: dir });
  return result.status === 0 ? result.stdout.trim() : null;
};

// Fetch main and fast-forward the local main only. Refuses local commits on
// main (they belong on a task branch) and a dirty checkout of main.
export function pullProject(dir, { run = defaultRun, warn = () => {} } = {}) {
  const root = repoRoot(dir, { run });
  git(run, root, ['fetch', '--quiet', 'origin', `+refs/heads/${TRUNK}:refs/remotes/origin/${TRUNK}`], `git fetch origin ${TRUNK}`);
  const remote = git(run, root, ['rev-parse', `refs/remotes/origin/${TRUNK}`]);
  const local = run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${TRUNK}`], { cwd: root }).stdout.trim() || null;
  const branchResult = run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root });
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : null;
  const summary = { dir: root, branch, before: local, after: remote };
  if (!local) {
    git(run, root, ['update-ref', `refs/heads/${TRUNK}`, remote, ''.padEnd(40, '0')], `create local ${TRUNK}`);
    return { ...summary, updated: true, reinstalled: false, note: `Created local ${TRUNK} at origin/${TRUNK}; your checkout was not changed.` };
  }
  const ahead = Number(git(run, root, ['rev-list', '--count', `${remote}..${local}`]));
  if (ahead > 0) {
    fail(`Local ${TRUNK} has ${ahead} commit(s) that are not on GitHub ${TRUNK}. make pull only fast-forwards ${TRUNK} and changed nothing. ` +
      `Move that work onto a task branch and open a pull request (the planned figma-cli team sync will do this for you).`, 'MAKE_PULL_LOCAL_COMMITS');
  }
  const behind = Number(git(run, root, ['rev-list', '--count', `${local}..${remote}`]));
  if (behind === 0) return { ...summary, updated: false, reinstalled: false, note: `${TRUNK} is up to date.` };
  if (branch !== TRUNK) {
    git(run, root, ['update-ref', `refs/heads/${TRUNK}`, remote, local], `fast-forward ${TRUNK}`);
    return { ...summary, updated: true, commits: behind, reinstalled: false,
      note: `Fast-forwarded ${TRUNK} by ${behind} commit(s). You are on ${branch || 'a detached HEAD'}, which was not changed and needs no reinstall.` };
  }
  const dirty = git(run, root, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) {
    fail(`${TRUNK} has uncommitted changes to tracked files, so make pull changed nothing. Commit them on a task branch or discard them, then retry.`, 'MAKE_PULL_DIRTY');
  }
  const lockBefore = blobAt(run, root, 'HEAD', LOCKFILE);
  const merged = run('git', ['merge', '--ff-only', '--quiet', remote], { cwd: root });
  if (merged.status !== 0) fail(`git merge --ff-only failed: ${(merged.stderr || merged.stdout).trim().split('\n').pop()}`, 'MAKE_PULL_NOT_FAST_FORWARD');
  const after = { ...summary, updated: true, commits: behind };
  if (blobAt(run, root, 'HEAD', LOCKFILE) === lockBefore) {
    const note = existsSync(join(root, 'node_modules')) ? undefined : 'Nothing is installed yet; run figma-cli make install.';
    return { ...after, lockfileChanged: false, reinstalled: false, ...(note ? { note } : {}) };
  }
  try { return { ...after, lockfileChanged: true, reinstalled: true, install: install(root, { run, warn }) }; }
  catch (error) {
    error.message = `Fast-forwarded ${TRUNK} by ${behind} commit(s); ${LOCKFILE} changed but the reinstall did not finish. ${error.message}`;
    throw error;
  }
}

// The dev command: pnpm run dev, the same command as Make's .figma/make/dev.
export function devCommand(pkg) {
  if (typeof pkg?.scripts?.dev !== 'string') fail('This project has no dev script (package.json scripts.dev).', 'MAKE_NO_DEV_SCRIPT');
  return { command: 'pnpm', args: ['run', 'dev'], source: 'package.json scripts.dev' };
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
// The first local URL a dev server prints, e.g. Vite's "Local: http://localhost:5173/".
export function findLocalUrl(text) {
  const match = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/[^\s'"]*)?/.exec(String(text).replace(ANSI, ''));
  return match ? match[0] : null;
}

// Start the dev server in the foreground, mirror its output, print the local
// URL once, and exit with its exit code. Agents run this in the background.
export function runDev(dir, { spawnFn = spawn, out = process.stdout, err = process.stderr, onUrl, signals = process } = {}) {
  const root = resolve(dir);
  const pkg = readPackage(root);
  if (!existsSync(join(root, 'node_modules'))) fail('Dependencies are not installed. Run figma-cli make install first.', 'MAKE_NOT_INSTALLED');
  const { command, args, source } = devCommand(pkg);
  err.write(`figma-cli: starting ${[command, ...args].join(' ')} (${source}) in ${root}\n`);
  const child = spawnFn(command, args, { cwd: root, stdio: ['inherit', 'pipe', 'pipe'], shell: false });
  let url = null;
  const watch = (stream, sink) => {
    let seen = '';
    stream?.on('data', chunk => {
      sink.write(chunk);
      if (url) return;
      // Only complete lines of this stream: a chunk may end mid-URL.
      seen = (seen + chunk.toString()).slice(-4096);
      url = findLocalUrl(seen.slice(0, seen.lastIndexOf('\n') + 1));
      if (url) { err.write(`figma-cli: local URL ${url}\n`); onUrl?.(url); }
    });
  };
  watch(child.stdout, out);
  watch(child.stderr, err);
  const forward = signal => () => child.kill(signal);
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, forward(signal)]);
  handlers.forEach(([signal, handler]) => signals.on?.(signal, handler));
  return new Promise((resolvePromise, reject) => {
    child.on('error', error => {
      handlers.forEach(([signal, handler]) => signals.off?.(signal, handler));
      reject(error.code === 'ENOENT' ? Object.assign(new Error(`${command} is not installed.`), { code: 'MAKE_TOOLCHAIN_MISSING' }) : error);
    });
    child.on('exit', (code, signal) => {
      handlers.forEach(([s, handler]) => signals.off?.(s, handler));
      resolvePromise({ code: code ?? (signal ? 130 : 1), signal, url, command: [command, ...args].join(' '), source });
    });
  });
}
