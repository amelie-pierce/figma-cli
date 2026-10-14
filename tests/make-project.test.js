import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBlobSha } from '../src/git-tree.js';
import { buildStatus, checkWriteMode, detectMode, differingPaths, lfsMatcher, linkedRepo, linkStorePath, parseMarker, readGithub,
  recordLinkedRepo, relationOf, requireWritableMode, statusExitCode, treeOf, workingFlat } from '../src/make-project.js';

const KEY = 'ExactKey';
const REPO = 'owner/proto';
const marker = value => Buffer.from(JSON.stringify(value));
const blob = text => gitBlobSha(Buffer.from(text));
const sha = c => c.repeat(40);
const flat = files => new Map(Object.entries(files).map(([path, text]) => [path, { mode: '100644', blob: blob(text) }]));

describe('team marker and mode detection', () => {
  it('detects solo, team, ambiguous and invalid modes', () => {
    assert.equal(detectMode(parseMarker(null, KEY)).mode, 'solo');
    assert.equal(detectMode(parseMarker(null, KEY), { repo: REPO }).mode, 'ambiguous');
    const team = detectMode(parseMarker(marker({ fileKey: KEY, repo: REPO }), KEY));
    assert.deepEqual(team, { mode: 'team', repo: REPO, trunk: 'main', source: 'marker' });
    assert.match(detectMode(parseMarker(marker({ fileKey: KEY, repo: REPO }), KEY), { repo: 'other/repo' }).repoConflict, /differs/);
    assert.equal(detectMode(parseMarker(marker({ fileKey: KEY, repo: REPO, trunk: 'develop' }), KEY)).trunk, 'develop');
    for (const bytes of [Buffer.from('{'), Buffer.from([0xff]), marker([]), marker({ fileKey: KEY }),
      marker({ fileKey: KEY, repo: 'no-slash' }), marker({ repo: REPO }), marker({ fileKey: KEY, repo: REPO, schema: 'x@9' }),
      marker({ fileKey: KEY, repo: REPO, trunk: '../x' })]) {
      assert.equal(detectMode(parseMarker(bytes, KEY)).mode, 'invalid', bytes.toString());
    }
    const other = detectMode(parseMarker(marker({ fileKey: 'Other', repo: REPO }), KEY));
    assert.equal(other.mode, 'invalid');
    assert.match(other.reason, /names file Other, not the open file ExactKey/);
  });

  it('refuses writes in team, invalid and ambiguous mode unless --solo, and allows solo', () => {
    assert.deepEqual(requireWritableMode({ mode: 'solo' }), {});
    assert.throws(() => requireWritableMode({ mode: 'team', repo: REPO, trunk: 'main' }, { solo: true }),
      error => error.code === 'MAKE_TEAM_MODE' && /this file deploys from owner\/proto; say "start a task"/i.test(error.message));
    assert.throws(() => requireWritableMode({ mode: 'invalid', reason: 'bad' }, { solo: true }), { code: 'MAKE_MARKER_INVALID' });
    assert.throws(() => requireWritableMode({ mode: 'ambiguous', reason: 'r' }), error => error.code === 'MAKE_MODE_AMBIGUOUS' && /--solo/.test(error.message));
    assert.match(requireWritableMode({ mode: 'ambiguous', reason: 'r' }, { solo: true }).warning, /ambiguous/);
  });

  it('the command gate reads the marker from the client before any write', async () => {
    const client = bytes => ({ fileKey: KEY, projectMarker: async () => bytes });
    assert.equal((await checkWriteMode(client(null))).mode.mode, 'solo');
    await assert.rejects(checkWriteMode(client(marker({ fileKey: KEY, repo: REPO }))), { code: 'MAKE_TEAM_MODE' });
    await assert.rejects(checkWriteMode(client(null), { repo: REPO }), { code: 'MAKE_MODE_AMBIGUOUS' });
    assert.ok((await checkWriteMode(client(null), { repo: REPO, solo: true })).warning);
    await assert.rejects(checkWriteMode(client(marker({ fileKey: 'Other', repo: REPO }))), { code: 'MAKE_MARKER_INVALID' });
  });

  it('a repo link recorded by make status --repo makes a marker-less write ambiguous', async t => {
    const home = mkdtempSync(join(tmpdir(), 'figma-cli-make-link-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const client = bytes => ({ fileKey: KEY, projectMarker: async () => bytes });
    const solo = await checkWriteMode(client(null), { home });
    assert.equal(solo.mode.mode, 'solo');
    assert.match(solo.note, /only through \.figma-cli\/project\.json or a prior make status --repo/);
    recordLinkedRepo(KEY, REPO, { home });
    assert.equal(linkedRepo(KEY, { home }), REPO);
    assert.equal(linkedRepo('OtherKey', { home }), null);
    await assert.rejects(checkWriteMode(client(null), { home }), { code: 'MAKE_MODE_AMBIGUOUS' });
    const forced = await checkWriteMode(client(null), { home, solo: true });
    assert.equal(forced.mode.source, 'linked');
    assert.match(forced.warning, /owner\/proto exists but Make holds no/);
    assert.equal(forced.note, undefined);
    await assert.rejects(checkWriteMode(client(marker({ fileKey: KEY, repo: REPO })), { home, solo: true }), { code: 'MAKE_TEAM_MODE' });
    assert.equal((await checkWriteMode(client(null), { home: join(home, 'empty') })).mode.mode, 'solo');
    mkdirSync(join(home, 'bad', '.figma-cli'), { recursive: true });
    writeFileSync(linkStorePath(join(home, 'bad')), '{');
    await assert.rejects(checkWriteMode(client(null), { home: join(home, 'bad') }), /make-repos\.json is unreadable/);
  });
});

describe('trees, modes and LFS', () => {
  it('keeps base modes only for unchanged blobs', () => {
    const base = new Map([['run.sh', { mode: '100755', blob: blob('a') }], ['edit.ts', { mode: '100755', blob: blob('b') }]]);
    const inventory = new Map([['run.sh', { blob: blob('a') }], ['edit.ts', { blob: blob('changed') }], ['new.ts', { blob: blob('n') }]]);
    assert.deepEqual([...workingFlat(inventory, base)], [
      ['run.sh', { mode: '100755', blob: blob('a') }], ['edit.ts', { mode: '100644', blob: blob('changed') }],
      ['new.ts', { mode: '100644', blob: blob('n') }]]);
    assert.notEqual(treeOf(base), treeOf(new Map([...base].map(([p, e]) => [p, { ...e, mode: '100644' }]))), 'modes change the tree SHA');
  });

  it('matches LFS patterns from .gitattributes', () => {
    const isLfs = lfsMatcher('# assets\n*.png filter=lfs diff=lfs merge=lfs -text\n/media/** filter=lfs\n*.txt text\n');
    assert.equal(isLfs('public/a.png'), true);
    assert.equal(isLfs('media/x/y.mov'), true);
    assert.equal(isLfs('notes.txt'), false);
    assert.equal(lfsMatcher(undefined)('a.png'), false);
  });

  it('classifies every relation', () => {
    assert.equal(relationOf({ make: 'a', main: 'a', base: null }), 'in-sync');
    assert.equal(relationOf({ make: 'a', main: 'b', base: null }), 'no-base');
    assert.equal(relationOf({ make: 'a', main: 'b', base: 'a' }), 'git-ahead');
    assert.equal(relationOf({ make: 'b', main: 'a', base: 'a' }), 'make-ahead');
    assert.equal(relationOf({ make: 'b', main: 'c', base: 'a' }), 'diverged');
    assert.equal(relationOf({ make: null, main: 'a' }), 'unknown');
    assert.deepEqual(differingPaths(flat({ a: '1', b: '2' }), flat({ a: '1', c: '3' })), ['b', 'c']);
  });
});

// A fake gh: every path is a GET of a recorded response.
function fakeGh(routes) {
  const calls = [];
  const gh = async ([path]) => {
    calls.push(path);
    if (!(path in routes)) throw new Error(`unexpected gh api ${path}`);
    const value = routes[path];
    if (value instanceof Error) throw value;
    return structuredClone(value);
  };
  return { gh, calls };
}
const ghTree = files => ({ truncated: false, tree: [...files].map(([path, { mode, blob: s }]) => ({ path, mode, type: 'blob', sha: s })) });

function repoRoutes({ main, base, commits, pulls = {}, permissions = { admin: true, push: true, pull: true }, tag = 'annotated', receiptTree, compareStatus = 'ahead' }) {
  const mainTree = treeOf(main);
  const routes = {
    [`repos/${REPO}`]: { default_branch: 'main', permissions },
    user: { login: 'designer' },
    [`repos/${REPO}/commits/main`]: { sha: sha('m'.replace('m', 'a')), commit: { tree: { sha: mainTree } } },
    [`repos/${REPO}/git/trees/${mainTree}?recursive=1`]: ghTree(main),
    [`repos/${REPO}/git/matching-refs/tags/make-deploy/`]: [],
  };
  if (base) {
    const baseTree = treeOf(base);
    routes[`repos/${REPO}/git/matching-refs/tags/make-deploy/`] = [
      { ref: 'refs/tags/make-deploy/1', object: { type: 'commit', sha: sha('0') } },
      tag === 'annotated' ? { ref: 'refs/tags/make-deploy/2', object: { type: 'tag', sha: sha('9') } }
        : { ref: 'refs/tags/make-deploy/2', object: { type: 'commit', sha: sha('b') } },
    ];
    routes[`repos/${REPO}/git/tags/${sha('9')}`] = { object: { type: 'commit', sha: sha('b') },
      message: `deploy 2\n\n${JSON.stringify({ schema: 'figma-cli/make-deploy-receipt@1', mainTree: receiptTree ?? baseTree })}\n` };
    routes[`repos/${REPO}/git/commits/${sha('b')}`] = { tree: { sha: baseTree } };
    routes[`repos/${REPO}/git/trees/${receiptTree ?? baseTree}?recursive=1`] = ghTree(base);
    routes[`repos/${REPO}/compare/${sha('b')}...${sha('a')}`] = { status: compareStatus, ahead_by: commits.length, commits };
  } else routes[`repos/${REPO}/commits?sha=${sha('a')}&per_page=100`] = commits;
  for (const commit of commits) routes[`repos/${REPO}/commits/${commit.sha}/pulls`] = pulls[commit.sha] || [];
  return routes;
}

function makeSide({ saved, working = saved, state = {}, history = null, lfs = [] }) {
  const persistence = { mode: 'git', hasBaseline: true, savedVersion: sha('c'), pendingCount: 0, pendingPaths: [],
    isLoading: false, error: false, ...state };
  return { persistence, history, head: sha('c'), makeTree: treeOf(saved), treeSource: 'saved-version', makeFlat: saved,
    workingFlat: working, workingTree: treeOf(working), fileCount: working.size, excluded: ['.npmrc'],
    excludeSource: '.git/info/exclude', lfsPaths: lfs, isLfs: path => lfs.includes(path) };
}

async function status({ make, routes, markerBytes = marker({ fileKey: KEY, repo: REPO }), repo = REPO }) {
  const { gh, calls } = fakeGh(routes);
  const parsed = parseMarker(markerBytes, KEY);
  let github, githubError;
  try { github = await readGithub(repo, { gh }); } catch (error) { githubError = error.message; }
  return { result: buildStatus({ fileKey: KEY, make, marker: parsed, repo, github, githubError }), calls };
}

const merged = number => [{ merged_at: '2026-10-14T00:00:00Z', base: { ref: 'main' }, html_url: `https://github.com/${REPO}/pull/${number}` }];

describe('make status', () => {
  const A = flat({ 'src/App.tsx': 'a', '.figma-cli/project.json': 'm' });
  const B = flat({ 'src/App.tsx': 'b', '.figma-cli/project.json': 'm' });
  const C = flat({ 'src/App.tsx': 'c', '.figma-cli/project.json': 'm' });
  const reviewed = [{ sha: sha('d'), author: { login: 'dev' } }];

  it('in-sync with reviewed commits and an admin caller exits 0, using only GET paths', async () => {
    const { result, calls } = await status({ make: makeSide({ saved: A }),
      routes: repoRoutes({ main: A, base: A, commits: reviewed, pulls: { [sha('d')]: merged(4) } }) });
    assert.equal(result.github.relation, 'in-sync');
    assert.equal(result.github.base.tag, 'make-deploy/2', 'the highest tag number wins');
    assert.equal(result.github.base.receipt, 'parsed');
    assert.equal(result.github.base.flat, undefined, 'internal trees are not reported');
    assert.equal(result.github.permission, 'admin');
    assert.equal(result.github.mayDeploy, true);
    assert.equal(result.github.mirror.state, 'safe');
    assert.deepEqual(result.attention, []);
    assert.equal(statusExitCode(result), 0);
    assert.equal(result.mode.mode, 'team');
    assert.ok(calls.every(path => !path.includes(' ')));
  });

  it('reports make-ahead, git-ahead and diverged against the receipt base', async () => {
    const cases = [[B, A, A, 'make-ahead'], [A, B, A, 'git-ahead'], [B, C, A, 'diverged']];
    for (const [saved, main, base, relation] of cases) {
      const { result } = await status({ make: makeSide({ saved }), routes: repoRoutes({ main, base, commits: [] }) });
      assert.equal(result.github.relation, relation);
      assert.deepEqual(result.github.differingPaths, ['src/App.tsx']);
      assert.equal(statusExitCode(result), 2);
      assert.ok(result.attention.includes(`Make is ${relation} relative to main`));
    }
  });

  it('flags unreviewed commits on main and tells Make mirror commits apart', async () => {
    const commits = [{ sha: sha('d'), author: { login: 'figma[bot]' } }, { sha: sha('e'), author: { login: 'admin' } },
      { sha: sha('f'), author: { login: 'dev' } }];
    const { result } = await status({ make: makeSide({ saved: A }),
      routes: repoRoutes({ main: B, base: A, commits, pulls: { [sha('f')]: merged(7),
        [sha('e')]: [{ merged_at: null, base: { ref: 'main' } }, { merged_at: 'x', base: { ref: 'release' } }] } }) });
    assert.deepEqual(result.github.unreviewed, [{ sha: sha('d'), author: 'figma[bot]', fromMake: true },
      { sha: sha('e'), author: 'admin', fromMake: false }]);
    assert.ok(result.attention.includes('2 commit(s) on main did not come from a merged PR'));
  });

  it('judges mirror safety on the working copy, including unsaved edits', async () => {
    const make = (saved, working) => makeSide({ saved, working, state: { pendingCount: working === saved ? 0 : 1 } });
    const nonMake = [{ sha: sha('e'), author: { login: 'dev' } }];
    const bot = [{ sha: sha('d'), author: { login: 'figma[bot]' } }];
    let { result } = await status({ make: make(A, B), routes: repoRoutes({ main: B, base: A, commits: nonMake }) });
    assert.equal(result.github.mirror.state, 'safe');
    assert.match(result.github.mirror.reason, /working copy equals main/);
    ({ result } = await status({ make: make(A, A), routes: repoRoutes({ main: B, base: A, commits: nonMake }) }));
    assert.equal(result.github.mirror.state, 'unsafe');
    assert.match(result.github.mirror.reason, /overwrite 1 commit\(s\) on main not made by Make since make-deploy\/2/);
    ({ result } = await status({ make: make(A, C), routes: repoRoutes({ main: B, base: A, commits: bot }) }));
    assert.equal(result.github.mirror.state, 'safe');
    assert.match(result.github.mirror.reason, /only Make's own mirror commits; unsaved Make changes would be pushed/);
  });

  it('without a deploy tag reports no-base and checks the whole history', async () => {
    const commits = [{ sha: sha('d'), author: { login: 'figma[bot]' } }];
    const { result, calls } = await status({ make: makeSide({ saved: A }), routes: repoRoutes({ main: B, commits }) });
    assert.equal(result.github.base, null);
    assert.equal(result.github.relation, 'no-base');
    assert.ok(calls.includes(`repos/${REPO}/commits?sha=${sha('a')}&per_page=100`));
    const insync = await status({ make: makeSide({ saved: A }), routes: repoRoutes({ main: A, commits }) });
    assert.equal(insync.result.github.relation, 'in-sync');
  });

  it('fails closed on truncation, rewritten history, a receipt mismatch and a lightweight tag', async () => {
    let { result } = await status({ make: makeSide({ saved: A }),
      routes: repoRoutes({ main: B, commits: Array.from({ length: 100 }, (_, i) => ({ sha: i.toString(16).padStart(40, '0'), author: { login: 'figma[bot]' } })) }) });
    assert.equal(result.github.truncated, true);
    assert.equal(result.github.mirror.state, 'unknown');
    ({ result } = await status({ make: makeSide({ saved: A }), routes: repoRoutes({ main: A, base: A, commits: [], compareStatus: 'diverged' }) }));
    assert.ok(result.attention.includes('main no longer descends from make-deploy/2'));
    ({ result } = await status({ make: makeSide({ saved: A }), routes: repoRoutes({ main: A, base: A, commits: [], receiptTree: treeOf(B) }) }));
    assert.match(result.github.base.receiptMismatch, /receipt mainTree/);
    ({ result } = await status({ make: makeSide({ saved: A }), routes: repoRoutes({ main: A, base: A, commits: [], tag: 'lightweight' }) }));
    assert.equal(result.github.base.receipt, 'none');
    assert.equal(result.github.relation, 'in-sync');
  });

  it('reports the caller permission; only admin may deploy', async () => {
    for (const [permissions, expected] of [[{ maintain: true, push: true }, 'maintain'], [{ push: true }, 'write'], [{ pull: true }, 'read'], [{}, 'none']]) {
      const { result } = await status({ make: makeSide({ saved: A }), routes: repoRoutes({ main: A, commits: [], permissions }) });
      assert.equal(result.github.permission, expected);
      assert.equal(result.github.mayDeploy, false);
    }
  });

  it('compares LFS paths outside the tree join', async () => {
    // Make's git stores the LFS pointer; GitHub holds the raw bytes.
    const png = content => new Map([...A, ['public/a.png', { mode: '100644', blob: blob(content) }]]);
    const make = makeSide({ saved: png('pointer'), lfs: ['public/a.png'] });
    const { result } = await status({ make, routes: repoRoutes({ main: png('raw'), commits: [] }) });
    assert.equal(result.github.relation, 'in-sync');
    assert.ok(result.github.comparedWithoutLfs);
    assert.ok(result.attention.some(item => /1 LFS path/.test(item)));
  });

  it('leaves LFS paths out of the working-vs-saved and mirror comparisons', async () => {
    const png = content => new Map([...A, ['public/a.png', { mode: '100644', blob: blob(content) }]]);
    const make = makeSide({ saved: png('pointer'), working: png('raw'), lfs: ['public/a.png'] });
    const { result } = await status({ make, routes: repoRoutes({ main: png('raw'), commits: [{ sha: sha('d'), author: { login: 'dev' } }],
      pulls: { [sha('d')]: merged(1) } }) });
    assert.ok(!result.attention.includes('The Make working copy differs from its saved tree'));
    assert.equal(result.github.mirror.state, 'safe');
    assert.match(result.github.mirror.reason, /equals main$/);
  });

  it('hashes submodule gitlinks instead of failing the status', async () => {
    const withSubmodule = new Map([...A, ['vendor/lib', { mode: '160000', blob: sha('e') }]]);
    const { result } = await status({ make: makeSide({ saved: withSubmodule }), routes: repoRoutes({ main: withSubmodule, commits: [] }) });
    assert.equal(result.github.relation, 'in-sync');
  });

  it('status mode uses a recorded repo link when --repo is omitted', () => {
    const result = buildStatus({ fileKey: KEY, make: makeSide({ saved: A }), marker: parseMarker(null, KEY), linked: REPO });
    assert.equal(result.mode.mode, 'ambiguous');
    assert.equal(result.mode.source, 'linked');
  });

  it('reports Make-side problems: no baseline, pending, AI-turn baseline in team mode, generation, ambiguous mode', async () => {
    const history = { generationInProgress: true, ambiguous: false, aiTurns: 3, latest: { versionNumber: 5, gitSha: sha('c') } };
    const { result } = await status({ make: makeSide({ saved: A, working: B, history, state: { hasBaseline: false, pendingCount: 2 } }),
      routes: repoRoutes({ main: A, commits: [] }) });
    for (const item of ['Make has no saved version (baseline); make save-version --first-version can create one', 'Make has 2 pending change(s)', 'A Make AI generation is running',
      'Make\'s saved version came from an AI turn, which team mode does not allow', 'The Make working copy differs from its saved tree']) {
      assert.ok(result.attention.includes(item), item);
    }
    const ambiguous = await status({ make: makeSide({ saved: A }), markerBytes: null, routes: repoRoutes({ main: A, commits: [] }) });
    assert.equal(ambiguous.result.mode.mode, 'ambiguous');
    assert.equal(statusExitCode(ambiguous.result), 2);
  });

  it('a solo file without --repo is clean, and a GitHub failure exits 1', async () => {
    const solo = buildStatus({ fileKey: KEY, make: makeSide({ saved: A }), marker: parseMarker(null, KEY) });
    assert.equal(solo.mode.mode, 'solo');
    assert.equal(solo.github, undefined);
    assert.equal(statusExitCode(solo), 0);
    const { result } = await status({ make: makeSide({ saved: A }), routes: { [`repos/${REPO}`]: new Error('HTTP 404') } });
    assert.equal(result.github.error, 'HTTP 404');
    assert.equal(statusExitCode(result), 1);
  });
});
