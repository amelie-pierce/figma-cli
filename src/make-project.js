import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gitTreeSha, isIgnored, parseIgnore } from './git-tree.js';

// Project-level Make state: the team-mode marker, solo/team mode, the write
// gate and the read-only `make status` comparison with a GitHub repo.

export const PROJECT_MARKER = '.figma-cli/project.json';
// Always excluded from the project inventory, besides `.git` itself and the
// sandbox's .git/info/exclude: Make's registry config (secret-bearing, never
// read) and Figma's design context. Tracked paths never override these.
export const PROJECT_EXCLUDES = Object.freeze(['/.npmrc', '/.figma/design-context/']);
// Repo-only paths: project vault notes live in the GitHub repo and never in
// Make (which cannot create a new top-level folder anyway). make deploy and
// make status leave them out of the comparison, like PROJECT_EXCLUDES.
// Paths are repo-relative tree paths, so a top-level folder prefix is exact.
export const REPO_ONLY = Object.freeze(['_vaults']);
export const isRepoOnly = path => REPO_ONLY.some(top => path === top || String(path).startsWith(`${top}/`));
export const MAKE_BOT = 'figma[bot]';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;

export function repoName(value) {
  if (typeof value !== 'string' || !REPO.test(value) || value.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Use an exact GitHub repository as owner/repo.');
  }
  return value;
}

// The committed marker. Absent → no marker; present but unreadable or naming
// another file → invalid, which fails closed for writes.
export function parseMarker(bytes, fileKey) {
  if (bytes == null) return { state: 'absent' };
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return { state: 'invalid', reason: `${PROJECT_MARKER} is not valid UTF-8 JSON` }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'invalid', reason: `${PROJECT_MARKER} is not a JSON object` };
  if (value.schema != null && value.schema !== 'figma-cli/project@1') return { state: 'invalid', reason: `${PROJECT_MARKER} has an unsupported schema` };
  let repo;
  try { repo = repoName(value.repo); } catch { return { state: 'invalid', reason: `${PROJECT_MARKER} has no valid repo` }; }
  const trunk = value.trunk ?? 'main';
  if (typeof trunk !== 'string' || !BRANCH.test(trunk) || trunk.split('/').some(part => !part || part === '..')) {
    return { state: 'invalid', reason: `${PROJECT_MARKER} has an invalid trunk` };
  }
  if (typeof value.fileKey !== 'string' || !value.fileKey) return { state: 'invalid', reason: `${PROJECT_MARKER} has no fileKey` };
  if (value.fileKey !== fileKey) {
    return { state: 'mismatch', repo, trunk, fileKey: value.fileKey, reason: `${PROJECT_MARKER} names file ${value.fileKey}, not the open file ${fileKey}` };
  }
  return { state: 'valid', repo, trunk, fileKey };
}

// Make exposes no readable GitHub link, so `make status --repo` records the
// file → repo link locally, under ~/.figma-cli, for the write gate to read.
export const linkStorePath = (home = homedir()) => join(home, '.figma-cli', 'make-repos.json');

function readLinks(home) {
  const path = linkStorePath(home);
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value && typeof value.files === 'object' && !Array.isArray(value.files)) return value.files;
  } catch { /* reported below */ }
  throw new Error(`${path} is unreadable; fix or delete it.`);
}

export function linkedRepo(fileKey, { home } = {}) {
  const repo = readLinks(home)[fileKey]?.repo;
  return repo == null ? null : repoName(repo);
}

export function recordLinkedRepo(fileKey, repo, { home } = {}) {
  repoName(repo);
  const path = linkStorePath(home);
  const files = { ...readLinks(home), [fileKey]: { repo, recordedAt: new Date().toISOString() } };
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ schema: 'figma-cli/make-repos@1', files }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

// Turning team mode off drops the local link too, so later writes are solo
// rather than ambiguous.
export function forgetLinkedRepo(fileKey, { home } = {}) {
  const files = readLinks(home);
  if (!files[fileKey]) return false;
  delete files[fileKey];
  const path = linkStorePath(home);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ schema: 'figma-cli/make-repos@1', files }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return true;
}

// team: a valid marker for this file. ambiguous: no marker, but a repo is
// known, from --repo or a link recorded by `make status --repo`.
// invalid: a marker that cannot be trusted. solo: neither.
export function detectMode(marker, { repo, linked } = {}) {
  if (marker.state === 'valid') {
    return { mode: 'team', repo: marker.repo, trunk: marker.trunk, source: 'marker',
      ...(repo && repo !== marker.repo ? { repoConflict: `--repo ${repo} differs from the marker's ${marker.repo}` } : {}) };
  }
  if (marker.state === 'invalid' || marker.state === 'mismatch') return { mode: 'invalid', source: 'marker', reason: marker.reason };
  if (repo || linked) return { mode: 'ambiguous', repo: repo || linked, trunk: 'main', source: repo ? '--repo' : 'linked',
    reason: `${repo || linked} exists but Make holds no ${PROJECT_MARKER}` };
  return { mode: 'solo', source: 'no-marker' };
}

export const MODE_CODES = Object.freeze(['MAKE_TEAM_MODE', 'MAKE_MARKER_INVALID', 'MAKE_MODE_AMBIGUOUS', 'MAKE_MARKER_RESERVED',
  'MAKE_MODE_UNCHANGED', 'MAKE_MODE_MISMATCH', 'MAKE_MODE_OTHER_PENDING', 'MAKE_MODE_NOT_ADMIN', 'MAKE_MODE_CONFIRM_REQUIRED']);

// Only `make mode team|solo` adds or removes the marker. Every other write
// command refuses it in every mode, so the mode never changes as a side effect.
export function refuseMarkerPaths(paths) {
  const reserved = PROJECT_MARKER.toLowerCase();
  if (paths.some(path => typeof path === 'string' && path.replace(/^(\.\/)+/, '').toLowerCase() === reserved)) {
    const error = new Error(`${PROJECT_MARKER} is changed only by make mode team or make mode solo.`);
    error.code = 'MAKE_MARKER_RESERVED';
    throw error;
  }
}

export const SOLO_NOTE = `team mode is detected only through ${PROJECT_MARKER} or a prior make status --repo`;

// The write gate as the commands run it: read the marker from Make's client
// VFS and the recorded repo link, then refuse team, invalid and (without
// --solo) ambiguous mode.
export async function checkWriteMode(client, { repo, solo, home } = {}) {
  const linked = repo ? null : linkedRepo(client.fileKey, { home });
  const mode = detectMode(parseMarker(await client.projectMarker(), client.fileKey), { repo, linked });
  return { mode, ...requireWritableMode(mode, { solo }), ...(mode.mode === 'solo' ? { note: SOLO_NOTE } : {}) };
}

// Gate for every Make write command, session-only ones included.
export function requireWritableMode(mode, { solo = false } = {}) {
  const fail = (message, code) => { const error = new Error(message); error.code = code; throw error; };
  if (mode.mode === 'team') {
    fail(`This file deploys from ${mode.repo}; say "start a task". In team mode Make is written only by deploy from ${mode.trunk}.`, 'MAKE_TEAM_MODE');
  }
  if (mode.mode === 'invalid') fail(`Make write refused: ${mode.reason}.`, 'MAKE_MARKER_INVALID');
  if (mode.mode === 'ambiguous' && !solo) {
    fail(`Make write refused: ${mode.reason}, so the mode is ambiguous. Pass --solo to write to Make directly anyway.`, 'MAKE_MODE_AMBIGUOUS');
  }
  return mode.mode === 'ambiguous' ? { warning: `Writing in ambiguous mode because --solo was passed (${mode.reason}).` } : {};
}

// Paths that root .gitattributes routes through Git LFS. Make's git stores the
// pointer while Push sends the raw bytes, so these paths sit outside the tree join.
export function lfsMatcher(gitattributes) {
  if (!gitattributes) return () => false;
  const patterns = String(gitattributes).split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && /(^|\s)filter=lfs(\s|$)/.test(line))
    .map(line => line.split(/\s+/)[0]);
  const rules = parseIgnore(patterns.join('\n'));
  return path => isIgnored(rules, path, false);
}

// Tree SHA of a flat path → { mode, blob } map, optionally without some paths.
export function treeOf(flat, without = new Set()) {
  return gitTreeSha([...flat].filter(([path]) => !without.has(path)).map(([path, { mode, blob }]) => ({ path, mode, blob })));
}

// Working-copy modes: listing does not expose them. A file whose blob equals
// the base tree keeps the base mode; Make commits written or edited files as
// 100644 (scratch test T6), so every other file takes 100644.
export function workingFlat(inventory, baseFlat) {
  const flat = new Map();
  for (const [path, { blob }] of inventory) {
    const base = baseFlat?.get(path);
    flat.set(path, { mode: base && base.blob === blob ? base.mode : '100644', blob });
  }
  return flat;
}

export function differingPaths(a, b, without = new Set()) {
  const paths = new Set([...a.keys(), ...b.keys()]);
  return [...paths].filter(path => !without.has(path) &&
    (a.get(path)?.blob !== b.get(path)?.blob || a.get(path)?.mode !== b.get(path)?.mode)).sort();
}

export function relationOf({ make, main, base }) {
  if (!make || !main) return 'unknown';
  if (make === main) return 'in-sync';
  if (!base) return 'no-base';
  if (make === base) return 'git-ahead';
  if (main === base) return 'make-ahead';
  return 'diverged';
}

export function ghRunner({ timeoutMs = 30000 } = {}) {
  return args => new Promise((resolve, reject) => {
    execFile('gh', ['api', ...args], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).split('\n').find(Boolean) || 'gh failed';
        return reject(new Error(`gh api ${args[0]} failed: ${detail}`));
      }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`gh api ${args[0]} returned invalid JSON`)); }
    });
  });
}

const flatFromGithub = tree => {
  if (tree?.truncated) throw new Error('GitHub truncated the recursive tree listing.');
  return new Map((tree?.tree || []).filter(entry => entry.type === 'blob' || entry.type === 'commit')
    .map(entry => [entry.path, { mode: entry.mode, blob: entry.sha }]));
};

function receiptOf(message) {
  const start = typeof message === 'string' ? message.indexOf('{') : -1;
  if (start < 0) return null;
  try {
    const value = JSON.parse(message.slice(start));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

// Read-only GitHub state through the caller's own gh login. Every call is a GET.
export async function readGithub(repo, { gh = ghRunner(), trunk = 'main', maxCommits = 100 } = {}) {
  repoName(repo);
  const info = await gh([`repos/${repo}`]);
  let login = null;
  try { login = (await gh(['user'])).login || null; } catch { /* identity is informational */ }
  const permissions = info?.permissions || {};
  const permission = permissions.admin ? 'admin' : permissions.maintain ? 'maintain' : permissions.push ? 'write'
    : permissions.triage ? 'triage' : permissions.pull ? 'read' : 'none';
  const head = await gh([`repos/${repo}/commits/${encodeURIComponent(trunk)}`]);
  if (!SHA.test(head?.sha || '') || !SHA.test(head?.commit?.tree?.sha || '')) throw new Error(`GitHub ${trunk} has no readable commit.`);
  const mainFlat = flatFromGithub(await gh([`repos/${repo}/git/trees/${head.commit.tree.sha}?recursive=1`]));

  const refs = await gh([`repos/${repo}/git/matching-refs/tags/make-deploy/`]);
  const tags = (Array.isArray(refs) ? refs : []).map(ref => ({ ref, n: /^refs\/tags\/make-deploy\/(\d+)$/.exec(ref.ref || '')?.[1] }))
    .filter(tag => tag.n != null).sort((a, b) => Number(b.n) - Number(a.n));
  let base = null;
  if (tags.length) {
    const { ref, n } = tags[0];
    let commit = ref.object?.sha;
    let receipt = null;
    if (ref.object?.type === 'tag') {
      const tag = await gh([`repos/${repo}/git/tags/${commit}`]);
      commit = tag?.object?.type === 'commit' ? tag.object.sha : null;
      receipt = receiptOf(tag?.message);
    }
    if (!SHA.test(commit || '')) throw new Error(`make-deploy/${n} does not point at a commit.`);
    const commitTree = (await gh([`repos/${repo}/git/commits/${commit}`]))?.tree?.sha;
    const receiptTree = SHA.test(receipt?.mainTree || '') ? receipt.mainTree : null;
    const tree = commitTree;
    base = { tag: `make-deploy/${n}`, commit, tree, receipt: receipt ? 'parsed' : 'none',
      ...(receiptTree && receiptTree !== commitTree ? { receiptMismatch: `receipt mainTree ${receiptTree} differs from the tagged commit's tree ${commitTree}` } : {}) };
    base.flat = flatFromGithub(await gh([`repos/${repo}/git/trees/${tree}?recursive=1`]));
  }

  let commits;
  let truncated = false;
  let rewritten = false;
  if (base) {
    const compare = await gh([`repos/${repo}/compare/${base.commit}...${head.sha}`]);
    rewritten = ['behind', 'diverged'].includes(compare?.status);
    commits = compare?.commits || [];
    truncated = (compare?.ahead_by ?? commits.length) > commits.length;
  } else {
    commits = await gh([`repos/${repo}/commits?sha=${head.sha}&per_page=${maxCommits}`]);
    truncated = commits.length >= maxCommits;
  }
  if (commits.length > maxCommits) { commits = commits.slice(-maxCommits); truncated = true; }
  const checked = [];
  for (const commit of commits) {
    const pulls = await gh([`repos/${repo}/commits/${commit.sha}/pulls`]);
    const pr = (Array.isArray(pulls) ? pulls : []).find(pull => pull.merged_at && pull.base?.ref === trunk);
    checked.push({ sha: commit.sha, author: commit.author?.login || null, fromMake: commit.author?.login === MAKE_BOT,
      reviewed: !!pr, ...(pr ? { pr: pr.html_url } : {}) });
  }
  return { repo, trunk, defaultBranch: info?.default_branch || null, login, permission, mayDeploy: permission === 'admin',
    main: { commit: head.sha, tree: head.commit.tree.sha, flat: mainFlat }, base, commits: checked, truncated, rewritten };
}

const publicBase = base => base && Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'flat'));

// Combine Make and GitHub state into the status report. Pure: no I/O.
export function buildStatus({ fileKey, make, marker, repo, linked, github, githubError }) {
  const mode = detectMode(marker, { repo, linked });
  const makeLfs = new Set(make.lfsPaths);
  const workingDiffers = treeOf(make.workingFlat, makeLfs) !== treeOf(make.makeFlat, makeLfs);
  const attention = [];
  const state = make.persistence;
  if (!state) attention.push('Make saving mode or pending state is unavailable');
  else {
    if (state.mode !== 'git') attention.push('Make is in snapshot mode; tree comparison needs git mode');
    if (!state.hasBaseline) attention.push('Make has no saved version (baseline); make save-version --first-version can create one');
    if (state.pendingCount) attention.push(`Make has ${state.pendingCount} pending change(s)`);
    if (state.isLoading || state.error) attention.push('Make pending-state check is incomplete');
  }
  if (make.history?.generationInProgress) attention.push('A Make AI generation is running');
  if (make.history?.ambiguous) attention.push('Make version history is ambiguous');
  const aiBaseline = !!state?.savedVersion && make.history?.latest?.gitSha === state.savedVersion;
  if (mode.mode === 'team' && aiBaseline) attention.push('Make\'s saved version came from an AI turn, which team mode does not allow');
  if (workingDiffers) attention.push('The Make working copy differs from its saved tree');
  if (mode.mode === 'ambiguous') attention.push(`Mode is ambiguous: ${mode.reason}`);
  if (mode.mode === 'invalid') attention.push(`Marker is unusable: ${mode.reason}`);
  if (mode.repoConflict) attention.push(mode.repoConflict);
  if (make.lfsPaths.length) attention.push(`${make.lfsPaths.length} LFS path(s) are compared outside the tree join`);

  const result = {
    fileKey,
    make: {
      mode: state?.mode ?? null, hasBaseline: state?.hasBaseline ?? null, savedVersion: state?.savedVersion ?? null,
      pendingCount: state?.pendingCount ?? null, pendingPaths: state?.pendingPaths ?? null,
      head: make.head, tree: make.makeTree, treeSource: make.treeSource, workingTree: make.workingTree,
      files: make.fileCount, excluded: make.excluded, excludeSource: make.excludeSource, lfsPaths: make.lfsPaths,
      latestAiVersion: make.history?.latest ?? null, aiTurns: make.history?.aiTurns ?? null, baselineFromAiTurn: aiBaseline,
    },
    mode,
  };

  if (githubError) {
    result.github = { repo, error: githubError };
    attention.push(`GitHub state is unavailable: ${githubError}`);
  } else if (github) {
    const lfs = new Set(makeLfs);
    for (const flat of [github.main.flat, github.base?.flat].filter(Boolean)) {
      for (const path of flat.keys()) if (make.isLfs(path)) lfs.add(path);
    }
    // Compare trees without LFS paths when there are any; otherwise these are the raw tree SHAs.
    // Like make deploy, a team marker that main does not hold stays out of the relation.
    const joined = new Set(lfs);
    const markerOutsideMain = !github.main.flat.has(PROJECT_MARKER) && !!make.makeFlat?.has(PROJECT_MARKER);
    if (markerOutsideMain) joined.add(PROJECT_MARKER);
    for (const flat of [github.main.flat, github.base?.flat, make.makeFlat].filter(Boolean)) {
      for (const path of flat.keys()) if (isRepoOnly(path)) joined.add(path);
    }
    const compared = flat => flat && treeOf(flat, joined);
    const makeCompared = compared(make.makeFlat);
    const mainCompared = compared(github.main.flat);
    const baseCompared = compared(github.base?.flat);
    const relation = relationOf({ make: makeCompared, main: mainCompared, base: baseCompared });
    const differing = make.makeFlat ? differingPaths(make.makeFlat, github.main.flat, joined) : null;
    const unreviewed = github.commits.filter(commit => !commit.reviewed);
    const nonMake = github.commits.filter(commit => !commit.fromMake);
    // Push sends the working copy, unsaved edits included, to the default branch.
    const workingMatchesMain = treeOf(make.workingFlat, lfs) === treeOf(github.main.flat, lfs);
    let mirror;
    if (workingMatchesMain) mirror = { state: 'safe', reason: 'Push would change nothing: the Make working copy equals main' };
    else if (github.truncated) mirror = { state: 'unknown', reason: 'too many commits on main to check' };
    else if (nonMake.length) mirror = { state: 'unsafe', reason: `Push would overwrite ${nonMake.length} commit(s) on main not made by Make${github.base ? ` since ${github.base.tag}` : ''}` };
    else mirror = { state: 'safe', reason: 'Push would replace only Make\'s own mirror commits' };
    if (mirror.state === 'safe' && workingDiffers) mirror.reason += '; unsaved Make changes would be pushed';

    // Push targets the default branch; the mirror check assumes that is the trunk.
    if (github.defaultBranch && github.defaultBranch !== github.trunk) {
      attention.push(`The default branch is ${github.defaultBranch}, not ${github.trunk}, so the mirror check does not cover where Push lands`);
    }
    if (relation !== 'in-sync') attention.push(`Make is ${relation} relative to ${github.trunk}`);
    if (github.base?.receiptMismatch) attention.push(github.base.receiptMismatch);
    if (github.rewritten) attention.push(`${github.trunk} no longer descends from ${github.base.tag}`);
    if (github.truncated) attention.push(`More than the checked commits are on ${github.trunk}; review state is incomplete`);
    if (unreviewed.length) attention.push(`${unreviewed.length} commit(s) on ${github.trunk} did not come from a merged PR`);
    if (mirror.state !== 'safe') attention.push(`Mirror ${mirror.state}: ${mirror.reason}`);

    result.github = {
      repo: github.repo, trunk: github.trunk, defaultBranch: github.defaultBranch, login: github.login,
      permission: github.permission, mayDeploy: github.mayDeploy,
      main: { commit: github.main.commit, tree: github.main.tree },
      base: publicBase(github.base), relation, differingPaths: differing,
      ...(lfs.size ? { comparedWithoutLfs: { make: makeCompared, main: mainCompared, base: baseCompared } } : {}),
      ...(markerOutsideMain ? { markerOutsideMain: true } : {}),
      commitsChecked: github.commits.length, truncated: github.truncated,
      unreviewed: unreviewed.map(({ sha, author, fromMake }) => ({ sha, author, fromMake })),
      mirror,
    };
  }
  result.attention = attention;
  result.ok = attention.length === 0;
  return result;
}

// 0: everything read and nothing needs attention. 1: the status could not be
// read (CLI error). 2: read completely, with attention items.
export const statusExitCode = result => result.github?.error ? 1 : result.ok ? 0 : 2;
