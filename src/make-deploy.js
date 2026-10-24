import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isIgnored, parseIgnore } from './git-tree.js';
import { requireGitMode, TREE_HIDDEN_ROOT_FILES } from './make-durable.js';
import { install as installProject } from './make-local.js';
import { readRepoAccess } from './make-mode.js';
import { detectMode, ghRunner, isRepoOnly, lfsMatcher, parseMarker, PROJECT_EXCLUDES, PROJECT_MARKER, repoName } from './make-project.js';
import { currentBranch, defaultRun, fetchMain, projectScripts, requireNoOperation, revOf, teamContext, TRUNK } from './make-team.js';

// `make deploy`: a repo admin deploys GitHub main, from a local clone, into
// the team-mode Make file. Dry run (the default) writes a reviewed plan;
// --apply re-plans, writes the planned paths through the durable client VFS,
// saves one version `deploy <sha7>`, checks the whole project root against
// main, writes a private receipt and pushes the annotated tag
// make-deploy/<n> on the deployed commit. --verify, --resume and --abort
// finish or undo an interrupted deploy from its receipt. The tag's receipt is
// the shared base `make status` and the next deploy compare against.

export const PLAN_SCHEMA = 'figma-cli/make-deploy-plan@1';
export const RECEIPT_SCHEMA = 'figma-cli/make-deploy-receipt@1';
export const TAG_PREFIX = 'make-deploy/';
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DEPLOY_CODES = Object.freeze(['DEPLOY_SOLO', 'DEPLOY_NOT_TEAM', 'DEPLOY_REPO_MISMATCH', 'DEPLOY_NOT_ADMIN', 'DEPLOY_GH_FAILED',
  'DEPLOY_NOT_MAIN', 'DEPLOY_DIRTY', 'DEPLOY_NOT_CURRENT', 'DEPLOY_UNREVIEWED', 'DEPLOY_INSTALL_FAILED', 'DEPLOY_BUILD_FAILED',
  'DEPLOY_MAKE_BUSY', 'DEPLOY_MAKE_STATE', 'DEPLOY_MAKE_AHEAD', 'DEPLOY_UNFINISHED', 'DEPLOY_BINARY', 'DEPLOY_LFS',
  'DEPLOY_UNSUPPORTED_PATH', 'DEPLOY_IGNORE', 'DEPLOY_MARKER', 'DEPLOY_NOTHING', 'DEPLOY_STALE_PLAN', 'DEPLOY_MAIN_MOVED', 'DEPLOY_TAG_CLASH',
  'DEPLOY_WRITE_FAILED', 'DEPLOY_SAVE_UNCERTAIN', 'DEPLOY_DRIFT', 'DEPLOY_TAG_FAILED', 'DEPLOY_RECEIPT', 'DEPLOY_VERIFY_FAILED']);

// Receipt stages. A blocking stage must be finished (--verify, --resume or
// --abort) before the next deploy of that file plans. After saved-drift or
// tag-clash the version exists, so the next dry run plans from it.
const BLOCKING = Object.freeze(['writing', 'written', 'saving', 'save-uncertain', 'saved-unverified', 'saved', 'tag-pending']);
const KNOWN_BASE = Object.freeze(['saved-drift', 'tag-clash']);
const BEFORE_SAVE = Object.freeze(['writing', 'written']);

// Make runs its own install in the sandbox when one of these root files
// changes, and rewrites the lockfile to match package.json (live, 1 to 2.5 s
// later). createVersion commits a lockfile only when Make's client wrote it,
// not when Make's install did: a scratch deploy that wrote the lockfile before
// package.json saved the old lockfile. So package.json goes after the other
// files and the lockfiles go last, each written through the client even when
// Make's install already holds main's content; Make is waited on until idle
// after each, and a planned one Make regenerated is written again.
const DEPENDENCY_FILES = Object.freeze([...TREE_HIDDEN_ROOT_FILES, 'package.json']);
export const isDependency = path => DEPENDENCY_FILES.includes(path);
const isLockfile = path => TREE_HIDDEN_ROOT_FILES.includes(path);
// A lockfile Make's install already rewrote to main's content before the
// deploy started: no original to back up or restore.
const noOriginal = file => isLockfile(file.path) && file.beforeSha256 === file.afterSha256;
const writeRank = path => (isLockfile(path) ? 2 : path === 'package.json' ? 1 : 0);
const byWriteOrder = (a, b) => writeRank(a.path) - writeRank(b.path) || (a.path < b.path ? -1 : 1);
// How many times one path is tried, and how many settle-and-check rounds run.
const ROUNDS = 3;
// Idle means: no busy editor, no loading state, and the persistence state and
// dependency hashes unchanged for quietMs. Live, Make never reported busy
// while its install rewrote the lockfile.
const SETTLE = Object.freeze({ quietMs: 10000, pollMs: 1000, timeoutMs: 180000 });

const sha256 = value => createHash('sha256').update(value).digest('hex');
const short = sha => String(sha).slice(0, 7);
const SHA = /^[a-f0-9]{40}$/;
const hard = parseIgnore(PROJECT_EXCLUDES.join('\n'));
const alwaysExcluded = path => isIgnored(hard, path, false) || isRepoOnly(path);

// main may commit DEPLOY_IGNORE: gitignore-style patterns for paths deploy
// never writes, creates or deletes on either side. Repo-only development files
// (docs, scripts, tests) stay in GitHub; Make-only files (Make's own AGENTS.md)
// stay in Make. A path is ignored when it or one of its folders matches. The
// file itself is repo-only. Patterns only remove paths from the comparison:
// every other path still meets every guard.
export const DEPLOY_IGNORE = '.figma-cli/deploy-ignore';
export function ignorePatterns(bytes) {
  if (bytes == null) return [];
  const text = decode(bytes);
  if (text == null) fail(`main's ${DEPLOY_IGNORE} is not UTF-8 text. Fix it through a pull request. Nothing was deployed.`, 'DEPLOY_IGNORE');
  return text.split(/\r?\n/).map(line => line.replace(/(?<!\\)\s+$/, '')).filter(line => line && !line.startsWith('#'));
}
export function ignoreMatcher(patterns = []) {
  const rules = parseIgnore(patterns.join('\n'));
  return path => path === DEPLOY_IGNORE ||
    path.split('/').some((_, index, parts) => isIgnored(rules, parts.slice(0, index + 1).join('/'), index < parts.length - 1));
}
const ignoreOf = (flat, bytes) => {
  const entry = flat.get(DEPLOY_IGNORE);
  return entry ? ignorePatterns(bytes(entry.blob)) : [];
};

export function fail(message, code, extra = {}) {
  const error = new Error(message);
  if (code) error.code = code;
  Object.assign(error, extra);
  throw error;
}

// --- private files -----------------------------------------------------------

export const deployDir = (home = homedir()) => join(home, '.figma-cli', 'deploys');

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return path;
}

function readJson(path, what) {
  let value;
  try { value = JSON.parse(readFileSync(resolve(path), 'utf8')); }
  catch (error) { fail(`Cannot read the ${what} ${path}: ${error.message}`, 'DEPLOY_RECEIPT'); }
  return value;
}

// The digest covers everything the plan decides; who applies it does not.
export function planDigest(plan) {
  const { digest, planPath, ...core } = plan;
  return sha256(JSON.stringify(core));
}

export function readPlan(path) {
  const plan = readJson(path, 'deploy plan');
  if (plan?.schema !== PLAN_SCHEMA || plan.digest !== planDigest(plan)) {
    fail(`${path} is not an unmodified deploy plan. Run a new dry run.`, 'DEPLOY_STALE_PLAN');
  }
  return plan;
}

export function readReceipt(path) {
  const receipt = readJson(path, 'deploy receipt');
  if (receipt?.schema !== RECEIPT_SCHEMA || !receipt.plan || receipt.planDigest !== planDigest(receipt.plan)) {
    fail(`${path} is not a figma-cli deploy receipt.`, 'DEPLOY_RECEIPT');
  }
  return { ...receipt, receiptPath: resolve(path) };
}

function saveReceipt(receipt) {
  const { receiptPath, ...body } = receipt;
  writeJson(receiptPath, body);
}

// Local receipts for one Make file that are not finished.
export function openReceipts(fileKey, { home } = {}) {
  const dir = deployDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => {
    try { return { ...JSON.parse(readFileSync(join(dir, name), 'utf8')), receiptPath: join(dir, name) }; }
    catch { return null; }
  }).filter(receipt => receipt?.schema === RECEIPT_SCHEMA && receipt.fileKey === fileKey && receipt.outcome === 'uncertain' && !receipt.supersededBy);
}

const recovery = receipt => {
  const where = `--file ${receipt.fileKey} --dir <clone>`;
  if (BEFORE_SAVE.includes(receipt.stage)) return `figma-cli make deploy ${where} --resume ${receipt.receiptPath} (or --abort to restore Make)`;
  return `figma-cli make deploy ${where} --verify ${receipt.receiptPath}`;
};

// --- the local clone and GitHub ---------------------------------------------

// Every file of a commit or tree: path → { mode, type, blob }.
export function lsTree(ctx, rev) {
  const out = ctx.git(['ls-tree', '-r', '-z', '--full-tree', rev], `Reading the files of ${short(rev)}`);
  const flat = new Map();
  for (const entry of out.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, type, blob] = entry.slice(0, tab).split(' ');
    flat.set(entry.slice(tab + 1), { mode, type, blob });
  }
  return flat;
}

export function defaultReadBlob(root, blob) {
  const result = spawnSync('git', ['cat-file', 'blob', blob], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) fail(`Reading git object ${short(blob)} failed: ${String(result.stderr).trim().split('\n').pop()}`);
  return result.stdout;
}

// Deploy tags on GitHub, newest first: [{ n, name }].
export function remoteTags(ctx) {
  const out = ctx.git(['ls-remote', '--tags', 'origin', `refs/tags/${TAG_PREFIX}*`], 'Reading the deploy tags on GitHub');
  const tags = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const n = new RegExp(`^refs/tags/${TAG_PREFIX}(\\d+)$`).exec(line.split('\t')[1] || '')?.[1];
    if (n != null) tags.set(Number(n), `${TAG_PREFIX}${n}`);
  }
  return [...tags].sort((a, b) => b[0] - a[0]).map(([n, name]) => ({ n, name }));
}

const receiptJson = message => {
  const start = typeof message === 'string' ? message.indexOf('{') : -1;
  if (start < 0) return null;
  try { return JSON.parse(message.slice(start)); } catch { return null; }
};

// The newest tag's base: the tagged commit's tree. A receipt naming another
// tree is refused rather than trusted.
export function tagBase(ctx, tag) {
  ctx.git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/tags/${tag.name}:refs/tags/${tag.name}`], `Reading ${tag.name} from GitHub`);
  const commit = revOf(ctx, `refs/tags/${tag.name}`);
  if (!commit) fail(`${tag.name} does not point at a commit.`, 'DEPLOY_MAKE_STATE');
  const annotated = ctx.git(['cat-file', '-t', `refs/tags/${tag.name}`]) === 'tag';
  const receipt = annotated ? receiptJson(ctx.git(['cat-file', 'tag', `refs/tags/${tag.name}`])) : null;
  const commitTree = ctx.git(['rev-parse', `${commit}^{tree}`]);
  if (receipt?.mainTree != null && receipt.mainTree !== commitTree) {
    fail(`${tag.name}'s receipt names main tree ${receipt.mainTree}, but the tagged commit's tree is ${commitTree}. Nothing was deployed.`, 'DEPLOY_MAKE_STATE');
  }
  return { source: 'tag', tag: tag.name, commit, mainTree: commitTree, flat: lsTree(ctx, commitTree) };
}

async function ghCall(gh, args, what) {
  try { return await gh(args); }
  catch (error) { fail(`${what} through gh failed: ${error.message}. Check gh auth status. Nothing was deployed.`, 'DEPLOY_GH_FAILED'); }
}

// Deployers are the repo's admins, read through the caller's own gh login.
export async function requireAdmin(repo, gh) {
  let access;
  try { access = await readRepoAccess(repo, { gh }); }
  catch (error) { fail(`Cannot read ${repo} through gh: ${error.message}. Check gh auth status. Nothing was deployed.`, 'DEPLOY_GH_FAILED'); }
  if (access.permission !== 'admin') {
    fail(`Only admins of ${repo} may deploy to Make; your GitHub permission is ${access.permission}. Ask a repo admin to deploy.`, 'DEPLOY_NOT_ADMIN');
  }
  return access;
}

// main is unprotected, so review is a convention; deploy takes only a commit
// that arrived through a pull request merged into main.
export async function requireMergedPr(repo, sha, gh) {
  const pulls = await ghCall(gh, [`repos/${repo}/commits/${sha}/pulls`], `Checking how main ${short(sha)} landed`);
  const pr = (Array.isArray(pulls) ? pulls : []).find(pull => pull.merged_at && pull.base?.ref === TRUNK);
  if (!pr) {
    fail(`main ${short(sha)} did not arrive through a pull request merged into main, so it is not deployed. ` +
      'Land changes through a reviewed pull request (figma-cli team pr, then team merge).', 'DEPLOY_UNREVIEWED');
  }
  return pr.html_url || null;
}

const tail = (text, lines = 15) => String(text).trim().split('\n').slice(-lines).join('\n');

export function defaultBuild(ctx) {
  const build = projectScripts(ctx.root).find(script => script.name === 'build');
  if (!build) fail('package.json has no build script, so the deploy cannot prove main builds. Add one through a pull request.', 'DEPLOY_BUILD_FAILED');
  const result = ctx.run(build.command, build.args, { cwd: ctx.root });
  if (result.status !== 0) {
    fail(`main does not build (${build.command} ${build.args.join(' ')}), so nothing was deployed. Its last lines:\n${tail(result.stdout + result.stderr)}`, 'DEPLOY_BUILD_FAILED');
  }
  return `${build.command} ${build.args.join(' ')}`;
}

function requireClean(ctx, after) {
  const dirty = ctx.git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (dirty) {
    fail(after ? 'Installing or building main changed files git sees. Ignore build output in .gitignore through a pull request, then deploy again.'
      : 'The clone has uncommitted or untracked files. Deploy runs from a clean main; save or remove them first.', 'DEPLOY_DIRTY');
  }
}

// The local side of the guard list. Returns the clone context and main.
export function localMain(ctx, repo, { fetch = true } = {}) {
  requireNoOperation(ctx);
  const cloneRepo = ctx.repo();
  if (cloneRepo.toLowerCase() !== repo.toLowerCase()) {
    fail(`This clone belongs to ${cloneRepo}, but the Make file deploys from ${repo}. Run the deploy in a clone of ${repo}.`, 'DEPLOY_REPO_MISMATCH');
  }
  const branch = currentBranch(ctx);
  if (branch !== TRUNK) fail(`The clone is on ${branch ?? 'a detached HEAD'}, not ${TRUNK}. Deploy runs from main: switch to it (figma-cli make pull).`, 'DEPLOY_NOT_MAIN');
  requireClean(ctx, false);
  const origin = fetch ? fetchMain(ctx) : revOf(ctx, `refs/remotes/origin/${TRUNK}`);
  const head = revOf(ctx, 'HEAD');
  if (!origin || head !== origin) {
    fail(`Local main ${short(head)} is not GitHub's main ${short(origin)}. Run figma-cli make pull, then deploy again.`, 'DEPLOY_NOT_CURRENT');
  }
  return { commit: head, tree: ctx.git(['rev-parse', `${head}^{tree}`]) };
}

// --- Make state and the plan -------------------------------------------------

// Paths whose content differs (git blob), ignoring file modes: Make commits
// files it writes as 100644 whatever main says.
export function contentDiff(a, b, skip = () => false) {
  return [...new Set([...a.keys(), ...b.keys()])].filter(path => !skip(path) && a.get(path)?.blob !== b.get(path)?.blob).sort();
}

// mainFlat: a lockfile Make's own install rewrote to main's content is not an
// edit (the deploy writes it again through the client).
export function requireMakeReady(status, ui, mainFlat = new Map()) {
  if (ui?.busy || ui?.offline || ui?.readOnly === true) fail('Make is busy, offline or read-only. Wait until it is idle, then deploy again.', 'DEPLOY_MAKE_BUSY');
  let state;
  try { state = requireGitMode(status.persistence); }
  catch (error) { fail(`Make is not ready for a deploy: ${error.message}`, 'DEPLOY_MAKE_STATE'); }
  if (state.pendingPaths.length) fail(`Make has ${state.pendingPaths.length} unsaved change(s) ${JSON.stringify(state.pendingPaths)}. Nothing was deployed.`, 'DEPLOY_MAKE_AHEAD');
  if (status.treeSource !== 'saved-version') fail('Make\'s saved version was not readable as the deploy base.', 'DEPLOY_MAKE_STATE');
  if (status.history?.generationInProgress) fail('A Make AI generation is running. Nothing was deployed.', 'DEPLOY_MAKE_BUSY');
  const unsaved = contentDiff(status.workingFlat, status.makeFlat)
    .filter(path => !(isLockfile(path) && status.workingFlat.get(path)?.blob === mainFlat.get(path)?.blob));
  if (unsaved.length) fail(`Make's working copy has unsaved edits in ${JSON.stringify(unsaved)}. Nothing was deployed.`, 'DEPLOY_MAKE_AHEAD');
  return state;
}

// Make must hold exactly what the last deploy put there. The base is the
// newest tag's mainTree; on the first deploy it is Make's saved tree itself.
// ignored: paths main's or the base's DEPLOY_IGNORE kept out of deploys.
export function requireBase(status, base, { isLfs = () => false, ignored = () => false } = {}) {
  const skip = path => alwaysExcluded(path) || ignored(path) || isLfs(path) || (path === PROJECT_MARKER && !base.flat.has(PROJECT_MARKER));
  const ahead = contentDiff(status.makeFlat, base.flat, skip);
  if (ahead.length) {
    fail(`Make was edited outside deploys since ${base.tag}: ${ahead.length} path(s) differ from what was deployed ${JSON.stringify(ahead.slice(0, 20))}. ` +
      'Deploy refuses to overwrite them (make-ahead). Bring them into main first with the coming make rescue step, then deploy.', 'DEPLOY_MAKE_AHEAD', { paths: ahead });
  }
}

const ignoredReason = (path, m, k) => {
  if (path === DEPLOY_IGNORE) return 'never deployed: the deploy ignore list stays in the repo';
  if (!k) return `listed in ${DEPLOY_IGNORE}: stays in the repo, never created in Make`;
  if (!m) return `listed in ${DEPLOY_IGNORE}: Make keeps its own, never deleted`;
  return `listed in ${DEPLOY_IGNORE}: neither side is changed`;
};

const decode = bytes => {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.includes('\0') ? null : text;
  } catch { return null; }
};

// Compare main with Make's saved tree and decide every path. Pure apart from
// mainBytes(blob), which reads a blob from the clone.
export function buildPlan({ fileKey, repo, n, main, status, base, mainBytes }) {
  const patterns = ignoreOf(main.flat, mainBytes);
  const ignored = ignoreMatcher(patterns);
  const gitattributes = main.flat.get('.gitattributes');
  const mainLfs = lfsMatcher(gitattributes ? mainBytes(gitattributes.blob).toString('utf8') : null);
  const isLfs = path => mainLfs(path) || (status.isLfs ? status.isLfs(path) : false);
  const makeFolders = new Set([...status.workingFlat.keys()].filter(path => path.includes('/')).map(path => path.split('/')[0]));
  const files = [];
  const excluded = [];
  const modeOnly = [];
  const refused = { binary: [], lfs: [], unsupported: [], marker: [] };
  for (const path of [...new Set([...main.flat.keys(), ...status.makeFlat.keys()])].sort()) {
    const m = main.flat.get(path);
    const k = status.makeFlat.get(path);
    if (alwaysExcluded(path)) {
      excluded.push({ path, reason: isRepoOnly(path) ? 'never deployed: project vault notes stay in the repo' : 'never deployed: Make manages it or it can hold secrets' });
      continue;
    }
    if (ignored(path)) { excluded.push({ path, reason: ignoredReason(path, m, k) }); continue; }
    if (path === PROJECT_MARKER && !m) { excluded.push({ path, reason: 'main has no team marker; Make keeps its own' }); continue; }
    if (m && (m.type !== 'blob' || !['100644', '100755'].includes(m.mode))) { refused.unsupported.push(`${path} (${m.type === 'commit' ? 'submodule' : 'symbolic link'})`); continue; }
    if (m?.blob === k?.blob) {
      if (m.mode !== k.mode) modeOnly.push(path);
      continue;
    }
    if (isLfs(path)) { refused.lfs.push(path); continue; }
    const op = !k ? 'add' : !m ? 'delete' : 'modify';
    const top = path.split('/')[0];
    if ((op !== 'modify' && !path.includes('/')) || (op === 'add' && !top.startsWith('.') && !makeFolders.has(top))) {
      refused.unsupported.push(path);
      continue;
    }
    let afterSha256 = null;
    let bytes = null;
    if (m) {
      const content = mainBytes(m.blob);
      if (content.length > MAX_FILE_BYTES || decode(content) == null) { refused.binary.push(path); continue; }
      if (path === PROJECT_MARKER) {
        const marker = parseMarker(content, fileKey);
        if (marker.state !== 'valid' || marker.repo.toLowerCase() !== repo.toLowerCase() || marker.trunk !== TRUNK) {
          refused.marker.push(marker.reason || `names ${marker.repo} (${marker.trunk})`);
          continue;
        }
      }
      afterSha256 = sha256(content);
      bytes = content.length;
    }
    const beforeSha256 = k ? status.workingSha256?.get(path) : null;
    if (k && !/^[a-f0-9]{64}$/.test(beforeSha256 || '')) fail(`Make's content hash for ${path} is unavailable.`, 'DEPLOY_MAKE_STATE');
    files.push({ path, op, beforeBlob: k?.blob ?? null, afterBlob: m?.blob ?? null, beforeSha256, afterSha256, bytes });
  }
  files.sort(byWriteOrder);
  if (refused.marker.length) fail(`main's ${PROJECT_MARKER} would change this file's team mode (${refused.marker[0]}). Fix it in main through a pull request.`, 'DEPLOY_MARKER');
  if (refused.binary.length) {
    fail(`Deploy writes UTF-8 text only (at most 2 MiB a file); main has binary or large files that differ from Make: ${JSON.stringify(refused.binary)}. ` +
      'Add those in Make by hand, or keep them out of main. Nothing was deployed.', 'DEPLOY_BINARY', { paths: refused.binary });
  }
  if (refused.lfs.length) {
    fail(`Git LFS files differ between main and Make: ${JSON.stringify(refused.lfs)}. Make stores LFS pointers, so deploy refuses them. Nothing was deployed.`, 'DEPLOY_LFS', { paths: refused.lfs });
  }
  if (refused.unsupported.length) {
    fail(`Make cannot take these changes through figma-cli: ${JSON.stringify(refused.unsupported)}. Files directly in the project root or in a new ` +
      'top-level folder cannot be created or deleted, and submodules and symbolic links are unsupported. Nothing was deployed.', 'DEPLOY_UNSUPPORTED_PATH', { paths: refused.unsupported });
  }
  const plan = { schema: PLAN_SCHEMA, fileKey, repo, trunk: TRUNK, n, tag: `${TAG_PREFIX}${n}`,
    mainCommit: main.commit, mainTree: main.tree,
    makeBefore: { versionGitSha: status.persistence.savedVersion, tree: status.makeTree },
    base: { source: base.source, ...(base.tag ? { tag: base.tag } : {}), ...(base.mainTree ? { mainTree: base.mainTree } : {}),
      ...(base.receipt ? { receipt: base.receipt } : {}) },
    ...(main.flat.has(DEPLOY_IGNORE) ? { ignore: { path: DEPLOY_IGNORE, blob: main.flat.get(DEPLOY_IGNORE).blob, patterns } } : {}),
    files, excluded, modeOnly };
  return { ...plan, digest: planDigest(plan) };
}

// Paths outside the deploy comparison, as the plan recorded them, and any
// path main's DEPLOY_IGNORE patterns name (a Make-only file added later too).
const skipOf = plan => {
  const excluded = new Set(plan.excluded.map(entry => entry.path));
  const ignored = ignoreMatcher(plan.ignore?.patterns);
  return path => alwaysExcluded(path) || excluded.has(path) || ignored(path);
};

// --- the shared guard run ----------------------------------------------------

function defaults(deps = {}) {
  const run = deps.run || defaultRun;
  return { run, gh: deps.gh || ghRunner(), home: deps.home, now: deps.now || (() => new Date()), warn: deps.warn || (() => {}),
    readBlob: deps.readBlob || defaultReadBlob,
    install: deps.install || (ctx => installProject(ctx.root, { run, warn: deps.warn || (() => {}) })),
    build: deps.build || defaultBuild, settle: { ...SETTLE, ...deps.settle },
    sleep: deps.sleep || (ms => new Promise(done => setTimeout(done, ms))) };
}

// The team mode the Make file is in. Solo has nothing to deploy from.
export async function requireTeamMode(client, status) {
  const vfs = await client.projectMarker();
  const sandbox = status ? status.markerBytes ?? null : vfs;
  if ((vfs == null) !== (sandbox == null) || (vfs && !Buffer.from(vfs).equals(Buffer.from(sandbox)))) {
    fail(`Make client VFS and sandbox disagree on ${PROJECT_MARKER}. Nothing was deployed.`, 'DEPLOY_MAKE_STATE');
  }
  const mode = detectMode(parseMarker(vfs, client.fileKey));
  if (mode.mode === 'solo') {
    fail('This Make file is in solo mode: no GitHub repo is linked, so there is nothing to deploy from. Edit it in Make directly, ' +
      'or link a repo with figma-cli make mode team --repo owner/repo.', 'DEPLOY_SOLO');
  }
  if (mode.mode !== 'team') fail(`Deploy needs a team-mode Make file: ${mode.reason}.`, 'DEPLOY_NOT_TEAM');
  if (mode.trunk !== TRUNK) fail(`${PROJECT_MARKER} names trunk ${mode.trunk}; deploy takes ${TRUNK} only.`, 'DEPLOY_NOT_TEAM');
  return mode;
}

async function prepare(client, { dir, reviewed }, deps) {
  const { run, gh, home, readBlob, install, build } = deps;
  // Compare with the sandbox from the start: a stale client VFS must not read as solo.
  const mode = await requireTeamMode(client, await client.projectStatus());
  const repo = repoName(mode.repo);
  const ctx = teamContext({ dir: resolve(dir || '.'), run, warn: deps.warn });
  const main = localMain(ctx, repo);
  const access = await requireAdmin(repo, gh);
  const pr = await requireMergedPr(repo, main.commit, gh);
  try { install(ctx); }
  catch (error) { fail(`Installing main's dependencies failed, so nothing was deployed: ${error.message}`, 'DEPLOY_INSTALL_FAILED'); }
  const built = build(ctx);
  requireClean(ctx, true);
  const tags = remoteTags(ctx);
  const n = tags.length ? tags[0].n + 1 : 0;
  if (reviewed && tags.some(tag => tag.name === reviewed.tag)) {
    fail(`${reviewed.tag} was taken by another deploy since the dry run. Run a new dry run. Nothing was deployed.`, 'DEPLOY_TAG_CLASH');
  }

  const unfinished = openReceipts(client.fileKey, { home });
  const blocking = unfinished.find(receipt => BLOCKING.includes(receipt.stage));
  if (blocking) {
    fail(`An earlier deploy of this file (${blocking.deployId}) is unfinished at stage ${blocking.stage}. Finish it first: ${recovery(blocking)}.`, 'DEPLOY_UNFINISHED',
      { receiptPath: blocking.receiptPath });
  }
  const ui = await client.inspect();
  const status = await client.projectStatus();
  await requireTeamMode(client, status);
  const mainFlat = lsTree(ctx, main.commit);
  const state = requireMakeReady(status, ui, mainFlat);
  const gitattributes = mainFlat.get('.gitattributes');
  const mainLfs = lfsMatcher(gitattributes ? readBlob(ctx.root, gitattributes.blob).toString('utf8') : null);
  const isLfs = path => mainLfs(path) || (status.isLfs ? status.isLfs(path) : false);
  // A version an earlier deploy saved but did not finish is a known base.
  const own = unfinished.find(receipt => KNOWN_BASE.includes(receipt.stage) && receipt.makeAfter?.versionGitSha === state.savedVersion);
  let base;
  if (own) base = { source: 'receipt', receipt: own.deployId, flat: status.makeFlat };
  else if (tags.length) {
    base = tagBase(ctx, tags[0]);
    const blob = hash => readBlob(ctx.root, hash);
    const now = ignoreMatcher(ignoreOf(mainFlat, blob));
    const then = ignoreMatcher(ignoreOf(base.flat, blob));
    requireBase(status, base, { isLfs, ignored: path => now(path) || then(path) });
  } else base = { source: 'first-deploy', flat: status.makeFlat };
  const plan = buildPlan({ fileKey: client.fileKey, repo, n, main: { ...main, flat: mainFlat }, status, base,
    mainBytes: blob => readBlob(ctx.root, blob) });
  return { ctx, repo, access, pr, built, main: { ...main, flat: mainFlat }, status, plan };
}

const counts = files => ({ add: files.filter(f => f.op === 'add').length, modify: files.filter(f => f.op === 'modify').length,
  delete: files.filter(f => f.op === 'delete').length });
const countText = c => `${c.add} new, ${c.modify} changed and ${c.delete} deleted file(s)`;
const excludedText = plan => (plan.excluded.length ? ` ${plan.excluded.length} excluded path(s) stay as they are on each side.` : '');

// --- dry run -----------------------------------------------------------------

export async function deployPlan(client, { dir } = {}, deps = {}) {
  deps = defaults(deps);
  const { plan, access, pr, built } = await prepare(client, { dir }, deps);
  const c = counts(plan.files);
  const planPath = join(deployDir(deps.home), 'plans', `${plan.fileKey}-${short(plan.mainCommit)}-${plan.digest.slice(0, 12)}.json`);
  if (plan.files.length) writeJson(planPath, plan);
  return { dryRun: true, fileKey: plan.fileKey, repo: plan.repo, who: access.login, mainCommit: plan.mainCommit, pr, build: built,
    base: plan.base, tag: plan.tag, counts: c, files: plan.files.map(({ path, op }) => ({ path, op })),
    excluded: plan.excluded, excludedCount: plan.excluded.length, ...(plan.ignore ? { ignore: plan.ignore } : {}),
    modeOnly: plan.modeOnly, digest: plan.digest,
    ...(plan.files.length ? { planPath, next: `figma-cli make deploy --file ${plan.fileKey} --dir ${dir || '.'} --apply ${planPath}` } : {}),
    summary: plan.files.length
      ? `Deploying main ${short(plan.mainCommit)} would write ${countText(c)} to Make and save it as one version "deploy ${short(plan.mainCommit)}", tagged ${plan.tag}.${excludedText(plan)} Nothing was changed yet.`
      : `Make already matches main ${short(plan.mainCommit)}; there is nothing to deploy.${excludedText(plan)}` };
}

// --- apply, resume and the shared finish ------------------------------------

function newReceipt(plan, who, at, home) {
  const deployId = `${at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${plan.fileKey}-${short(plan.mainCommit)}`;
  return { schema: RECEIPT_SCHEMA, deployId, who, at, repo: plan.repo, mainCommit: plan.mainCommit, mainTree: plan.mainTree,
    fileKey: plan.fileKey, tag: { name: plan.tag, n: plan.n, pushed: false }, makeBefore: plan.makeBefore, makeAfter: null,
    planDigest: plan.digest, files: plan.files.map(({ path, op, beforeSha256, afterSha256 }) => ({ path, op, beforeSha256, afterSha256, backupPath: null })),
    excluded: plan.excluded, excludedCount: plan.excluded.length, base: plan.base, completedWrites: [], stage: 'writing', outcome: 'uncertain', verification: null, error: null,
    plan, receiptPath: join(deployDir(home), `${deployId}.json`) };
}

const backupDir = (receipt, home) => join(deployDir(home), 'backups', receipt.deployId);

function stop(receipt, error, stage, message, code) {
  receipt.stage = stage;
  receipt.error = error?.message ?? message;
  saveReceipt(receipt);
  fail(`${message} Receipt: ${receipt.receiptPath}.`, code, { receiptPath: receipt.receiptPath, ...(receipt.makeAfter ? { version: receipt.makeAfter } : {}) });
}

// Wait until Make is idle: its own install after a dependency write rewrites
// files and the pending list for a while.
async function waitIdle(client, receipt, deps) {
  const { quietMs, pollMs, timeoutMs } = deps.settle;
  const paths = receipt.plan.files.map(file => file.path).filter(isDependency);
  const start = Date.now();
  let last = null;
  let since = 0;
  for (;;) {
    const probe = await client.idleState(paths);
    const idle = !probe.busy && !probe.offline && probe.state && !probe.state.isLoading && !probe.state.error;
    const key = idle ? JSON.stringify(probe) : null;
    if (key && key === last && Date.now() - since >= quietMs) return;
    if (key !== last) { last = key; since = Date.now(); }
    if (Date.now() - start > timeoutMs) {
      stop(receipt, null, receipt.stage, `Make did not become idle within ${Math.round(timeoutMs / 1000)}s. No version was saved. ` +
        `Run ${recovery(receipt)} once it is idle.`, 'DEPLOY_MAKE_BUSY');
    }
    await deps.sleep(pollMs);
  }
}

async function settledStatus(client, receipt, deps) {
  for (let attempt = 1; ; attempt++) {
    await waitIdle(client, receipt, deps);
    try { return await client.projectStatus(); }
    catch (error) {
      if (attempt >= ROUNDS) stop(receipt, error, receipt.stage, `Make could not be read once idle: ${error.message} Run ${recovery(receipt)}.`, 'DEPLOY_MAKE_STATE');
    }
  }
}

// Every path Make holds unsaved must be planned and hold its before or
// planned content; only a planned dependency file may hold what Make's own
// install regenerated. Returns { problem, code } or { files } (classified).
function plannedState(receipt, status) {
  const state = status.persistence;
  if (state?.savedVersion !== receipt.makeBefore.versionGitSha) {
    return { problem: `Make's saved version is ${state?.savedVersion ?? 'unknown'}, not ${receipt.makeBefore.versionGitSha} where the deploy started`, code: 'DEPLOY_RECEIPT' };
  }
  const planned = new Set(receipt.plan.files.map(file => file.path));
  const others = [...new Set([...contentDiff(status.workingFlat, status.makeFlat), ...(state.pendingPaths || [])])].filter(path => !planned.has(path));
  if (others.length) return { problem: `Make has unsaved changes outside the deploy ${JSON.stringify(others)}`, code: 'DEPLOY_MAKE_AHEAD' };
  const files = classify(receipt, status);
  const odd = files.filter(file => file.state === 'other').map(file => file.path);
  if (odd.length) return { problem: `Make holds content the deploy neither started from nor planned in ${JSON.stringify(odd)}`, code: 'DEPLOY_RECEIPT' };
  return { files };
}

const recordWrite = (receipt, file, backupPath, extra = {}) => {
  receipt.completedWrites.push({ path: file.path, op: file.op, backupPath: backupPath ?? null, ...extra });
  const entry = receipt.files.find(item => item.path === file.path);
  if (entry && backupPath && !extra.uncertain) entry.backupPath = backupPath;
  saveReceipt(receipt);
};

// Write each file to main's content. A file starts from its planned before
// content, or from file.expectedSha256 (Make's regenerated dependency file).
// When Make's state moves under a write, wait until it is idle, re-check
// every unsaved path against the plan, then try that path again.
async function writeFiles(client, receipt, todo, { mainBytes, home, deps }) {
  for (const file of [...todo].sort(byWriteOrder)) {
    let content = null;
    if (file.op !== 'delete') {
      const bytes = mainBytes(file.afterBlob);
      if (sha256(bytes) !== file.afterSha256) {
        stop(receipt, null, 'writing', `main's ${file.path} no longer has its planned content. No version was saved. Run ${recovery(receipt)}.`, 'DEPLOY_WRITE_FAILED');
      }
      content = decode(bytes);
    }
    let expected = file.expectedSha256 !== undefined ? file.expectedSha256 : file.beforeSha256;
    for (let attempt = 1; ; attempt++) {
      let result;
      try {
        if (file.op === 'delete') result = await client.deleteDurable(file.path, { expectedSha256: expected, backupDir: backupDir(receipt, home) });
        else {
          result = await client.writeDurable(file.path, content, { expectedSha256: expected ?? undefined, backupDir: backupDir(receipt, home),
            rewrite: isLockfile(file.path) });
        }
      } catch (error) {
        if (error.backupPath) recordWrite(receipt, file, error.backupPath, { uncertain: true });
        if (attempt >= ROUNDS || (error.code !== 'MAKE_PENDING_CHANGED' && !isDependency(file.path))) {
          stop(receipt, error, 'writing', `Deploy stopped while writing ${file.path}: ${error.message} No version was saved. Run ${recovery(receipt)}.`, 'DEPLOY_WRITE_FAILED');
        }
        const status = await settledStatus(client, receipt, deps);
        const checked = plannedState(receipt, status);
        if (checked.problem) {
          stop(receipt, error, 'writing', `Deploy stopped while writing ${file.path}: ${error.message} Once Make was idle: ${checked.problem}. ` +
            `No version was saved. Run ${recovery(receipt)}.`, checked.code === 'DEPLOY_MAKE_AHEAD' ? 'DEPLOY_MAKE_AHEAD' : 'DEPLOY_WRITE_FAILED');
        }
        // Make's install may already hold main's lockfile; the client must
        // still write it, or the version keeps the old one.
        if (checked.files.find(item => item.path === file.path).state === 'after' && !isLockfile(file.path)) { recordWrite(receipt, file, null); break; }
        expected = status.workingSha256.get(file.path) ?? null;
        continue;
      }
      recordWrite(receipt, file, result?.backupPath);
      break;
    }
    if (isDependency(file.path)) await waitIdle(client, receipt, deps);
  }
  receipt.stage = 'written';
  saveReceipt(receipt);
}

// Make's install rewrites a planned lockfile as soon as package.json is
// written, so its start content is backed up first, for --abort.
async function backupLockfiles(client, receipt, home) {
  for (const file of receipt.plan.files.filter(item => isLockfile(item.path) && item.op === 'modify' && !noOriginal(item))) {
    if (receipt.completedWrites.some(write => write.path === file.path && write.backupPath)) continue;
    const { exists, content } = await client.readDurable(file.path);
    if (!exists || sha256(content) !== file.beforeSha256) continue;
    const dir = join(backupDir(receipt, home), `deploy-${file.path}-${file.beforeSha256.slice(0, 12)}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'original.txt'), content, { mode: 0o600 });
    writeFileSync(join(dir, 'metadata.json'), `${JSON.stringify({ fileKey: receipt.fileKey, path: file.path, sha256: file.beforeSha256, operation: 'deploy-lockfile' })}\n`, { mode: 0o600 });
    recordWrite(receipt, { path: file.path, op: 'backup' }, join(dir, 'original.txt'), { backupOnly: true });
  }
}

// Make's install can rewrite a dependency file after the deploy wrote it.
// Once Make is idle every planned path must hold main's content; a dependency
// file Make regenerated is written again, for at most ROUNDS rounds.
async function reconcile(client, receipt, { mainBytes, home, deps }) {
  if (!receipt.plan.files.some(file => isDependency(file.path))) return;
  for (let round = 1; ; round++) {
    const status = await settledStatus(client, receipt, deps);
    const checked = plannedState(receipt, status);
    if (checked.problem) {
      stop(receipt, null, 'written', `Once Make was idle after the writes: ${checked.problem}. No version was saved. Run ${recovery(receipt)}.`,
        checked.code === 'DEPLOY_MAKE_AHEAD' ? 'DEPLOY_MAKE_AHEAD' : 'DEPLOY_WRITE_FAILED');
    }
    const left = checked.files.filter(file => file.state !== 'after');
    if (!left.length) return;
    if (round > ROUNDS || left.some(file => !isDependency(file.path))) {
      stop(receipt, null, 'written', `Make keeps changing ${JSON.stringify(left.map(file => file.path))} after the deploy wrote main's content, ` +
        `so main cannot be saved as it is. No version was saved. Run ${recovery(receipt)}.`, 'DEPLOY_WRITE_FAILED');
    }
    receipt.stage = 'writing';
    await writeFiles(client, receipt, left.map(file => ({ ...file, expectedSha256: status.workingSha256.get(file.path) ?? null })), { mainBytes, home, deps });
  }
}

// The public part of a receipt, carried in the tag's message.
const publicReceipt = receipt => ({ schema: receipt.schema, deployId: receipt.deployId, n: receipt.tag.n, who: receipt.who, at: receipt.at,
  repo: receipt.repo, mainCommit: receipt.mainCommit, mainTree: receipt.mainTree, fileKey: receipt.fileKey,
  makeBefore: receipt.makeBefore, makeAfter: receipt.makeAfter, planDigest: receipt.planDigest,
  files: receipt.files.map(({ path, op, beforeSha256, afterSha256 }) => ({ path, op, beforeSha256, afterSha256 })),
  excluded: receipt.excluded, excludedCount: receipt.excluded.length });

// Who holds make-deploy/<n> on GitHub: null when nobody, 'ours' when it tags
// this receipt's commit with this deployId, otherwise 'theirs'.
function remoteTagHolder(ctx, receipt) {
  const name = receipt.tag.name;
  if (!remoteTags(ctx).some(tag => tag.name === name)) return null;
  ctx.git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/tags/${name}:refs/tags/${name}`], `Reading ${name} from GitHub`);
  const ours = revOf(ctx, `refs/tags/${name}`) === receipt.mainCommit &&
    receiptJson(ctx.tryGit(['cat-file', 'tag', `refs/tags/${name}`]).stdout)?.deployId === receipt.deployId;
  return ours ? 'ours' : 'theirs';
}

// Push the annotated tag make-deploy/<n>. Another deploy's tag under that
// number is a clash; this deploy's own tag already on GitHub is pushed.
export function pushTag(ctx, receipt) {
  const name = receipt.tag.name;
  const holder = remoteTagHolder(ctx, receipt);
  if (holder) return holder === 'ours' ? 'pushed' : 'clash';
  const message = `${name}: deploy ${short(receipt.mainCommit)} to Figma Make ${receipt.fileKey}, version ${receipt.makeAfter.versionNumber ?? 'unknown'}\n\n` +
    `${JSON.stringify(publicReceipt(receipt))}\n`;
  ctx.git(['tag', '-a', '-f', '-m', message, name, receipt.mainCommit], `Creating ${name}`);
  const pushed = ctx.tryGit(['push', '--quiet', 'origin', `refs/tags/${name}:refs/tags/${name}`]);
  if (pushed.status === 0) return 'pushed';
  ctx.tryGit(['tag', '-d', name]);
  const after = remoteTagHolder(ctx, receipt);
  return after === 'ours' ? 'pushed' : after ? 'clash' : 'failed';
}

async function tagAndFinish(ctx, receipt, home) {
  const result = pushTag(ctx, receipt);
  if (result === 'clash') {
    stop(receipt, null, 'tag-clash', `Make saved version ${receipt.makeAfter.versionNumber} with main ${short(receipt.mainCommit)}, but ${receipt.tag.name} ` +
      'was taken by another deploy. Run a new dry run; it plans from this version.', 'DEPLOY_TAG_CLASH');
  }
  if (result === 'failed') {
    stop(receipt, null, 'tag-pending', `Make saved version ${receipt.makeAfter.versionNumber}, but pushing ${receipt.tag.name} to GitHub failed. ` +
      `Run ${recovery(receipt)} to push it.`, 'DEPLOY_TAG_FAILED');
  }
  receipt.tag.pushed = true;
  receipt.stage = 'deployed';
  receipt.outcome = 'ok';
  receipt.error = null;
  saveReceipt(receipt);
  for (const older of openReceipts(receipt.fileKey, { home }).filter(item => item.deployId !== receipt.deployId && KNOWN_BASE.includes(item.stage))) {
    saveReceipt({ ...older, supersededBy: receipt.deployId });
  }
}

// After the writes: one version, the full-root drift check, then the tag.
async function finish(client, ctx, receipt, mainFlat, home) {
  const plan = receipt.plan;
  receipt.stage = 'saving';
  saveReceipt(receipt);
  let version;
  try {
    version = await client.saveCheckedVersion(`deploy ${short(plan.mainCommit)}`, plan.files.map(file => file.path), { listed: true });
  } catch (error) {
    if (error.version) {
      receipt.makeAfter = { versionId: error.version.versionId, versionNumber: error.version.versionNumber, versionGitSha: error.version.gitSha, tree: null };
      stop(receipt, error, 'saved-unverified', `Make created version ${error.version.versionNumber} but did not confirm it: ${error.message} ` +
        `Never retry the save; run ${recovery(receipt)}.`, 'DEPLOY_SAVE_UNCERTAIN');
    }
    if (error.createVersionCalled) {
      stop(receipt, error, 'save-uncertain', `Make's save outcome is unknown: ${error.message} Never retry the save; run ${recovery(receipt)}.`, 'DEPLOY_SAVE_UNCERTAIN');
    }
    stop(receipt, error, 'written', `Make refused the save before creating a version: ${error.message} Run ${recovery(receipt)}.`, 'DEPLOY_WRITE_FAILED');
  }
  receipt.makeAfter = { versionId: version.versionId, versionNumber: version.versionNumber, versionGitSha: version.gitSha, tree: version.tree };
  receipt.stage = 'saved';
  saveReceipt(receipt);
  let after;
  try { after = await client.projectStatus(); }
  catch (error) { stop(receipt, error, 'saved', `Saved version ${version.versionNumber}, but its drift check could not read Make: ${error.message} Run ${recovery(receipt)}.`, 'DEPLOY_DRIFT'); }
  const problems = driftProblems(after, receipt, mainFlat);
  if (problems.length) {
    stop(receipt, null, 'saved-drift', `Saved version ${version.versionNumber}, but Make does not equal main ${short(plan.mainCommit)}: ${problems.join('; ')}. ` +
      'Stop and look; the next dry run plans from this version.', 'DEPLOY_DRIFT');
  }
  receipt.verification = 'saved-clean-tree-matched';
  saveReceipt(receipt);
  await tagAndFinish(ctx, receipt, home);
}

export function driftProblems(status, receipt, mainFlat) {
  const problems = [];
  const state = status.persistence;
  if (state?.mode !== 'git' || !state.hasBaseline || state.pendingCount !== 0 || state.isLoading || state.error) {
    problems.push(`Make reports saved ${state?.savedVersion ?? 'none'} with ${state?.pendingCount ?? 'unknown'} pending`);
  }
  if (receipt.makeAfter?.versionGitSha && state?.savedVersion !== receipt.makeAfter.versionGitSha) {
    problems.push(`Make's saved version is ${state?.savedVersion ?? 'none'}, not ${receipt.makeAfter.versionGitSha}`);
  }
  const unsaved = contentDiff(status.workingFlat, status.makeFlat);
  if (unsaved.length) problems.push(`${unsaved.length} unsaved path(s) ${JSON.stringify(unsaved.slice(0, 20))}`);
  const differ = contentDiff(status.makeFlat, mainFlat, skipOf(receipt.plan));
  if (differ.length) problems.push(`${differ.length} path(s) differ from main ${JSON.stringify(differ.slice(0, 20))}`);
  return problems;
}

export async function deployApply(client, { dir, planPath } = {}, deps = {}) {
  deps = defaults(deps);
  const reviewed = readPlan(planPath);
  if (reviewed.fileKey !== client.fileKey) fail(`The plan is for Make file ${reviewed.fileKey}, not ${client.fileKey}.`, 'DEPLOY_STALE_PLAN');
  const { ctx, plan, access, main } = await prepare(client, { dir, reviewed }, deps);
  if (plan.mainCommit !== reviewed.mainCommit) {
    fail(`main moved from ${short(reviewed.mainCommit)} to ${short(plan.mainCommit)} since the dry run. Run a new dry run. Nothing was deployed.`, 'DEPLOY_MAIN_MOVED');
  }
  if (plan.n !== reviewed.n) fail(`${reviewed.tag} was taken by another deploy since the dry run. Run a new dry run. Nothing was deployed.`, 'DEPLOY_TAG_CLASH');
  if (plan.digest !== reviewed.digest) fail('Make or main changed since the dry run, so the plan is stale. Run a new dry run. Nothing was deployed.', 'DEPLOY_STALE_PLAN');
  if (!plan.files.length) fail(`Make already matches main ${short(plan.mainCommit)}; there is nothing to deploy.`, 'DEPLOY_NOTHING');
  const receipt = newReceipt(plan, access.login, deps.now().toISOString(), deps.home);
  receipt.planPath = resolve(planPath);
  saveReceipt(receipt);
  const mainBytes = blob => deps.readBlob(ctx.root, blob);
  await backupLockfiles(client, receipt, deps.home);
  await writeFiles(client, receipt, plan.files, { mainBytes, home: deps.home, deps });
  await reconcile(client, receipt, { mainBytes, home: deps.home, deps });
  await finish(client, ctx, receipt, main.flat, deps.home);
  return result(receipt, `Deployed main ${short(plan.mainCommit)} to Make as version ${receipt.makeAfter.versionNumber} and tagged it ${receipt.tag.name}. ` +
    `Next: confirm it after a fresh reload with --verify ${receipt.receiptPath}.`);
}

const result = (receipt, summary) => ({ deployId: receipt.deployId, fileKey: receipt.fileKey, repo: receipt.repo, who: receipt.who,
  mainCommit: receipt.mainCommit, tag: receipt.tag, makeBefore: receipt.makeBefore, makeAfter: receipt.makeAfter,
  counts: counts(receipt.files), excludedCount: receipt.excluded.length, outcome: receipt.outcome, stage: receipt.stage, verification: receipt.verification,
  receiptPath: receipt.receiptPath, summary });

// Each planned path in Make's working copy: still as before, already as
// planned, a dependency file Make's own install regenerated, or something
// else (which stops resume and abort).
export function classify(receipt, status) {
  return receipt.plan.files.map(file => {
    const blob = status.workingFlat.get(file.path)?.blob ?? null;
    const state = blob === file.afterBlob ? 'after' : blob === file.beforeBlob ? 'before' : blob && isDependency(file.path) ? 'regenerated' : 'other';
    return { ...file, state };
  });
}

// Receipts that may continue: nothing saved yet, Make still at the version
// the deploy started from, and every other path untouched.
async function resumable(client, receipt, what) {
  if (receipt.fileKey !== client.fileKey) fail(`The receipt is for Make file ${receipt.fileKey}, not ${client.fileKey}.`, 'DEPLOY_RECEIPT');
  if (receipt.outcome !== 'uncertain' || !BEFORE_SAVE.includes(receipt.stage)) {
    fail(`This deploy is at stage ${receipt.stage} (${receipt.outcome}); --${what} applies only before a version was saved.` +
      `${receipt.outcome === 'uncertain' ? ` Run ${recovery(receipt)}.` : ''}`, 'DEPLOY_RECEIPT');
  }
  const ui = await client.inspect();
  if (ui?.busy || ui?.offline || ui?.readOnly === true) fail('Make is busy, offline or read-only. Wait until it is idle.', 'DEPLOY_MAKE_BUSY');
  const status = await client.projectStatus();
  let state;
  try { state = requireGitMode(status.persistence); }
  catch (error) { fail(`Make is not ready: ${error.message}`, 'DEPLOY_MAKE_STATE'); }
  if (state.savedVersion !== receipt.makeBefore.versionGitSha) {
    fail(`Make's saved version is ${state.savedVersion}, not ${receipt.makeBefore.versionGitSha} where the deploy started, so a version was saved. ` +
      `Run figma-cli make deploy --file ${receipt.fileKey} --dir <clone> --verify ${receipt.receiptPath}.`, 'DEPLOY_RECEIPT');
  }
  const checked = plannedState(receipt, status);
  if (checked.problem) fail(`${checked.problem}. ${checked.code === 'DEPLOY_RECEIPT' ? 'Inspect it by hand. ' : ''}Nothing was changed.`, checked.code);
  return { status, files: checked.files };
}

export async function deployResume(client, { dir, receiptPath } = {}, deps = {}) {
  deps = defaults(deps);
  const receipt = readReceipt(receiptPath);
  const ctx = teamContext({ dir: resolve(dir || '.'), run: deps.run, warn: deps.warn });
  requireNoOperation(ctx);
  if (ctx.repo().toLowerCase() !== receipt.repo.toLowerCase()) fail(`This clone belongs to ${ctx.repo()}, not ${receipt.repo}.`, 'DEPLOY_REPO_MISMATCH');
  const access = await requireAdmin(receipt.repo, deps.gh);
  if (!revOf(ctx, receipt.mainCommit)) fetchMain(ctx);
  if (!revOf(ctx, receipt.mainCommit)) fail(`The clone does not have main ${short(receipt.mainCommit)}.`, 'DEPLOY_RECEIPT');
  const { status, files } = await resumable(client, receipt, 'resume');
  const todo = files.filter(file => file.state === 'before' || file.state === 'regenerated' || (file.state === 'after' && isLockfile(file.path)))
    .map(file => ({ ...file, expectedSha256: status.workingSha256.get(file.path) ?? null }));
  receipt.resumedBy = access.login;
  receipt.stage = 'writing';
  const mainBytes = blob => deps.readBlob(ctx.root, blob);
  await backupLockfiles(client, receipt, deps.home);
  await writeFiles(client, receipt, todo, { mainBytes, home: deps.home, deps });
  await reconcile(client, receipt, { mainBytes, home: deps.home, deps });
  await finish(client, ctx, receipt, lsTree(ctx, receipt.mainCommit), deps.home);
  return result(receipt, `Resumed: wrote ${todo.length} remaining file(s), saved version ${receipt.makeAfter.versionNumber} and tagged ${receipt.tag.name}. ` +
    `Next: --verify ${receipt.receiptPath}.`);
}

// The original bytes of a planned path, from this deploy's private backups.
function backupContent(receipt, file, home) {
  const candidates = receipt.completedWrites.filter(write => write.path === file.path && write.backupPath).map(write => write.backupPath);
  const root = backupDir(receipt, home);
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      try {
        const metadata = JSON.parse(readFileSync(join(root, name, 'metadata.json'), 'utf8'));
        if (metadata.path === file.path) candidates.push(join(root, name, 'original.txt'));
      } catch { /* not a backup */ }
    }
  }
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    if (sha256(bytes) === file.beforeSha256) return bytes.toString('utf8');
  }
  fail(`No backup of ${file.path} with its original content was found. Nothing was changed.`, 'DEPLOY_RECEIPT');
}

export async function deployAbort(client, { receiptPath } = {}, deps = {}) {
  deps = defaults(deps);
  const receipt = readReceipt(receiptPath);
  await requireAdmin(receipt.repo, deps.gh);
  const { status: first, files } = await resumable(client, receipt, 'abort');
  const restoreOf = file => (file.op === 'add' ? null : backupContent(receipt, file, deps.home));
  // Every backup is read before anything changes.
  const contents = new Map(files.filter(file => !noOriginal(file) && (file.state === 'after' || file.state === 'regenerated')).map(file => [file.path, restoreOf(file)]));
  const restored = new Set(receipt.restored || []);
  // Older abort retries replaced this list. Recover paths that this deploy
  // wrote and a previous abort already returned to their starting content;
  // a path whose only write was uncertain is listed apart, at saved content.
  const savedUncertain = new Set();
  if (receipt.restored?.length) {
    for (const file of files) {
      const writes = receipt.completedWrites.filter(write => write.path === file.path && !write.backupOnly);
      if (file.state !== 'before' || restored.has(file.path) || !writes.length) continue;
      if (writes.some(write => !write.uncertain)) restored.add(file.path);
      else savedUncertain.add(file.path);
    }
  }
  if (savedUncertain.size) receipt.restoredUncertain = [...savedUncertain];
  const recordRestored = path => {
    restored.add(path);
    receipt.restored = [...restored];
    saveReceipt(receipt);
  };
  const stopAbort = (error, message) => {
    receipt.restored = [...restored];
    stop(receipt, error, 'writing', message, 'DEPLOY_WRITE_FAILED');
  };
  let status = first;
  let todo = files.filter(file => contents.has(file.path));
  const recheck = async () => {
    status = await settledStatus(client, receipt, deps);
    const checked = plannedState(receipt, status);
    if (checked.problem) stopAbort(null, `Abort stopped once Make was idle: ${checked.problem}. Run --abort again.`);
    return checked;
  };
  // Restore dependency files last. Their writes can start Make's install;
  // settle and check the entire plan before the next write or retry.
  for (let round = 1; ; round++) {
    for (const file of [...todo].sort(byWriteOrder)) {
      for (let attempt = 1; ; attempt++) {
        const current = status.workingSha256.get(file.path) ?? null;
        try {
          const content = contents.has(file.path) ? contents.get(file.path) : restoreOf(file);
          if (file.op === 'add') await client.deleteDurable(file.path, { expectedSha256: current, backupDir: backupDir(receipt, deps.home) });
          else await client.writeDurable(file.path, content, { expectedSha256: current ?? undefined, backupDir: backupDir(receipt, deps.home) });
        } catch (error) {
          if (attempt >= ROUNDS || (error.code !== 'MAKE_PENDING_CHANGED' && !isDependency(file.path))) {
            stopAbort(error, `Abort stopped while restoring: ${error.message} Run --abort again.`);
          }
          const checked = await recheck();
          if (checked.files.find(item => item.path === file.path).state === 'before') {
            recordRestored(file.path);
            break;
          }
          continue;
        }
        recordRestored(file.path);
        if (isDependency(file.path)) await recheck();
        break;
      }
    }
    const checked = await recheck();
    todo = checked.files.filter(file => file.state !== 'before' && !noOriginal(file));
    const pending = status.persistence?.pendingPaths || [];
    if (!todo.length && status.workingTree === receipt.makeBefore.tree && !pending.length) break;
    const unrestorable = checked.files.filter(file => noOriginal(file) && status.workingFlat.get(file.path)?.blob !== status.makeFlat.get(file.path)?.blob);
    if (!todo.length && !pending.length && unrestorable.length) {
      const named = unrestorable.map(file => `${file.path} (working sha256 ${status.workingSha256.get(file.path) ?? 'none'}, saved blob ${status.makeFlat.get(file.path)?.blob ?? 'none'})`);
      stopAbort(null, `Restored ${restored.size} file(s), but Make's working tree ${status.workingTree} still differs from saved tree ${receipt.makeBefore.tree} in ` +
        `${named.join(', ')}. The receipt has no backup of it: Make had already changed it before the deploy started. ` +
        'Make manages this lockfile: it is hidden from the file tree and Make\'s install regenerates it from package.json. ' +
        `package.json is back at saved version ${short(receipt.makeBefore.versionGitSha)}, so let Make finish its install, then check make status. ` +
        `If the lockfile still differs, restore saved version ${short(receipt.makeBefore.versionGitSha)} from Make's version history; do not edit the lockfile by hand. ` +
        'Once the lockfile matches the saved version again, run --abort once more to close the receipt.');
    }
    if (!todo.length || round >= ROUNDS) {
      const mismatch = status.workingTree !== receipt.makeBefore.tree
        ? `working tree ${status.workingTree} != saved tree ${receipt.makeBefore.tree}`
        : `pending paths ${JSON.stringify(pending)}`;
      stopAbort(null, `Restored ${restored.size} file(s), but Make still differs from its saved version: ${mismatch}. Run --abort again.`);
    }
  }
  const restoredPaths = [...restored];
  receipt.restored = restoredPaths;
  receipt.stage = 'aborted';
  receipt.outcome = 'aborted';
  receipt.error = null;
  saveReceipt(receipt);
  return { ...result(receipt, `Aborted: restored ${restoredPaths.length} file(s)` +
    `${savedUncertain.size ? `, and ${savedUncertain.size} more whose write outcome is uncertain are at saved content` : ''}; ` +
    `Make is back at its saved version ${short(receipt.makeBefore.versionGitSha)} and nothing was saved.`),
  ...(savedUncertain.size ? { restoredUncertain: [...savedUncertain] } : {}) };
}

// --- verify ------------------------------------------------------------------

// After a fresh-sandbox reload: Make's saved version and tree must be the
// deploy's. An uncertain receipt is finalised; a missing tag is pushed.
export async function deployVerify(client, { dir, receiptPath } = {}, deps = {}) {
  deps = defaults(deps);
  const receipt = readReceipt(receiptPath);
  if (receipt.fileKey !== client.fileKey) fail(`The receipt is for Make file ${receipt.fileKey}, not ${client.fileKey}.`, 'DEPLOY_RECEIPT');
  if (BEFORE_SAVE.includes(receipt.stage) || receipt.outcome === 'aborted') {
    fail(`Nothing was saved by this deploy (stage ${receipt.stage}).${receipt.outcome === 'uncertain' ? ` Run ${recovery(receipt)}.` : ''}`, 'DEPLOY_RECEIPT');
  }
  const ctx = teamContext({ dir: resolve(dir || '.'), run: deps.run, warn: deps.warn });
  if (ctx.repo().toLowerCase() !== receipt.repo.toLowerCase()) fail(`This clone belongs to ${ctx.repo()}, not ${receipt.repo}.`, 'DEPLOY_REPO_MISMATCH');
  if (!revOf(ctx, receipt.mainCommit)) fetchMain(ctx);
  if (!revOf(ctx, receipt.mainCommit)) fail(`The clone does not have main ${short(receipt.mainCommit)}.`, 'DEPLOY_RECEIPT');
  const mainFlat = lsTree(ctx, receipt.mainCommit);
  await client.reloadPage();
  const status = await client.projectStatus();
  const state = status.persistence;
  if (!receipt.makeAfter) {
    if (state?.savedVersion === receipt.makeBefore.versionGitSha) {
      receipt.stage = 'writing';
      receipt.error = 'No deploy version was found after a fresh reload.';
      saveReceipt(receipt);
      fail(`No deploy version was created: Make is still at ${short(receipt.makeBefore.versionGitSha)}. Run ${recovery(receipt)}.`, 'DEPLOY_VERIFY_FAILED',
        { receiptPath: receipt.receiptPath });
    }
    const latest = status.history?.latest?.gitSha === state?.savedVersion ? status.history.latest.versionNumber : null;
    const makeAfter = { versionId: null, versionNumber: latest, versionGitSha: state?.savedVersion ?? null, tree: null };
    const problems = driftProblems(status, { ...receipt, makeAfter }, mainFlat);
    if (problems.length) {
      fail(`Make's saved version ${state?.savedVersion ?? 'none'} is not this deploy's: ${problems.join('; ')}. It may hold edits made in Make, ` +
        `so the receipt stays at stage ${receipt.stage}. Inspect Make's versions by hand. Receipt: ${receipt.receiptPath}.`, 'DEPLOY_VERIFY_FAILED',
        { receiptPath: receipt.receiptPath });
    }
    receipt.makeAfter = makeAfter;
  }
  const problems = driftProblems(status, receipt, mainFlat);
  if (problems.length && receipt.outcome === 'ok') {
    fail(`Make no longer holds this deploy after a fresh reload: ${problems.join('; ')}. A later deploy or a Make edit changed it.`, 'DEPLOY_VERIFY_FAILED');
  }
  if (problems.length && receipt.stage === 'tag-pending') {
    await requireAdmin(receipt.repo, deps.gh);
    await tagAndFinish(ctx, receipt, deps.home);
    return result(receipt, `Pushed ${receipt.tag.name}: Make version ${receipt.makeAfter.versionNumber ?? short(receipt.makeAfter.versionGitSha)} matched main ` +
      `${short(receipt.mainCommit)} when it was saved, but Make has changed since: ${problems.join('; ')}.`);
  }
  if (problems.length) {
    const saved = state?.savedVersion === receipt.makeAfter.versionGitSha;
    if (saved) receipt.makeAfter.tree = status.makeTree;
    stop(receipt, null, 'saved-drift', `Verification after a fresh reload failed: ${problems.join('; ')}.` +
      (saved ? ' The next dry run plans from this version.'
        : ` Make has moved past version ${receipt.makeAfter.versionNumber ?? short(receipt.makeAfter.versionGitSha)}; the next dry run checks Make against the last deploy tag.`),
      'DEPLOY_VERIFY_FAILED');
  }
  receipt.makeAfter.tree = status.makeTree;
  receipt.verification = 'saved-clean-tree-matched, fresh-sandbox-verified';
  saveReceipt(receipt);
  if (!receipt.tag.pushed) {
    await requireAdmin(receipt.repo, deps.gh);
    await tagAndFinish(ctx, receipt, deps.home);
  }
  return result(receipt, `Verified after a fresh reload: Make version ${receipt.makeAfter.versionNumber ?? short(receipt.makeAfter.versionGitSha)} holds main ` +
    `${short(receipt.mainCommit)}, tagged ${receipt.tag.name}.`);
}
