import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PROJECT_MARKER, repoName } from './make-project.js';

// `figma-cli team <verb>`: the plain-language git layer for designers working
// on a team-mode project's local clone. Every git and gh step is decided here,
// so an agent maps words to a verb and never improvises git. The hard rules
// live in code: work happens only on the caller's own <login>/<slug> branch,
// main is never pushed to or force-pushed, every push names its refspec, and
// a merge goes through a pull request approved by someone other than its
// author. GitHub main stays unprotected; these rules are the review convention.

export const TRUNK = 'main';
const TRUNK_REF = `refs/heads/${TRUNK}`;
const ORIGIN_TRUNK = `refs/remotes/origin/${TRUNK}`;
const LOCKFILE = 'pnpm-lock.yaml';
export const LARGE_FILE_BYTES = 50 * 1024 * 1024;
const SCAN_BYTES = 2 * 1024 * 1024;
export const TEAM_CODES = Object.freeze(['TEAM_NOT_A_CLONE', 'TEAM_NO_REPO', 'TEAM_GH_FAILED', 'TEAM_BAD_NAME', 'TEAM_UNSAVED',
  'TEAM_BRANCH_EXISTS', 'TEAM_MAIN_AHEAD', 'TEAM_SWITCH_FAILED', 'TEAM_ON_MAIN', 'TEAM_NOT_YOUR_BRANCH', 'TEAM_DETACHED',
  'TEAM_OPERATION_IN_PROGRESS', 'TEAM_SECRET', 'TEAM_LARGE_FILE', 'TEAM_FORMAT_FAILED', 'TEAM_BUILD_FAILED', 'TEAM_PUSH_REJECTED',
  'TEAM_PUSH_BLOCKED', 'TEAM_PUSH_REFUSED', 'TEAM_CONFLICT', 'TEAM_NOTHING_TO_REVIEW', 'TEAM_NO_PR', 'TEAM_PR_NOT_READY', 'TEAM_NOT_APPROVED',
  'TEAM_CHANGES_REQUESTED', 'TEAM_CHECKS_PENDING', 'TEAM_CHECKS_FAILED', 'TEAM_BEHIND_MAIN', 'TEAM_OUT_OF_DATE', 'TEAM_NO_BUILD_CHECK', 'TEAM_MERGE_FAILED']);

function fail(message, code, extra = {}) {
  const error = new Error(message);
  if (code) error.code = code;
  Object.assign(error, extra);
  throw error;
}

// Capture a command's output; nothing reaches the terminal unless asked.
// Git never opens an editor or a credential prompt here.
export function defaultRun(command, args, { cwd, stream = false } = {}) {
  const env = { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' };
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024,
    stdio: stream ? ['ignore', process.stderr, process.stderr] : ['ignore', 'pipe', 'pipe'] });
  if (result.error?.code === 'ENOENT') return { status: 127, stdout: '', stderr: `${command}: not found` };
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

const lastLine = result => (result.stderr || result.stdout || '').trim().split('\n').pop() || 'unknown error';

// --- context ---------------------------------------------------------------

// One clone: its root, the GitHub repo, the caller's login and the areas map.
// The login and repo are read once and cached for the verb's lifetime.
export function teamContext({ dir = process.cwd(), run = defaultRun, warn = () => {} } = {}) {
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
  if (top.status !== 0) fail(`${dir} is not inside a project clone. Clone it first with figma-cli make clone owner/repo.`, 'TEAM_NOT_A_CLONE');
  const ctx = { root: top.stdout.trim(), run, warn };
  ctx.git = (args, what) => {
    const result = run('git', args, { cwd: ctx.root });
    if (result.status !== 0) fail(`${what || `git ${args[0]}`} failed: ${lastLine(result)}`);
    return result.stdout.replace(/\n$/, '');
  };
  ctx.tryGit = args => run('git', args, { cwd: ctx.root });
  ctx.gh = (args, what) => {
    const result = run('gh', args, { cwd: ctx.root });
    if (result.status === 127) fail('The GitHub CLI (gh) is not installed. Install it, run gh auth login, then retry.', 'TEAM_GH_FAILED');
    if (result.status !== 0) fail(`${what || `gh ${args.slice(0, 2).join(' ')}`} failed: ${lastLine(result)}. Check gh auth status.`, 'TEAM_GH_FAILED');
    return result.stdout.trim();
  };
  ctx.ghJson = (args, what) => {
    const out = ctx.gh(args, what);
    try { return out ? JSON.parse(out) : null; } catch { fail(`${what || 'gh'} returned unreadable output.`, 'TEAM_GH_FAILED'); }
  };
  let login;
  ctx.login = () => {
    if (login) return login;
    const value = ctx.gh(['api', 'user', '--jq', '.login'], 'Reading your GitHub login');
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value)) fail('gh returned no usable GitHub login. Run gh auth login, then retry.', 'TEAM_GH_FAILED');
    return (login = value);
  };
  let project;
  ctx.project = () => (project ??= readProject(ctx.root, warn));
  let repo;
  ctx.repo = () => (repo ??= resolveRepo(ctx));
  return ctx;
}

// .figma-cli/project.json in the clone: the repo and the optional areas map
// (path glob → owner logins). Reviewers and owners are a convention.
export function readProject(root, warn = () => {}) {
  const path = join(root, PROJECT_MARKER);
  if (!existsSync(path)) return { repo: null, areas: [] };
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { warn(`${PROJECT_MARKER} is not valid JSON; ignoring it.`); return { repo: null, areas: [] }; }
  let repo = null;
  try { repo = repoName(value?.repo); } catch { /* the origin remote may still name it */ }
  return { repo, areas: parseAreas(value?.areas, warn) };
}

export function parseAreas(value, warn = () => {}) {
  if (value == null) return [];
  if (typeof value !== 'object' || Array.isArray(value)) { warn(`${PROJECT_MARKER} areas must map path globs to owner logins; ignoring it.`); return []; }
  const areas = [];
  for (const [glob, raw] of Object.entries(value)) {
    const owners = (Array.isArray(raw) ? raw : [raw]).filter(owner => typeof owner === 'string')
      .map(owner => owner.trim().replace(/^@/, '')).filter(owner => /^[A-Za-z0-9-]+$/.test(owner));
    if (owners.length) areas.push({ glob, owners, pattern: globPattern(glob) });
  }
  return areas;
}

// Path globs: `**` crosses folders, `*` and `?` stay inside one, a trailing
// `/` means everything below. Matched against repo-relative paths.
export function globPattern(glob) {
  let source = String(glob).replace(/^\.?\//, '');
  if (source.endsWith('/')) source += '**';
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '*' && source[i + 1] === '*') {
      i++;
      if (source[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function areaOwners(areas, paths) {
  const matched = [];
  for (const area of areas) {
    const hits = paths.filter(path => area.pattern.test(path));
    if (hits.length) matched.push({ area: area.glob, owners: area.owners, paths: hits });
  }
  return matched;
}

// GitHub owner/repo from the origin URL, else from the project marker. When
// both name a repo they must agree.
export function repoFromUrl(url) {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return match ? match[1] : null;
}

function resolveRepo(ctx) {
  const origin = ctx.tryGit(['remote', 'get-url', 'origin']);
  if (origin.status !== 0) fail('This clone has no origin remote. Clone it with figma-cli make clone owner/repo.', 'TEAM_NO_REPO');
  const fromUrl = repoFromUrl(origin.stdout);
  const fromMarker = ctx.project().repo;
  if (fromUrl && fromMarker && fromUrl.toLowerCase() !== fromMarker.toLowerCase()) {
    fail(`origin points at ${fromUrl}, but ${PROJECT_MARKER} names ${fromMarker}. Nothing was changed.`, 'TEAM_NO_REPO');
  }
  const repo = fromUrl || fromMarker;
  if (!repo) fail(`Cannot tell which GitHub repo this clone belongs to: origin is not a GitHub URL and ${PROJECT_MARKER} names no repo.`, 'TEAM_NO_REPO');
  return repoName(repo);
}

// --- branches and the hard rules ------------------------------------------

// "New filter panel" → "new-filter-panel".
export function slugify(name) {
  const slug = String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  if (!slug) fail('Give the task a short name with letters or numbers, for example "new filter panel".', 'TEAM_BAD_NAME');
  return slug;
}

export const taskBranch = (login, name) => `${login}/${slugify(name)}`;
export const isOwnBranch = (branch, login) => typeof branch === 'string' && branch.toLowerCase().startsWith(`${login.toLowerCase()}/`) &&
  branch.length > login.length + 1;

export function currentBranch(ctx) {
  const result = ctx.tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return result.status === 0 ? result.stdout.trim() : null;
}

// The branch the verb may change: the caller's own task branch, never main.
export function requireOwnBranch(ctx, branch = currentBranch(ctx)) {
  if (branch == null) fail('You are not on a task branch (detached HEAD). Say "start a task" to make one.', 'TEAM_DETACHED');
  if (branch === TRUNK) fail(`You are on ${TRUNK}, which only changes through reviewed pull requests. Say "start a task: <name>" first.`, 'TEAM_ON_MAIN');
  const login = ctx.login();
  if (!isOwnBranch(branch, login)) {
    fail(`${branch} is not your task branch (yours start with ${login}/). figma-cli never changes another person's branch.`, 'TEAM_NOT_YOUR_BRANCH');
  }
  return branch;
}

// Every push goes through here: an explicit refspec to the caller's own
// branch, never main, and a force only as --force-with-lease on an exact sha.
export function pushBranch(ctx, branch, { lease, setUpstream = false, deleteRemote = false } = {}) {
  if (typeof branch !== 'string' || !branch || branch === TRUNK || branch.startsWith('refs/') || branch.includes(':') || branch.startsWith('-')) {
    fail(`Refusing to push ${JSON.stringify(branch)}: figma-cli pushes only your own task branch, never ${TRUNK}.`, 'TEAM_PUSH_REFUSED');
  }
  if (!isOwnBranch(branch, ctx.login())) fail(`Refusing to push ${branch}: it is not your task branch.`, 'TEAM_PUSH_REFUSED');
  if (lease != null && !/^[a-f0-9]{40}$/.test(lease)) fail('Refusing a forced push without an exact lease.', 'TEAM_PUSH_REFUSED');
  const ref = `refs/heads/${branch}`;
  const args = ['push', '--porcelain'];
  if (deleteRemote) args.push(...(lease ? [`--force-with-lease=${ref}:${lease}`] : []), 'origin', `:${ref}`);
  else {
    if (setUpstream) args.push('--set-upstream');
    if (lease) args.push(`--force-with-lease=${ref}:${lease}`);
    args.push('origin', `${ref}:${ref}`);
  }
  const result = ctx.tryGit(args);
  if (result.status !== 0) {
    const text = `${result.stdout}\n${result.stderr}`;
    const refused = /\[remote rejected\][^\n]*/.exec(text);
    if (refused) {
      const reason = text.split('\n').map(line => line.trim()).find(line => /^remote:\s*error:/i.test(line))?.replace(/^remote:\s*/i, '') || refused[0];
      fail(`GitHub refused the push to ${branch}: ${reason}. Nothing was pushed. This is a rule on GitHub (for example secret scanning ` +
        'or a repository rule), not newer work.', 'TEAM_PUSH_BLOCKED', { reason });
    }
    if (/stale info|non-fast-forward|fetch first/.test(text)) {
      fail(`GitHub has newer changes on ${branch} than this computer (another computer of yours, or someone else, saved to it), so nothing was pushed. ` +
        'Your work is still saved on this computer. Say "get the latest" (figma-cli team sync) to bring those changes in and send yours.', 'TEAM_PUSH_REJECTED');
    }
    fail(`Pushing ${branch} failed: ${lastLine(result)}`);
  }
  return true;
}

function revOf(ctx, ref) {
  const result = ctx.tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return result.status === 0 ? result.stdout.trim() : null;
}

function fetchMain(ctx) {
  ctx.git(['fetch', '--quiet', 'origin', `+${TRUNK_REF}:${ORIGIN_TRUNK}`], `Getting the latest ${TRUNK} from GitHub`);
  return revOf(ctx, ORIGIN_TRUNK);
}

function remoteBranchSha(ctx, branch) {
  const out = ctx.git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], 'Reading your branch on GitHub');
  const line = out.split('\n').find(row => row.endsWith(`\trefs/heads/${branch}`));
  return line ? line.split('\t')[0] : null;
}

function count(ctx, range) { return Number(ctx.git(['rev-list', '--count', range])); }

export function operationInProgress(ctx) {
  for (const [name, label] of [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]) {
    const path = ctx.git(['rev-parse', '--git-path', name]);
    if (existsSync(join(ctx.root, path)) || existsSync(path)) return label;
  }
  return null;
}

// figma-cli always finishes or undoes its own rebases, so an unfinished one
// was started by something else; it is never continued, skipped or pushed.
function requireNoOperation(ctx) {
  const op = operationInProgress(ctx);
  if (op) fail(`A git ${op} that figma-cli did not start is unfinished in this clone, so nothing was changed. Ask a developer for help with it.`, 'TEAM_OPERATION_IN_PROGRESS');
}

// --- changes in plain words ------------------------------------------------

// git status → [{ path, change, from? }], untracked files included.
export function listChanges(ctx) {
  const out = ctx.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = out.split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy === '??') changes.push({ path, change: 'new file' });
    else if (xy.includes('R')) { changes.push({ path, change: 'renamed', from: parts[++i] }); }
    else if (xy.includes('C')) { changes.push({ path, change: 'new file', from: parts[++i] }); }
    else if (xy.includes('U') || xy === 'AA' || xy === 'DD') changes.push({ path, change: 'conflicted' });
    else if (xy.includes('D')) changes.push({ path, change: 'deleted' });
    else if (xy.includes('A')) changes.push({ path, change: 'new file' });
    else changes.push({ path, change: 'changed' });
  }
  return changes;
}

export const describeChange = ({ path, change, from }) => change === 'renamed' ? `renamed ${from} → ${path}` : `${change}: ${path}`;

// --- secrets and large files -------------------------------------------------

const SECRET_NAME = [/^\.npmrc$/, /^\.env(\..*)?$/, /^\.envrc$/, /\.pem$/, /\.p12$/, /\.pfx$/, /\.key$/, /^id_(rsa|dsa|ecdsa|ed25519)$/, /^\.netrc$/, /^\.pypirc$/];
const SECRET_CONTENT = [
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['an npm token', /\bnpm_[A-Za-z0-9]{30,}/],
  ['a registry credential', /(^|[:\s])(_authToken|_auth|_password)\s*=\s*(?!\$\{)\S/],
  ['a Figma token', /\bfig[dou]_[A-Za-z0-9_-]{20,}/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['an API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
];

// Secret-like files are refused by name, and text files are scanned for
// token-looking content. Findings carry path:line only, never the value.
export function findSecrets(root, changes) {
  const findings = [];
  for (const { path, change } of changes) {
    if (change === 'deleted') continue;
    const name = basename(path);
    if (SECRET_NAME.some(pattern => pattern.test(name)) && !/^\.env\.(example|sample|template)$/.test(name)) {
      findings.push({ path, reason: `${name} files hold credentials and never go into the repo` });
      continue;
    }
    const full = join(root, path);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (!stat.isFile() || stat.size > SCAN_BYTES) continue;
    const bytes = readFileSync(full);
    if (bytes.includes(0)) continue;
    bytes.toString('utf8').split(/\r?\n/).forEach((line, index) => {
      const hit = SECRET_CONTENT.find(([, pattern]) => pattern.test(line));
      if (hit) findings.push({ path, line: index + 1, reason: `looks like ${hit[0]}` });
    });
  }
  return findings;
}

export function findLargeFiles(root, changes, limit = LARGE_FILE_BYTES) {
  const large = [];
  for (const { path, change } of changes) {
    if (change === 'deleted') continue;
    try {
      const { size } = statSync(join(root, path));
      if (size > limit) large.push({ path, megabytes: Math.round(size / 1024 / 1024) });
    } catch { /* gone since status */ }
  }
  return large;
}

function requireSafe(ctx, changes) {
  const secrets = findSecrets(ctx.root, changes);
  if (secrets.length) {
    fail(`Nothing was saved: ${secrets.map(s => `${s.path}${s.line ? `:${s.line}` : ''} (${s.reason})`).join('; ')}. ` +
      'Remove the secret (keep tokens in your own ~/.npmrc or a git-ignored file), then save again.', 'TEAM_SECRET', { secrets });
  }
  const large = findLargeFiles(ctx.root, changes);
  if (large.length) {
    fail(`Nothing was saved: ${large.map(f => `${f.path} is ${f.megabytes} MB`).join('; ')}, too large for the repo ` +
      `(limit ${LARGE_FILE_BYTES / 1024 / 1024} MB). Make it smaller or keep it outside the project.`, 'TEAM_LARGE_FILE', { large });
  }
}

// --- format and build --------------------------------------------------------

function packageJson(root) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { return null; }
}

export function projectScripts(root) {
  const pkg = packageJson(root);
  const manager = existsSync(join(root, LOCKFILE)) ? 'pnpm' : existsSync(join(root, 'package-lock.json')) ? 'npm' : 'pnpm';
  return ['format', 'build'].filter(name => typeof pkg?.scripts?.[name] === 'string').map(name => ({ name, command: manager, args: ['run', name] }));
}

const tail = (text, lines = 15) => String(text).trim().split('\n').slice(-lines).join('\n');

function runScripts(ctx, { only = ['format', 'build'], outcome = 'Nothing was saved' } = {}) {
  const ran = [];
  for (const { name, command, args } of projectScripts(ctx.root).filter(script => only.includes(script.name))) {
    const result = ctx.run(command, args, { cwd: ctx.root });
    if (result.status !== 0) {
      const code = name === 'build' ? 'TEAM_BUILD_FAILED' : 'TEAM_FORMAT_FAILED';
      const hint = existsSync(join(ctx.root, 'node_modules')) ? '' : ' Dependencies are not installed; run figma-cli make install first.';
      fail(`${outcome}: the project's ${name} step (${command} ${args.join(' ')}) failed.${hint} Its last lines:\n${tail(result.stdout + result.stderr)}`, code,
        { step: name });
    }
    ran.push(`${command} ${args.join(' ')}`);
  }
  return ran;
}

// --- commit messages and areas -------------------------------------------

export function commitMessage(changes) {
  if (changes.length === 1) {
    const [only] = changes;
    const verb = { 'new file': 'Add', deleted: 'Remove', renamed: 'Rename' }[only.change] || 'Update';
    return `${verb} ${only.path}`;
  }
  const dirs = [...new Set(changes.map(c => c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : '.'))];
  return dirs.length === 1 && dirs[0] !== '.' ? `Update ${changes.length} files in ${dirs[0]}` : `Update ${changes.length} files`;
}

function areaWarnings(ctx, paths) {
  const login = ctx.login().toLowerCase();
  return areaOwners(ctx.project().areas, paths).filter(hit => !hit.owners.some(owner => owner.toLowerCase() === login))
    .map(hit => `${hit.paths.join(', ')} ${hit.paths.length === 1 ? 'is' : 'are'} in ${hit.area}, owned by ${hit.owners.map(o => `@${o}`).join(', ')}; ` +
      'they will be asked to review. Shared spots like App.tsx or package.json are best changed in their own small pull request.');
}

// --- verbs -------------------------------------------------------------------

// Secrets and large files are refused before any script runs, and again on
// what format left behind.
function checkChanges(ctx) {
  let changes = listChanges(ctx);
  let ran = [];
  if (changes.length) {
    requireSafe(ctx, changes);
    ran = runScripts(ctx);
    changes = listChanges(ctx);
    requireSafe(ctx, changes);
  }
  return { changes, ran };
}

// Commit everything on the caller's own branch, without pushing.
function commitLocal(ctx, { message } = {}) {
  requireNoOperation(ctx);
  const branch = requireOwnBranch(ctx);
  const { changes, ran } = checkChanges(ctx);
  const warnings = [];
  let commit = null;
  if (changes.length) {
    warnings.push(...areaWarnings(ctx, changes.map(c => c.path)));
    ctx.git(['add', '--all', '--', '.'], 'Staging your changes');
    const text = typeof message === 'string' && message.trim() ? message.trim() : commitMessage(changes);
    ctx.git(['commit', '--quiet', '-m', text], 'Saving your changes');
    commit = { sha: revOf(ctx, 'HEAD'), message: text };
  }
  return { branch, changes, commit, ran, warnings };
}

// A push GitHub refuses by rule would be refused again while the flagged
// content sits in an unsent commit, so the caller's unsent commits are undone
// with reset --soft (back to GitHub's copy of the branch, or to where it left
// main when that is newer), keeping every change in the files. Nothing GitHub has is rewritten.
function pushSaves(ctx, branch, options) {
  try { pushBranch(ctx, branch, options); }
  catch (error) {
    if (error.code !== 'TEAM_PUSH_BLOCKED') throw error;
    const remote = remoteBranchSha(ctx, branch);
    const fromMain = ctx.tryGit(['merge-base', 'HEAD', ORIGIN_TRUNK]).stdout.trim();
    const isAncestor = (a, b) => ctx.tryGit(['merge-base', '--is-ancestor', a, b]).status === 0;
    const base = remote && isAncestor(remote, 'HEAD') && (!fromMain || isAncestor(fromMain, remote)) ? remote : fromMain;
    if (base && base !== revOf(ctx, 'HEAD')) ctx.git(['reset', '--soft', '--quiet', base], 'Undoing the saves GitHub refused');
    error.message = `GitHub flagged something in your changes and refused them: ${error.reason}. Nothing was sent, and your unsent saves ` +
      `on ${branch} were undone so the flagged content is in no save; every change is still in your files. Remove what GitHub flagged, then save again.`;
    throw error;
  }
}

// Save: commit, then a plain push. Newer work on GitHub is never overwritten;
// sync is the way to bring it in.
export function save(ctx, { message } = {}) {
  const { branch, changes, commit, ran, warnings } = commitLocal(ctx, { message });
  const remote = remoteBranchSha(ctx, branch);
  const head = revOf(ctx, 'HEAD');
  let pushed = false;
  if (remote !== head) {
    pushSaves(ctx, branch, { setUpstream: true });
    pushed = true;
  }
  const summary = commit
    ? `Saved ${changes.length} file${changes.length === 1 ? '' : 's'} on ${branch} and ${pushed ? 'sent them to GitHub' : 'GitHub already had them'}.`
    : pushed ? `Nothing new to save; sent your earlier saves on ${branch} to GitHub.` : 'Nothing new to save; GitHub already has everything.';
  return { verb: 'save', branch, saved: !!commit, files: changes.map(describeChange), ...(commit ? { commit } : {}),
    ...(ran.length ? { checks: ran } : {}), pushed, ...(warnings.length ? { warnings } : {}), summary };
}

// Start: a fresh <login>/<slug> branch from the latest main, pushed.
export function start(ctx, name, { saveFirst = false } = {}) {
  const login = ctx.login();
  const branch = taskBranch(login, name);
  requireNoOperation(ctx);
  const current = currentBranch(ctx);
  const changes = listChanges(ctx);
  let saved = null;
  let carry = false;
  if (changes.length) {
    if (!saveFirst) {
      fail(`You have unsaved changes on ${current || 'a detached HEAD'} (${changes.length} file${changes.length === 1 ? '' : 's'}). ` +
        'Say "save my progress" first, or start with --save-first to save them before switching.', 'TEAM_UNSAVED', { files: changes.map(describeChange) });
    }
    if (current === TRUNK) { carry = true; checkChanges(ctx); }
    else { requireOwnBranch(ctx, current); saved = save(ctx); }
  }
  const remoteMain = fetchMain(ctx);
  if (!remoteMain) fail(`GitHub has no ${TRUNK} branch to start from.`, 'TEAM_NO_REPO');
  if (revOf(ctx, `refs/heads/${branch}`) || remoteBranchSha(ctx, branch)) {
    fail(`A task branch ${branch} already exists. Pick another name, or keep working on it.`, 'TEAM_BRANCH_EXISTS');
  }
  const localMain = revOf(ctx, TRUNK_REF);
  if (localMain && count(ctx, `${remoteMain}..${localMain}`) > 0) {
    fail(`Your local ${TRUNK} has commits that are not on GitHub, so nothing was changed. Ask for help moving them onto a task branch.`, 'TEAM_MAIN_AHEAD');
  }
  const switched = ctx.tryGit(['switch', '--quiet', '--no-track', '-c', branch, ORIGIN_TRUNK]);
  if (switched.status !== 0) {
    fail(`Could not start ${branch}: ${carry ? `your unsaved changes on ${TRUNK} touch files that changed on GitHub ${TRUNK} too` : lastLine(switched)}. Nothing was changed.`,
      'TEAM_SWITCH_FAILED');
  }
  if (!localMain) ctx.git(['update-ref', TRUNK_REF, remoteMain, ''.padEnd(40, '0')], `Creating local ${TRUNK}`);
  else if (localMain !== remoteMain) ctx.git(['update-ref', TRUNK_REF, remoteMain, localMain], `Updating local ${TRUNK}`);
  ctx.git(['config', `branch.${branch}.figmaCliTask`, String(name).trim()]);
  pushBranch(ctx, branch, { setUpstream: true });
  if (carry) {
    try { saved = save(ctx); }
    catch (error) {
      const where = listChanges(ctx).length ? 'your changes are still unsaved on it' : 'your changes are saved on this computer only, not yet on GitHub';
      error.message = `Started ${branch} and sent it to GitHub, but ${where}. ${error.message}`;
      throw error;
    }
  }
  const areas = ctx.project().areas.map(({ glob, owners }) => ({ area: glob, owners }));
  return { verb: 'start', branch, from: { [TRUNK]: remoteMain }, ...(saved ? { saved } : {}), ...(areas.length ? { areas } : {}),
    summary: `Started "${String(name).trim()}" on ${branch}, from the latest ${TRUNK}.${carry ? ` Your unsaved changes moved onto it and were saved.` : ''}` };
}

// --- conflicts ---------------------------------------------------------------

// Split a conflicted file into its conflict blocks. null when it has none or
// the markers are malformed.
export function resolveIdenticalHunks(text) {
  const lines = text.split(/(?<=\n)/);
  const out = [];
  let i = 0;
  let blocks = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('<<<<<<<')) { out.push(lines[i++]); continue; }
    blocks++;
    const ours = [];
    const theirs = [];
    let side = ours;
    let base = false;
    i++;
    for (;;) {
      if (i >= lines.length) return null;
      const line = lines[i];
      if (line.startsWith('|||||||')) { base = true; side = null; }
      else if (line.startsWith('=======')) { side = theirs; base = false; }
      else if (line.startsWith('>>>>>>>')) { i++; break; }
      else if (line.startsWith('<<<<<<<')) return null;
      else if (!base && side) side.push(line);
      i++;
    }
    if (ours.join('') !== theirs.join('')) return { resolved: false, blocks };
    out.push(...ours);
  }
  return blocks ? { resolved: true, blocks, text: out.join('') } : null;
}

function conflictedPaths(ctx) {
  return ctx.git(['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean);
}

// Who else changed this file on main since the branch left it.
function otherChanges(ctx, path, base, onto) {
  const log = ctx.tryGit(['log', '--format=%H%x09%an%x09%s', `${base}..${onto}`, '--', path]);
  const repo = (() => { try { return ctx.repo(); } catch { return null; } })();
  const seen = [];
  for (const row of (log.status === 0 ? log.stdout.trim().split('\n') : []).filter(Boolean).slice(0, 5)) {
    const [sha, name, subject] = row.split('\t');
    let pr = null;
    if (repo) {
      const pulls = ctx.run('gh', ['api', `repos/${repo}/commits/${sha}/pulls`, '--jq', '[.[] | {url: .html_url, author: .user.login}]'], { cwd: ctx.root });
      if (pulls.status === 0) { try { pr = JSON.parse(pulls.stdout)[0] || null; } catch { /* fall back to the subject */ } }
      const number = !pr && /\(#(\d+)\)\s*$/.exec(subject || '')?.[1];
      if (number) pr = { url: `https://github.com/${repo}/pull/${number}`, author: null };
    }
    const entry = { commit: sha, author: pr?.author ? `@${pr.author}` : name, ...(pr?.url ? { pr: pr.url } : {}) };
    if (!seen.some(other => (entry.pr && other.pr === entry.pr) || other.commit === sha)) seen.push(entry);
  }
  return seen;
}

function regenerateLockfile(ctx, label) {
  const shown = ctx.tryGit(['show', `:2:${LOCKFILE}`]);
  if (shown.status === 0) writeFileSync(join(ctx.root, LOCKFILE), shown.stdout);
  else ctx.git(['checkout', '--ours', '--', LOCKFILE], `Taking ${label}'s ${LOCKFILE}`);
  const result = ctx.run('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], { cwd: ctx.root });
  if (result.status !== 0) return `pnpm could not regenerate ${LOCKFILE}: ${lastLine(result)}`;
  ctx.git(['add', '--', LOCKFILE]);
  return null;
}

// Replay the branch onto a commit (GitHub main, or the branch's own newer
// saves on GitHub). Only pnpm-lock.yaml and identical hunks are resolved
// automatically; anything else aborts the rebase, so the branch is exactly as
// before, and reports who else changed each file.
export function rebaseOnto(ctx, ontoSha, label = TRUNK) {
  const original = revOf(ctx, 'HEAD');
  const behind = count(ctx, `HEAD..${ontoSha}`);
  if (behind === 0) return { rebased: false, behind: 0, autoResolved: [] };
  const started = ctx.tryGit(['-c', 'merge.conflictStyle=merge', '-c', 'rebase.autoStash=false', 'rebase', '--quiet', ontoSha]);
  if (started.status === 0) return { rebased: true, behind, autoResolved: [] };
  if (operationInProgress(ctx) !== 'rebase') fail(`Bringing in ${label} failed: ${lastLine(started)}. Nothing was changed.`);
  const base = ctx.tryGit(['merge-base', original, ontoSha]).stdout.trim();
  const autoResolved = [];
  for (let step = 0; step < 1000 && operationInProgress(ctx) === 'rebase'; step++) {
    const unresolved = [];
    let lockfile = false;
    for (const path of conflictedPaths(ctx)) {
      if (path === LOCKFILE) { lockfile = true; continue; }
      const full = join(ctx.root, path);
      const text = existsSync(full) && statSync(full).isFile() ? readFileSync(full) : null;
      const result = text && !text.includes(0) ? resolveIdenticalHunks(text.toString('utf8')) : null;
      if (result?.resolved) {
        writeFileSync(full, result.text);
        ctx.git(['add', '--', path]);
        autoResolved.push({ path, how: 'both sides made the same change' });
      } else unresolved.push(path);
    }
    let lockError = null;
    if (!unresolved.length && lockfile) {
      lockError = regenerateLockfile(ctx, label);
      if (!lockError) autoResolved.push({ path: LOCKFILE, how: `took ${label}'s and regenerated it` });
    }
    if (unresolved.length || lockError) {
      if (lockError) unresolved.push(LOCKFILE);
      const conflicts = unresolved.map(path => ({ path, changedBy: otherChanges(ctx, path, base, ontoSha) }));
      ctx.git(['rebase', '--abort'], 'Undoing the unfinished rebase');
      const untouched = revOf(ctx, 'HEAD') === original;
      const lines = conflicts.map(({ path, changedBy }) => changedBy.length
        ? `${path} was also changed by ${changedBy.map(c => `${c.author}${c.pr ? ` in ${c.pr}` : ''}`).join(', ')}`
        : `${path} was also changed on ${label}`);
      fail(`Your changes and ${label} both changed the same lines, so nothing was merged. ${lines.join('; ')}. ` +
        `${lockError ? `${lockError}. ` : ''}Ask them (or the area owner) on your pull request how to combine both changes. ` +
        `Your branch was ${untouched ? 'left exactly as it was' : 'NOT restored to its earlier commit; ask for help'}.`, 'TEAM_CONFLICT', { conflicts, untouched });
    }
    const next = ctx.tryGit(['-c', 'core.editor=true', 'rebase', '--continue']);
    if (next.status !== 0 && operationInProgress(ctx) === 'rebase' && !conflictedPaths(ctx).length) {
      const staged = ctx.tryGit(['diff', '--cached', '--quiet']);
      if (staged.status === 0) ctx.git(['rebase', '--skip'], `Skipping a change ${label} already has`);
      else {
        ctx.tryGit(['rebase', '--abort']);
        fail(`Bringing in ${label} stopped (${lastLine(next)}), so it was undone and your branch is as it was. Ask for help.`, 'TEAM_CONFLICT');
      }
    }
  }
  return { rebased: true, behind, autoResolved };
}

// Newer saves on GitHub's copy of the branch (another computer, or a push
// that failed after a local rebase) are brought in first. Commits this clone
// already has in rewritten form are not replayed. The fetched sha is the lease.
function bringInOwnBranch(ctx, branch) {
  if (!remoteBranchSha(ctx, branch)) return { lease: null, rebased: false, autoResolved: [] };
  const tracking = `refs/remotes/origin/${branch}`;
  ctx.git(['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${tracking}`], 'Getting your branch from GitHub');
  const lease = revOf(ctx, tracking);
  const newer = ctx.git(['cherry', 'HEAD', lease]).split('\n').some(line => line.startsWith('+'));
  return { lease, ...(newer ? rebaseOnto(ctx, lease, 'your branch on GitHub') : { rebased: false, autoResolved: [] }) };
}

// Sync: commit locally, bring in the branch's newer saves from GitHub, replay
// it onto the latest main and push with a lease on what GitHub had, to the
// caller's own branch only.
export function sync(ctx, { message } = {}) {
  const local = commitLocal(ctx, { message });
  const { branch } = local;
  const own = bringInOwnBranch(ctx, branch);
  const remoteMain = fetchMain(ctx);
  const result = rebaseOnto(ctx, remoteMain, TRUNK);
  const head = revOf(ctx, 'HEAD');
  let pushed = false;
  if (head !== own.lease) { pushSaves(ctx, branch, { lease: own.lease || undefined, setUpstream: true }); pushed = true; }
  const notes = [...own.autoResolved, ...result.autoResolved].map(r => `${r.path}: ${r.how}`);
  const brought = [own.rebased ? 'your newer saves from GitHub' : null, result.rebased ? `the latest ${TRUNK}` : null].filter(Boolean);
  return { verb: 'sync', branch, [TRUNK]: remoteMain, saved: !!local.commit, broughtInOwn: own.rebased, broughtIn: result.rebased, pushed,
    ...(notes.length ? { autoResolved: notes } : {}), ...(local.warnings.length ? { warnings: local.warnings } : {}),
    summary: brought.length ? `Brought ${brought.join(' and ')} into ${branch}${notes.length ? ` (sorted out ${notes.length} file${notes.length === 1 ? '' : 's'} automatically)` : ''} and sent it to GitHub.`
      : `${branch} already has everything from ${TRUNK}${pushed ? '; sent your saves to GitHub' : ''}.` };
}

// Conflicts: the same as sync. A rebase figma-cli did not start is reported
// by sync's first check and left alone.
export function conflicts(ctx) {
  return { ...sync(ctx), verb: 'conflicts' };
}

// --- pull requests -----------------------------------------------------------

const PR_FIELDS = 'number,url,state,isDraft,isCrossRepository,author,headRefName,headRefOid,baseRefName,reviewRequests,statusCheckRollup,title';

function findPr(ctx, branch, { state = 'open' } = {}) {
  const list = ctx.ghJson(['pr', 'list', '--repo', ctx.repo(), '--head', branch, '--state', state, '--json', PR_FIELDS, '--limit', '5'],
    'Looking up your pull request');
  // A fork's pull request can share the branch name; only this repo's counts.
  return (Array.isArray(list) ? list : []).find(pr => pr.headRefName === branch && !pr.isCrossRepository) || null;
}

// Reviews in submission order, with the commit each one reviewed. gh's
// latestReviews leaves that commit empty, so the REST endpoint is read.
function readReviews(ctx, number) {
  const out = ctx.gh(['api', '--paginate', `repos/${ctx.repo()}/pulls/${number}/reviews`, '--jq', '.[] | {login: .user.login, state: .state, commit: .commit_id}'],
    'Reading the reviews');
  return out.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { fail('gh returned unreadable reviews.', 'TEAM_GH_FAILED'); } });
}

export function prBody({ branch, files, task }) {
  return [
    '## What changed',
    task ? `Task: ${task}` : null,
    '',
    ...(files.length ? files.map(file => `- ${file}`) : ['- (no file changes yet)']),
    '',
    '## How to see it locally',
    '',
    '```sh',
    `gh pr checkout ${branch}`,
    'figma-cli make install',
    'figma-cli make dev',
    '```',
    '',
    '## Screenshot',
    '',
    '_Add a screenshot of the change here._',
    '',
    '---',
    'Opened with `figma-cli team pr`. Merge with `figma-cli team merge` after someone other than the author approves.',
  ].filter(line => line !== null).join('\n');
}

export const titleFrom = (task, branch) => {
  const text = task || branch.slice(branch.indexOf('/') + 1).replace(/-/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

function changedSinceMain(ctx) {
  const out = ctx.git(['diff', '--name-status', '-z', `${ORIGIN_TRUNK}...HEAD`]);
  const parts = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (status.startsWith('R') || status.startsWith('C')) { files.push({ path: parts[i + 2], change: 'renamed', from: parts[i + 1] }); i += 2; }
    else { files.push({ path: parts[++i], change: status === 'A' ? 'new file' : status === 'D' ? 'deleted' : 'changed' }); }
  }
  return files;
}

// PR: sync and save, then open (or reuse) the pull request into main and ask
// the area owners to review.
export function pr(ctx, { title, message } = {}) {
  const synced = sync(ctx, { message });
  const saved = save(ctx);
  const branch = saved.branch;
  if (count(ctx, `${ORIGIN_TRUNK}..HEAD`) === 0) fail(`${branch} has no changes compared with ${TRUNK} yet, so there is nothing to review.`, 'TEAM_NOTHING_TO_REVIEW');
  const files = changedSinceMain(ctx);
  const login = ctx.login().toLowerCase();
  const reviewers = [...new Set(areaOwners(ctx.project().areas, files.map(f => f.path)).flatMap(hit => hit.owners))]
    .filter(owner => owner.toLowerCase() !== login);
  let existing = findPr(ctx, branch);
  let url;
  if (existing) url = existing.url;
  else {
    const task = ctx.tryGit(['config', '--get', `branch.${branch}.figmaCliTask`]).stdout.trim() || null;
    const out = ctx.gh(['pr', 'create', '--repo', ctx.repo(), '--base', TRUNK, '--head', branch,
      '--title', (title || titleFrom(task, branch)).trim(), '--body', prBody({ branch, files: files.map(describeChange), task })], 'Opening the pull request');
    url = out.split('\n').reverse().find(line => /^https:\/\//.test(line)) || out;
  }
  const requested = [];
  const notRequested = [];
  for (const reviewer of reviewers) {
    const result = ctx.run('gh', ['pr', 'edit', url, '--repo', ctx.repo(), '--add-reviewer', reviewer], { cwd: ctx.root });
    (result.status === 0 ? requested : notRequested).push(reviewer);
  }
  if (notRequested.length) ctx.warn(`Could not ask ${notRequested.map(r => `@${r}`).join(', ')} to review; mention them on the pull request instead.`);
  return { verb: 'pr', branch, url, created: !existing, files: files.map(describeChange), synced: synced.broughtIn,
    ...(requested.length ? { reviewers: requested.map(r => `@${r}`) } : {}),
    ...(notRequested.length ? { reviewersNotRequested: notRequested.map(r => `@${r}`) } : {}),
    summary: `${existing ? 'Your pull request is up to date' : 'Opened your pull request'}: ${url}.` +
      `${requested.length ? ` Asked ${requested.map(r => `@${r}`).join(', ')} to review.` : ' Ask a teammate to review it.'}` };
}

// The review state of a pull request from each reviewer's latest review. An
// approval counts only when it is of the current head commit and comes from
// someone who is neither the pull request's author nor the person merging.
export function reviewState({ author, merger, head, reviews = [], requests = [] }) {
  const excluded = new Set([author, merger].filter(Boolean).map(login => login.toLowerCase()));
  const latest = new Map();
  for (const review of reviews) {
    if (review?.login && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) {
      latest.set(review.login.toLowerCase(), { who: review.login, state: review.state, commit: review.commit || null });
    }
  }
  const approvals = [...latest.values()].filter(r => r.state === 'APPROVED' && !excluded.has(r.who.toLowerCase()));
  return {
    approvedBy: approvals.filter(r => head && r.commit === head),
    staleApprovals: approvals.filter(r => !head || r.commit !== head),
    changesRequestedBy: [...latest.values()].filter(r => r.state === 'CHANGES_REQUESTED'),
    waitingOn: requests.map(r => r.login || r.name || r.slug).filter(Boolean),
  };
}

const pullReviews = (ctx, pull, merger) => reviewState({ author: pull.author?.login, merger, head: pull.headRefOid,
  reviews: readReviews(ctx, pull.number), requests: pull.reviewRequests || [] });

// Checks on the pull request's head: none, passing, pending or failing.
export function checkState(pull) {
  const checks = (pull?.statusCheckRollup || []).map(c => {
    const name = c.name || c.context || 'check';
    if (c.__typename === 'StatusContext' || (c.state && !c.status)) {
      const state = String(c.state || '').toUpperCase();
      return { name, result: state === 'SUCCESS' ? 'pass' : ['PENDING', 'EXPECTED'].includes(state) ? 'pending' : 'fail' };
    }
    if (String(c.status || '').toUpperCase() !== 'COMPLETED') return { name, result: 'pending' };
    return { name, result: ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(String(c.conclusion || '').toUpperCase()) ? 'pass' : 'fail' };
  });
  const state = !checks.length ? 'none' : checks.some(c => c.result === 'fail') ? 'failing' : checks.some(c => c.result === 'pending') ? 'pending' : 'passing';
  return { state, failing: checks.filter(c => c.result === 'fail').map(c => c.name), pending: checks.filter(c => c.result === 'pending').map(c => c.name) };
}

// Merge: only the caller's own PR into main, approved by someone else, with
// a green build and up to date with main. The build is GitHub's checks, or,
// when the PR has none, the project's build script run here on the exact head
// being merged. Squash, delete the branch, return to an updated main.
export function merge(ctx, { buildCheck = true } = {}) {
  requireNoOperation(ctx);
  const branch = requireOwnBranch(ctx);
  const unsaved = listChanges(ctx);
  if (unsaved.length) fail(`You have ${unsaved.length} unsaved file${unsaved.length === 1 ? '' : 's'}. Say "save my progress" first.`, 'TEAM_UNSAVED',
    { files: unsaved.map(describeChange) });
  const pull = findPr(ctx, branch);
  if (!pull) fail(`${branch} has no open pull request. Say "I'm ready for review" first.`, 'TEAM_NO_PR');
  if (pull.baseRefName !== TRUNK) fail(`${pull.url} targets ${pull.baseRefName}, not ${TRUNK}; figma-cli merges only into ${TRUNK}.`, 'TEAM_PR_NOT_READY');
  if (pull.isDraft) fail(`${pull.url} is still a draft. Mark it ready for review first.`, 'TEAM_PR_NOT_READY');
  const login = ctx.login();
  const remoteMain = fetchMain(ctx);
  const head = revOf(ctx, 'HEAD');
  const remoteHead = remoteBranchSha(ctx, branch);
  if (pull.headRefOid !== head || remoteHead !== head) {
    fail(`The pull request ${pull.url} and this computer have different versions of ${branch}. Say "save my progress" or "get the latest", then ask again.`, 'TEAM_OUT_OF_DATE');
  }
  if (pull.isCrossRepository) fail(`${pull.url} comes from a fork; figma-cli merges only pull requests from your own branch in ${ctx.repo()}.`, 'TEAM_PR_NOT_READY');
  const reviews = pullReviews(ctx, pull, login);
  if (reviews.changesRequestedBy.length) {
    fail(`${reviews.changesRequestedBy.map(r => `@${r.who}`).join(', ')} asked for changes on ${pull.url}. Make them, save, and ask for another review.`, 'TEAM_CHANGES_REQUESTED');
  }
  if (!reviews.approvedBy.length) {
    const stale = reviews.staleApprovals.map(r => `@${r.who}`);
    fail(`${pull.url} has no approval of its latest changes from someone other than its author (@${pull.author?.login || login}), so it was not merged. ` +
      (stale.length ? `${stale.join(', ')} approved an earlier version; ask them to look again.` : 'Ask a teammate to review and approve it, then ask again.'),
    'TEAM_NOT_APPROVED', { url: pull.url });
  }
  const checks = checkState(pull);
  if (checks.state === 'failing') fail(`Checks failed on ${pull.url}: ${checks.failing.join(', ')}. Fix them, save, and ask again.`, 'TEAM_CHECKS_FAILED');
  if (checks.state === 'pending') fail(`Checks are still running on ${pull.url} (${checks.pending.join(', ')}). Ask again when they finish.`, 'TEAM_CHECKS_PENDING');
  if (count(ctx, `HEAD..${remoteMain}`) > 0) {
    const synced = sync(ctx);
    fail(`${TRUNK} moved since your last sync, so nothing was merged. ${synced.summary} Checks and the reviewer may need to look again; then ask to merge again.`,
      'TEAM_BEHIND_MAIN', { url: pull.url });
  }
  let localBuild = null;
  if (checks.state === 'none') {
    if (projectScripts(ctx.root).some(script => script.name === 'build')) {
      runScripts(ctx, { only: ['build'], outcome: `${pull.url} has no checks on GitHub, so its build was run here; it failed and nothing was merged` });
      localBuild = 'passed';
    } else if (buildCheck) {
      fail(`${pull.url} has no checks on GitHub and the project has no build script, so a green build cannot be confirmed and nothing was merged. ` +
        'Add a build script or CI checks, or ask again with --no-build-check to merge without a build.', 'TEAM_NO_BUILD_CHECK', { url: pull.url });
    } else localBuild = 'skipped';
  }
  ctx.gh(['pr', 'merge', String(pull.number), '--repo', ctx.repo(), '--squash', '--match-head-commit', head], 'Merging the pull request');
  const after = ctx.ghJson(['pr', 'view', String(pull.number), '--repo', ctx.repo(), '--json', 'state,mergeCommit'], 'Confirming the merge');
  if (after?.state !== 'MERGED') fail(`GitHub did not report ${pull.url} as merged (state ${after?.state || 'unknown'}). Nothing else was changed.`, 'TEAM_MERGE_FAILED');
  const newMain = fetchMain(ctx);
  ctx.git(['switch', '--quiet', TRUNK], `Returning to ${TRUNK}`);
  ctx.git(['merge', '--ff-only', '--quiet', newMain], `Updating ${TRUNK}`);
  const cleanup = [];
  try { pushBranch(ctx, branch, { deleteRemote: true, lease: head }); cleanup.push('deleted the branch on GitHub'); }
  catch (error) { ctx.warn(`The branch ${branch} is still on GitHub: ${error.message}`); }
  if (ctx.tryGit(['branch', '-D', '--', branch]).status === 0) cleanup.push('deleted the local branch');
  return { verb: 'merge', branch, url: pull.url, approvedBy: reviews.approvedBy.map(r => `@${r.who}`), checks: checks.state,
    ...(localBuild ? { localBuild } : {}), mergeCommit: after.mergeCommit?.oid || null, [TRUNK]: newMain, cleanup,
    summary: `Merged ${pull.url} into ${TRUNK} (approved by ${reviews.approvedBy.map(r => `@${r.who}`).join(', ')}). You are back on an up-to-date ${TRUNK}.` };
}

// Status: where the caller is, what is unsaved, the PR and how far behind main.
export function status(ctx, { fetch = true, now = Date.now() } = {}) {
  const branch = currentBranch(ctx);
  const unsaved = listChanges(ctx).map(describeChange);
  const op = operationInProgress(ctx);
  let fetched = false;
  if (fetch) { try { fetchMain(ctx); fetched = true; } catch (error) { ctx.warn(error.message); } }
  const remoteMain = revOf(ctx, ORIGIN_TRUNK);
  const result = { verb: 'status', branch, unsaved, ...(op ? { unfinished: op } : {}), fetched };
  const notes = [];
  if (remoteMain && revOf(ctx, 'HEAD')) {
    result.behindMain = count(ctx, `HEAD..${remoteMain}`);
    result.aheadOfMain = count(ctx, `${remoteMain}..HEAD`);
    if (result.behindMain) {
      const oldest = ctx.git(['log', '--reverse', '--format=%ct', `HEAD..${remoteMain}`]).split('\n')[0];
      const days = (now / 1000 - Number(oldest)) / 86400;
      if (branch !== TRUNK && days >= 1) notes.push(`${TRUNK} has had new changes for over a day; say "get the latest".`);
    }
  }
  let login = null;
  try { login = ctx.login(); } catch (error) { ctx.warn(error.message); }
  if (branch === TRUNK) notes.push(`You are on ${TRUNK}. Say "start a task: <name>" before changing anything.`);
  else if (branch && login && !isOwnBranch(branch, login)) notes.push(`${branch} is not your task branch; figma-cli will not change it.`);
  if (branch && branch !== TRUNK && login) {
    try {
      const pull = findPr(ctx, branch, { state: 'all' });
      if (pull) {
        const reviews = pullReviews(ctx, pull, login);
        const checks = checkState(pull);
        result.pr = { url: pull.url, state: pull.state, draft: !!pull.isDraft, approvedBy: reviews.approvedBy.map(r => `@${r.who}`),
          ...(reviews.staleApprovals.length ? { approvedEarlierVersionBy: reviews.staleApprovals.map(r => `@${r.who}`) } : {}),
          changesRequestedBy: reviews.changesRequestedBy.map(r => `@${r.who}`), waitingOn: reviews.waitingOn.map(r => `@${r}`), checks: checks.state };
      } else result.pr = null;
    } catch (error) { result.prError = error.message; }
  }
  if (unsaved.length) notes.push(`${unsaved.length} unsaved file${unsaved.length === 1 ? '' : 's'}; say "save my progress".`);
  if (result.pr?.state === 'OPEN' && result.pr.approvedBy.length && !result.pr.changesRequestedBy.length) notes.push('Approved; say "merge it" when ready.');
  result.summary = [branch === TRUNK ? null : branch ? `On ${branch}.` : 'Not on a branch.', ...notes].filter(Boolean).join(' ');
  return result;
}
