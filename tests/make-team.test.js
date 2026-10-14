import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { areaOwners, checkState, commitMessage, conflicts, defaultRun, findSecrets, globPattern, isOwnBranch, merge, parseAreas, pr,
  prBody, pushBranch, repoFromUrl, resolveIdenticalHunks, reviewState, save, slugify, start, status, sync, teamContext } from '../src/make-team.js';

// Local git only: a bare "origin" in a temp folder stands in for GitHub, gh
// and pnpm are faked. Nothing here reaches Figma, GitHub or a registry.
const REPO = 'owner/proto';
const ME = 'alice';
const PKG = { name: 'app', private: true, scripts: { dev: 'vite' }, dependencies: { react: '^19.0.0' } };

const config = mkdtempSync(join(tmpdir(), 'figma-cli-team-git-'));
writeFileSync(join(config, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(config, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' });
process.on('exit', () => rmSync(config, { recursive: true, force: true }));

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'figma-cli-team-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const sh = (dir, ...args) => {
  const result = defaultRun('git', args, { cwd: dir });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) { rmSync(join(dir, path), { force: true }); continue; }
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
const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

// origin (bare), "upstream" (other people landing work on main) and the
// designer's clone.
function project(t, { areas, files = {} } = {}) {
  const root = temp(t);
  const origin = join(root, 'origin.git');
  const upstream = join(root, 'upstream');
  const clone = join(root, 'clone');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'init', '-q', '-b', 'main', upstream);
  commit(upstream, { 'package.json': PKG, 'pnpm-lock.yaml': 'lockfileVersion: 9.0\nreact: 19\n', 'src/App.tsx': lines(20),
    '.figma-cli/project.json': { fileKey: 'K', repo: REPO, trunk: 'main', ...(areas ? { areas } : {}) }, ...files }, 'initial');
  sh(upstream, 'remote', 'add', 'origin', origin);
  sh(upstream, 'push', '-q', 'origin', 'main');
  sh(root, 'clone', '-q', origin, clone);
  const land = (changes, message = 'other work') => {
    sh(upstream, 'pull', '-q', '--ff-only', 'origin', 'main');
    const sha = commit(upstream, changes, message);
    sh(upstream, 'push', '-q', 'origin', 'main');
    return sha;
  };
  const originSha = ref => sh(origin, 'rev-parse', ref);
  return { root, origin, upstream, clone, land, originSha };
}

// gh and pnpm fakes. Pull requests live in memory; "merging" squashes the
// branch onto origin main through a scratch working copy, the way GitHub would.
function fakes(p, { login = ME, build = 0, format = null, pulls = {}, edit = 0 } = {}) {
  const calls = [];
  const prs = [];
  const run = (command, args, options = {}) => {
    calls.push({ command, args });
    if (command === 'git') {
      if (args[0] === 'push') {
        const text = args.join(' ');
        assert.ok(!/refs\/heads\/main\b|\bmain$|:main\b/.test(text), `pushed main: ${text}`);
        assert.ok(!args.some(a => a === '--force' || a === '-f' || /^\+/.test(a)), `unleased force push: ${text}`);
        assert.ok(!args.some(a => a.startsWith('--force-with-lease') && !/=refs\/heads\/[^:]+:[a-f0-9]{40}$/.test(a)), `bare lease: ${text}`);
      }
      return defaultRun(command, args, options);
    }
    if (command === 'pnpm') {
      if (args[1] === 'build') return { status: build, stdout: build ? 'src/App.tsx(3,1): error TS2304\n' : 'built\n', stderr: '' };
      if (args[1] === 'format') { format?.(options.cwd); return { status: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'install') {
        const pkg = JSON.parse(readFileSync(join(options.cwd, 'package.json'), 'utf8'));
        writeFileSync(join(options.cwd, 'pnpm-lock.yaml'), `lockfileVersion: 9.0\n${Object.keys(pkg.dependencies).sort().map(d => `${d}: x\n`).join('')}`);
        return { status: 0, stdout: '', stderr: '' };
      }
    }
    if (command !== 'gh') return { status: 127, stdout: '', stderr: `${command}: not found` };
    const flag = name => args[args.indexOf(name) + 1];
    const ok = value => ({ status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
    if (args[0] === 'api' && args[1] === 'user') return ok(`${login}\n`);
    if (args[0] === 'api') {
      const path = args.find(a => a.startsWith('repos/'));
      const number = /pulls\/(\d+)\/reviews$/.exec(path)?.[1];
      if (number) {
        assert.ok(args.includes('--paginate'));
        return ok(prs.find(x => String(x.number) === number).reviews.map(r => `${JSON.stringify(r)}\n`).join(''));
      }
      const sha = /commits\/([a-f0-9]+)\/pulls/.exec(path)?.[1];
      return ok(pulls[sha] || []);
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      const head = flag('--head');
      const state = flag('--state');
      return ok(prs.filter(x => x.headRefName === head && (state === 'all' || x.state === 'OPEN')).map(x => ({ ...x, headRefOid: p.originSha(`refs/heads/${head}`) })));
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      assert.equal(flag('--base'), 'main');
      assert.equal(flag('--repo'), REPO);
      const number = prs.length + 1;
      prs.push({ number, url: `https://github.com/${REPO}/pull/${number}`, state: 'OPEN', isDraft: false, author: { login },
        headRefName: flag('--head'), baseRefName: 'main', title: flag('--title'), body: flag('--body'), reviews: [], isCrossRepository: false, reviewRequests: [], statusCheckRollup: [] });
      return ok(`Creating pull request\nhttps://github.com/${REPO}/pull/${number}\n`);
    }
    if (args[0] === 'pr' && args[1] === 'edit') {
      if (edit) return { status: 1, stdout: '', stderr: 'could not request reviewer' };
      const target = prs.find(x => x.url === args[2]);
      target.reviewRequests.push({ login: flag('--add-reviewer') });
      return ok('');
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      const target = prs.find(x => String(x.number) === args[2]);
      assert.ok(args.includes('--squash'));
      const head = p.originSha(`refs/heads/${target.headRefName}`);
      assert.equal(flag('--match-head-commit'), head);
      const server = join(p.root, `server-${target.number}`);
      sh(p.root, 'clone', '-q', p.origin, server);
      sh(server, 'merge', '--squash', '-q', `origin/${target.headRefName}`);
      sh(server, 'commit', '-q', '-m', `${target.title} (#${target.number})`);
      sh(server, 'push', '-q', 'origin', 'main');
      target.state = 'MERGED';
      target.mergeCommit = { oid: sh(server, 'rev-parse', 'HEAD') };
      return ok('');
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const target = prs.find(x => String(x.number) === args[2]);
      return ok({ state: target.state, mergeCommit: target.mergeCommit || null });
    }
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  const warnings = [];
  const ctx = (dir = p.clone) => teamContext({ dir, run, warn: m => warnings.push(m) });
  return { run, calls, prs, ctx, warnings, pnpm: () => calls.filter(c => c.command === 'pnpm').map(c => c.args.join(' ')) };
}
// A review of the branch's current GitHub head unless a commit is given.
const review = (p, pull, login, state = 'APPROVED', commit = p.originSha(`refs/heads/${pull.headRefName}`)) => pull.reviews.push({ login, state, commit });
const code = (fn, expected) => assert.throws(fn, error => { assert.equal(error.code, expected, error.message); return true; });

describe('team: pure helpers', () => {
  it('slugs task names and builds own-branch checks', () => {
    assert.equal(slugify('  New filter panel! '), 'new-filter-panel');
    assert.equal(slugify('Café — hero'), 'cafe-hero');
    assert.equal(slugify('x'.repeat(80)).length, 48);
    code(() => slugify('!!!'), 'TEAM_BAD_NAME');
    assert.equal(isOwnBranch('alice/x', 'Alice'), true);
    assert.equal(isOwnBranch('alice/', 'alice'), false);
    assert.equal(isOwnBranch('bob/x', 'alice'), false);
    assert.equal(isOwnBranch('main', 'alice'), false);
  });
  it('matches area globs and ignores malformed owners', () => {
    const areas = parseAreas({ 'src/components/**': ['@bob', 'carol'], 'src/*.css': 'dave', 'docs/': ['eve'], 'x/**': [1, 'not a login!'] });
    assert.equal(areas.length, 3);
    assert.ok(globPattern('src/components/**').test('src/components/a/b.tsx'));
    assert.ok(globPattern('**/*.tsx').test('App.tsx'));
    assert.ok(!globPattern('src/*.css').test('src/a/b.css'));
    assert.deepEqual(areaOwners(areas, ['src/components/Card.tsx', 'src/index.css', 'docs/a.md', 'README.md']).map(a => [a.area, a.owners]),
      [['src/components/**', ['bob', 'carol']], ['src/*.css', ['dave']], ['docs/', ['eve']]]);
  });
  it('reads GitHub repos from origin URLs', () => {
    assert.equal(repoFromUrl('https://github.com/owner/proto.git'), 'owner/proto');
    assert.equal(repoFromUrl('git@github.com:owner/proto.git\n'), 'owner/proto');
    assert.equal(repoFromUrl('https://x-access-token@github.com/owner/proto'), 'owner/proto');
    assert.equal(repoFromUrl('/tmp/origin.git'), null);
    assert.equal(repoFromUrl('https://gitlab.com/owner/proto'), null);
  });
  it('resolves only identical conflict hunks', () => {
    const same = 'a\n<<<<<<< HEAD\nx\n=======\nx\n>>>>>>> b\nz\n';
    assert.deepEqual(resolveIdenticalHunks(same), { resolved: true, blocks: 1, text: 'a\nx\nz\n' });
    const diff3 = 'a\n<<<<<<< HEAD\nx\n||||||| base\nold\n=======\nx\n>>>>>>> b\n';
    assert.equal(resolveIdenticalHunks(diff3).text, 'a\nx\n');
    assert.deepEqual(resolveIdenticalHunks('<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n'), { resolved: false, blocks: 1 });
    assert.equal(resolveIdenticalHunks('no markers\n'), null);
    assert.equal(resolveIdenticalHunks('<<<<<<< HEAD\nx\n'), null);
  });
  it('counts only current-head approvals from someone other than the author or merger', () => {
    const head = 'a'.repeat(40);
    const old = 'b'.repeat(40);
    const base = { author: 'alice', merger: 'alice', head, requests: [{ login: 'carol' }] };
    assert.deepEqual(reviewState({ ...base, reviews: [{ login: 'Alice', state: 'APPROVED', commit: head }, { login: 'bob', state: 'COMMENTED', commit: head }] }).approvedBy, []);
    assert.deepEqual(reviewState({ ...base, reviews: [] }).waitingOn, ['carol']);
    const stale = reviewState({ ...base, reviews: [{ login: 'bob', state: 'APPROVED', commit: old }] });
    assert.deepEqual([stale.approvedBy, stale.staleApprovals.map(r => r.who)], [[], ['bob']]);
    assert.deepEqual(reviewState({ ...base, author: 'bob', reviews: [{ login: 'alice', state: 'APPROVED', commit: head }] }).approvedBy, [], 'the merger never approves');
    const later = reviewState({ ...base, reviews: [{ login: 'dave', state: 'APPROVED', commit: head }, { login: 'erin', state: 'APPROVED', commit: head },
      { login: 'erin', state: 'CHANGES_REQUESTED', commit: head }, { login: 'dave', state: 'COMMENTED', commit: head }] });
    assert.deepEqual(later.approvedBy.map(r => r.who), ['dave']);
    assert.deepEqual(later.changesRequestedBy.map(r => r.who), ['erin']);
  });
  it('summarises checks', () => {
    assert.equal(checkState({ statusCheckRollup: [] }).state, 'none');
    assert.equal(checkState({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'v', state: 'SUCCESS' }, { name: 's', status: 'COMPLETED', conclusion: 'SKIPPED' }] }).state, 'passing');
    assert.deepEqual(checkState({ statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS' }] }).pending, ['ci']);
    assert.deepEqual(checkState({ statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }, { context: 'v', state: 'PENDING' }] }).failing, ['ci']);
  });
  it('writes commit messages and the PR template', () => {
    assert.equal(commitMessage([{ path: 'src/A.tsx', change: 'new file' }]), 'Add src/A.tsx');
    assert.equal(commitMessage([{ path: 'src/a/A.tsx', change: 'changed' }, { path: 'src/a/B.tsx', change: 'deleted' }]), 'Update 2 files in src/a');
    assert.equal(commitMessage([{ path: 'a', change: 'changed' }, { path: 'src/b', change: 'changed' }]), 'Update 2 files');
    const body = prBody({ branch: 'alice/x', files: ['changed: src/App.tsx'], task: 'X' });
    for (const part of ['## What changed', '- changed: src/App.tsx', 'gh pr checkout alice/x', '## Screenshot']) assert.ok(body.includes(part), part);
  });
  it('finds secret files and token-looking content by path and line only', t => {
    const dir = temp(t);
    write(dir, { '.env.local': 'X=1\n', '.env.example': 'X=\n', 'a/.npmrc': 'registry=x\n', 'src/ok.ts': 'const x = 1;\n',
      'src/leak.ts': `const a = 1;\nconst t = "ghp_${'A'.repeat(36)}";\n`, 'cfg/.yarnrc': '//r/:_authToken=${NPM_TOKEN}\n', 'id_rsa': 'k' });
    const findings = findSecrets(dir, ['.env.local', '.env.example', 'a/.npmrc', 'src/ok.ts', 'src/leak.ts', 'cfg/.yarnrc', 'id_rsa'].map(path => ({ path, change: 'new file' })));
    assert.deepEqual(findings.map(f => `${f.path}${f.line ? `:${f.line}` : ''}`), ['.env.local', 'a/.npmrc', 'src/leak.ts:2', 'id_rsa']);
    assert.ok(!JSON.stringify(findings).includes('ghp_'));
  });
});

describe('team: the push guard', () => {
  it('refuses main, other people\'s branches, raw refs and inexact leases', t => {
    const p = project(t);
    const ctx = fakes(p).ctx();
    for (const branch of ['main', 'refs/heads/alice/x', 'alice/x:main', '-f', '', 'bob/x']) code(() => pushBranch(ctx, branch), 'TEAM_PUSH_REFUSED');
    code(() => pushBranch(ctx, 'alice/x', { lease: 'HEAD' }), 'TEAM_PUSH_REFUSED');
  });
});

describe('team start', () => {
  it('branches <login>/<slug> from the latest GitHub main and pushes it with upstream', t => {
    const p = project(t);
    const f = fakes(p);
    const newer = p.land({ 'src/New.tsx': 'x\n' });
    const result = start(f.ctx(), 'New filter panel');
    assert.equal(result.branch, 'alice/new-filter-panel');
    assert.equal(sh(p.clone, 'rev-parse', 'HEAD'), newer);
    assert.equal(sh(p.clone, 'rev-parse', 'main'), newer, 'local main fast-forwarded');
    assert.equal(p.originSha('refs/heads/alice/new-filter-panel'), newer);
    assert.equal(sh(p.clone, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/alice/new-filter-panel');
    assert.equal(sh(p.clone, 'config', 'branch.alice/new-filter-panel.figmaCliTask'), 'New filter panel');
    code(() => start(f.ctx(), 'new filter panel'), 'TEAM_BRANCH_EXISTS');
  });
  it('requires a clean tree, saving first only when asked', t => {
    const p = project(t);
    const f = fakes(p);
    start(f.ctx(), 'one');
    write(p.clone, { 'src/App.tsx': lines(21) });
    code(() => start(f.ctx(), 'two'), 'TEAM_UNSAVED');
    const result = start(f.ctx(), 'two', { saveFirst: true });
    assert.equal(result.saved.branch, 'alice/one');
    assert.equal(sh(p.clone, 'log', '-1', '--format=%s', 'origin/alice/one'), 'Update src/App.tsx');
    assert.equal(result.branch, 'alice/two');
    assert.equal(sh(p.clone, 'status', '--porcelain'), '');
  });
  it('moves unsaved changes made on main onto the new branch, leaving main alone', t => {
    const p = project(t);
    const f = fakes(p);
    const before = p.originSha('main');
    write(p.clone, { 'src/Card.tsx': 'card\n' });
    const result = start(f.ctx(), 'card', { saveFirst: true });
    assert.equal(result.saved.saved, true);
    assert.equal(p.originSha('main'), before);
    assert.equal(sh(p.clone, 'show', 'origin/alice/card:src/Card.tsx'), 'card');
  });
  it('refuses when local main has commits that are not on GitHub', t => {
    const p = project(t);
    commit(p.clone, { 'x.txt': 'x' }, 'local only');
    code(() => start(fakes(p).ctx(), 'x'), 'TEAM_MAIN_AHEAD');
    assert.equal(sh(p.clone, 'branch', '--show-current'), 'main');
  });
});

describe('team save', () => {
  it('refuses main, detached HEAD and other people\'s branches', t => {
    const p = project(t);
    const f = fakes(p);
    write(p.clone, { 'a.txt': 'a' });
    code(() => save(f.ctx()), 'TEAM_ON_MAIN');
    sh(p.clone, 'switch', '-q', '-c', 'bob/thing');
    code(() => save(f.ctx()), 'TEAM_NOT_YOUR_BRANCH');
    sh(p.clone, 'switch', '-q', '--detach');
    code(() => save(f.ctx()), 'TEAM_DETACHED');
  });
  it('formats, builds, commits with a generated message and pushes', t => {
    const p = project(t, { files: { 'package.json': { ...PKG, scripts: { ...PKG.scripts, format: 'prettier -w .', build: 'vite build' } } } });
    const f = fakes(p, { format: dir => writeFileSync(join(dir, 'src/App.tsx'), lines(22)) });
    start(f.ctx(), 'hero');
    write(p.clone, { 'src/App.tsx': lines(21), 'src/Hero.tsx': 'hero\n' });
    const result = save(f.ctx());
    assert.deepEqual(f.pnpm(), ['run format', 'run build']);
    assert.deepEqual(result.files, ['changed: src/App.tsx', 'new file: src/Hero.tsx']);
    assert.equal(result.commit.message, 'Update 2 files in src');
    assert.equal(p.originSha('refs/heads/alice/hero'), result.commit.sha);
    assert.equal(readFileSync(join(p.clone, 'src/App.tsx'), 'utf8'), lines(22), 'formatted content was committed');
    assert.equal(sh(p.clone, 'status', '--porcelain'), '');
    const again = save(f.ctx(), { message: 'ignored' });
    assert.equal(again.saved, false);
    assert.equal(again.pushed, false);
  });
  it('blocks a failing build, secret files and token content, saving nothing', t => {
    const p = project(t, { files: { 'package.json': { ...PKG, scripts: { ...PKG.scripts, build: 'vite build' } } } });
    const failing = fakes(p, { build: 1 });
    start(failing.ctx(), 'hero');
    const head = sh(p.clone, 'rev-parse', 'HEAD');
    write(p.clone, { 'src/Hero.tsx': 'hero\n' });
    assert.throws(() => save(failing.ctx()), error => error.code === 'TEAM_BUILD_FAILED' && /TS2304/.test(error.message));
    const f = fakes(p);
    write(p.clone, { '.env.production': 'KEY=1\n' });
    code(() => save(f.ctx()), 'TEAM_SECRET');
    write(p.clone, { '.env.production': null, 'src/api.ts': `export const key = "npm_${'b'.repeat(36)}";\n` });
    assert.throws(() => save(f.ctx()), error => error.code === 'TEAM_SECRET' && error.secrets[0].path === 'src/api.ts' && !error.message.includes('npm_b'));
    assert.equal(sh(p.clone, 'rev-parse', 'HEAD'), head);
    assert.equal(p.originSha('refs/heads/alice/hero'), head);
    assert.equal(f.pnpm().length, 0, 'secrets are refused before any script runs');
  });
  it('flags files in another person\'s area', t => {
    const p = project(t, { areas: { 'src/components/**': ['bob'], 'src/mine/**': ['alice'] } });
    const f = fakes(p);
    start(f.ctx(), 'x');
    write(p.clone, { 'src/components/Card.tsx': 'c\n', 'src/mine/A.tsx': 'a\n' });
    const result = save(f.ctx(), { message: 'Cards' });
    assert.equal(result.commit.message, 'Cards');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /src\/components\/Card\.tsx is in src\/components\/\*\*, owned by @bob/);
  });
});

describe('team sync and conflicts', () => {
  it('saves, rebases onto the latest main and pushes with a lease, never touching main', t => {
    const p = project(t);
    const f = fakes(p);
    start(f.ctx(), 'x');
    write(p.clone, { 'src/A.tsx': 'a\n' });
    const mainSha = p.land({ 'src/B.tsx': 'b\n' });
    const result = sync(f.ctx());
    assert.equal(result.saved, true);
    assert.equal(result.broughtIn, true);
    assert.equal(sh(p.clone, 'rev-parse', 'HEAD^'), mainSha);
    assert.equal(p.originSha('refs/heads/alice/x'), sh(p.clone, 'rev-parse', 'HEAD'));
    assert.equal(p.originSha('main'), mainSha);
    assert.ok(f.calls.some(c => c.command === 'git' && c.args[0] === 'push' && c.args.some(a => a.startsWith('--force-with-lease=refs/heads/alice/x:'))));
    assert.equal(sync(f.ctx()).broughtIn, false);
  });
  it('refuses to overwrite newer work on the remote branch', t => {
    const p = project(t);
    const f = fakes(p);
    start(f.ctx(), 'x');
    const other = join(p.root, 'laptop');
    sh(p.root, 'clone', '-q', '-b', 'alice/x', p.origin, other);
    commit(other, { 'other.txt': 'o' });
    sh(other, 'push', '-q', 'origin', 'alice/x');
    write(p.clone, { 'mine.txt': 'm' });
    code(() => save(f.ctx()), 'TEAM_PUSH_REJECTED');
  });
  it('stops on a real conflict, leaves the branch untouched and names the other PR and author', t => {
    const p = project(t);
    const shaOf = {};
    const f = fakes(p, { pulls: new Proxy({}, { get: (_, sha) => shaOf[sha] }) });
    start(f.ctx(), 'x');
    const app = lines(20).replace('line 5', 'mine');
    write(p.clone, { 'src/App.tsx': app });
    save(f.ctx());
    const head = sh(p.clone, 'rev-parse', 'HEAD');
    const landed = p.land({ 'src/App.tsx': lines(20).replace('line 5', 'theirs') }, 'Theirs (#7)');
    shaOf[landed] = [{ url: `https://github.com/${REPO}/pull/7`, author: 'bob' }];
    assert.throws(() => sync(f.ctx()), error => {
      assert.equal(error.code, 'TEAM_CONFLICT');
      assert.equal(error.untouched, true);
      assert.deepEqual(error.conflicts, [{ path: 'src/App.tsx', changedBy: [{ commit: landed, author: '@bob', pr: `https://github.com/${REPO}/pull/7` }] }]);
      assert.match(error.message, /src\/App\.tsx was also changed by @bob in https:\/\/github\.com\/owner\/proto\/pull\/7/);
      return true;
    });
    assert.equal(sh(p.clone, 'rev-parse', 'HEAD'), head);
    assert.equal(p.originSha('refs/heads/alice/x'), head);
    assert.equal(readFileSync(join(p.clone, 'src/App.tsx'), 'utf8'), app);
    assert.equal(sh(p.clone, 'status', '--porcelain'), '');
    code(() => conflicts(f.ctx()), 'TEAM_CONFLICT');
  });
  it('falls back to the squash subject for the other PR when gh has no answer', t => {
    const p = project(t);
    const f = fakes(p);
    start(f.ctx(), 'x');
    write(p.clone, { 'src/App.tsx': lines(20).replace('line 2', 'mine') });
    save(f.ctx());
    p.land({ 'src/App.tsx': lines(20).replace('line 2', 'theirs') }, 'Hero tweaks (#12)');
    assert.throws(() => sync(f.ctx()), error => error.conflicts[0].changedBy[0].pr === `https://github.com/${REPO}/pull/12` && error.conflicts[0].changedBy[0].author === 'Test');
  });
  it('auto-resolves pnpm-lock.yaml by taking main\'s and regenerating it', t => {
    const p = project(t);
    const f = fakes(p);
    start(f.ctx(), 'deps');
    write(p.clone, { 'package.json': { ...PKG, dependencies: { ...PKG.dependencies, clsx: '^2' } }, 'pnpm-lock.yaml': 'lockfileVersion: 9.0\nclsx: x\nreact: 19\n' });
    save(f.ctx());
    p.land({ 'src/App.tsx': lines(21), 'pnpm-lock.yaml': 'lockfileVersion: 9.0\nreact: 19.1\n' });
    const result = sync(f.ctx());
    assert.deepEqual(result.autoResolved, ['pnpm-lock.yaml: took main\'s and regenerated it']);
    assert.ok(f.pnpm().includes('install --lockfile-only --ignore-scripts'));
    assert.equal(readFileSync(join(p.clone, 'pnpm-lock.yaml'), 'utf8'), 'lockfileVersion: 9.0\nclsx: x\nreact: x\n');
    assert.equal(sh(p.clone, 'status', '--porcelain'), '');
    assert.equal(p.originSha('refs/heads/alice/deps'), sh(p.clone, 'rev-parse', 'HEAD'));
  });
  it('finishes an unfinished rebase whose only conflicts are identical hunks', t => {
    const p = project(t);
    const f = fakes(p);
    start(f.ctx(), 'x');
    write(p.clone, { 'src/App.tsx': lines(20).replace('line 9', 'mine') });
    save(f.ctx());
    p.land({ 'src/App.tsx': lines(20).replace('line 9', 'theirs') });
    sh(p.clone, 'fetch', '-q', 'origin', 'main');
    assert.notEqual(defaultRun('git', ['rebase', 'origin/main'], { cwd: p.clone }).status, 0);
    write(p.clone, { 'src/App.tsx': lines(20).replace('line 9', '<<<<<<< HEAD\nsame\n=======\nsame\n>>>>>>> mine') });
    const result = conflicts(f.ctx());
    assert.deepEqual(result.autoResolved, ['src/App.tsx: both sides made the same change']);
    assert.equal(readFileSync(join(p.clone, 'src/App.tsx'), 'utf8'), lines(20).replace('line 9', 'same'));
    assert.equal(sh(p.clone, 'branch', '--show-current'), 'alice/x');
    assert.equal(p.originSha('refs/heads/alice/x'), sh(p.clone, 'rev-parse', 'HEAD'));
  });
});

describe('team pr and merge', () => {
  function ready(t, opts = {}) {
    const p = project(t, opts);
    const f = fakes(p, opts);
    start(f.ctx(), 'Filter panel');
    write(p.clone, { 'src/components/Filter.tsx': 'filter\n', ...(opts.extra || {}) });
    return { p, f };
  }
  it('syncs, saves and opens a PR into main with the template and area reviewers', t => {
    const { p, f } = ready(t, { areas: { 'src/components/**': ['bob', 'alice'] } });
    const mainSha = p.land({ 'src/B.tsx': 'b\n' });
    const result = pr(f.ctx());
    assert.equal(result.created, true);
    assert.equal(result.url, `https://github.com/${REPO}/pull/1`);
    assert.deepEqual(result.reviewers, ['@bob']);
    assert.equal(f.prs[0].title, 'Filter panel');
    assert.match(f.prs[0].body, /new file: src\/components\/Filter\.tsx/);
    assert.ok(!f.prs[0].body.includes('src/B.tsx'));
    assert.equal(sh(p.clone, 'rev-parse', 'HEAD^'), mainSha);
    const again = pr(f.ctx());
    assert.equal(again.created, false);
    assert.equal(f.prs.length, 1);
  });
  it('warns, but still opens the PR, when a reviewer cannot be requested', t => {
    const { f } = ready(t, { areas: { 'src/**': ['bob'] }, edit: 1 });
    const result = pr(f.ctx());
    assert.deepEqual(result.reviewersNotRequested, ['@bob']);
    assert.match(f.warnings[0], /Could not ask @bob/);
  });
  it('refuses a PR with nothing to review', t => {
    const p = project(t);
    const f = fakes(p);
    start(f.ctx(), 'empty');
    code(() => pr(f.ctx()), 'TEAM_NOTHING_TO_REVIEW');
  });
  it('refuses to merge without a non-author approval, with requested changes or unfinished checks', t => {
    const { p, f } = ready(t);
    save(f.ctx());
    code(() => merge(f.ctx()), 'TEAM_NO_PR');
    pr(f.ctx());
    const [pull] = f.prs;
    const mainBefore = p.originSha('main');
    code(() => merge(f.ctx()), 'TEAM_NOT_APPROVED');
    review(p, pull, ME);
    code(() => merge(f.ctx()), 'TEAM_NOT_APPROVED');
    review(p, pull, 'bob', 'APPROVED', 'f'.repeat(40));
    assert.throws(() => merge(f.ctx()), error => error.code === 'TEAM_NOT_APPROVED' && /@bob approved an earlier version/.test(error.message));
    review(p, pull, 'bob', 'CHANGES_REQUESTED');
    code(() => merge(f.ctx()), 'TEAM_CHANGES_REQUESTED');
    review(p, pull, 'bob');
    pull.statusCheckRollup = [{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }];
    code(() => merge(f.ctx()), 'TEAM_CHECKS_FAILED');
    pull.statusCheckRollup = [{ name: 'build', status: 'QUEUED' }];
    code(() => merge(f.ctx()), 'TEAM_CHECKS_PENDING');
    pull.isDraft = true;
    code(() => merge(f.ctx()), 'TEAM_PR_NOT_READY');
    pull.isDraft = false;
    pull.isCrossRepository = true;
    code(() => merge(f.ctx()), 'TEAM_NO_PR');
    assert.equal(p.originSha('main'), mainBefore);
    assert.ok(!f.calls.some(c => c.command === 'gh' && c.args[1] === 'merge'));
  });
  it('syncs and asks again when main moved, and refuses unsaved work', t => {
    const { p, f } = ready(t);
    pr(f.ctx());
    review(p, f.prs[0], 'bob');
    const moved = p.land({ 'src/C.tsx': 'c\n' });
    code(() => merge(f.ctx()), 'TEAM_BEHIND_MAIN');
    assert.equal(sh(p.clone, 'rev-parse', 'HEAD^'), moved);
    assert.equal(p.originSha('refs/heads/alice/filter-panel'), sh(p.clone, 'rev-parse', 'HEAD'));
    write(p.clone, { 'late.txt': 'x' });
    code(() => merge(f.ctx()), 'TEAM_UNSAVED');
  });
  it('refuses another person\'s branch even with an approved PR', t => {
    const { p, f } = ready(t);
    pr(f.ctx());
    sh(p.clone, 'switch', '-q', '-c', 'bob/thing');
    code(() => merge(f.ctx()), 'TEAM_NOT_YOUR_BRANCH');
  });
  it('squash-merges an approved, green, up-to-date PR, deletes the branch and returns to main', t => {
    const { p, f } = ready(t);
    pr(f.ctx());
    review(p, f.prs[0], 'bob');
    f.prs[0].statusCheckRollup = [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    const result = merge(f.ctx());
    assert.deepEqual(result.approvedBy, ['@bob']);
    assert.equal(result.checks, 'passing');
    assert.equal(sh(p.clone, 'branch', '--show-current'), 'main');
    assert.equal(sh(p.clone, 'rev-parse', 'HEAD'), p.originSha('main'));
    assert.equal(sh(p.origin, 'log', '-1', '--format=%s', 'main'), 'Filter panel (#1)');
    assert.equal(defaultRun('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/alice/filter-panel'], { cwd: p.origin }).status, 1);
    assert.equal(defaultRun('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/alice/filter-panel'], { cwd: p.clone }).status, 1);
    assert.ok(existsSync(join(p.clone, 'src/components/Filter.tsx')));
  });
});

describe('team status', () => {
  it('reports branch, unsaved files, PR review state and distance from main', t => {
    const p = project(t);
    const f = fakes(p);
    const onMain = status(f.ctx());
    assert.equal(onMain.branch, 'main');
    assert.match(onMain.summary, /start a task/);
    start(f.ctx(), 'x');
    write(p.clone, { 'a.txt': 'a' });
    save(f.ctx());
    p.land({ 'b.txt': 'b' });
    write(p.clone, { 'c.txt': 'c' });
    pr(f.ctx());
    write(p.clone, { 'd.txt': 'd' });
    review(p, f.prs[0], 'bob');
    p.land({ 'e.txt': 'e' });
    const result = status(f.ctx(), { now: Date.now() + 3 * 86400 * 1000 });
    assert.deepEqual(result.unsaved, ['new file: d.txt']);
    assert.equal(result.behindMain, 1);
    assert.equal(result.aheadOfMain, 2);
    assert.deepEqual(result.pr, { url: `https://github.com/${REPO}/pull/1`, state: 'OPEN', draft: false, approvedBy: ['@bob'], changesRequestedBy: [],
      waitingOn: [], checks: 'none' });
    assert.match(result.summary, /get the latest/);
    assert.match(result.summary, /save my progress/);
    assert.match(result.summary, /merge it/);
  });
});
