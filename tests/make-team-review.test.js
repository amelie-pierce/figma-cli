import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRun, merge, pr, save, start, sync, teamContext } from '../src/make-team.js';
import { address, approve, comment, commentable, feedback, inlineBuild, parseDiff, requestChanges, review, reviewPage, reviews,
  sourceFromSelector } from '../src/make-team-review.js';

// Local git only: a bare "origin" in a temp folder stands in for GitHub and
// one in-memory GitHub serves two people (alice writes, bob reviews), each
// with their own clone and gh login. Nothing reaches Figma, GitHub or a registry.
const REPO = 'owner/proto';
const PKG = { name: 'app', private: true, scripts: { dev: 'vite' }, dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^7.0.0' } };

const config = mkdtempSync(join(tmpdir(), 'figma-cli-review-git-'));
writeFileSync(join(config, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(config, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' });
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
const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const code = (fn, expected) => assert.throws(fn, error => { assert.equal(error.code, expected, error.message); return true; });

// A bare origin, alice's clone and bob's clone, and the GitHub both talk to.
function world(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'figma-cli-review-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'init', '-q', '-b', 'main', seed);
  write(seed, { 'package.json': PKG, 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n', 'src/App.tsx': lines(20), '.figma-cli/project.json': { repo: REPO } });
  sh(seed, 'add', '-A');
  sh(seed, 'commit', '-q', '-m', 'initial');
  sh(seed, 'remote', 'add', 'origin', origin);
  sh(seed, 'push', '-q', 'origin', 'main');
  for (const who of ['alice', 'bob']) sh(root, 'clone', '-q', origin, join(root, who));
  const originSha = ref => sh(origin, 'rev-parse', ref);
  const github = { prs: [], comments: [], calls: [] };
  const person = (login, { lavish = 0, vite = 0 } = {}) => {
    const warnings = [];
    const run = (command, args, options = {}) => {
      github.calls.push({ login, command, args });
      if (command === 'git') {
        if (args[0] === 'push') {
          const text = args.join(' ');
          assert.ok(!/refs\/heads\/main\b|\bmain$|:main\b/.test(text), `pushed main: ${text}`);
          assert.ok(args.some(a => a.includes(`refs/heads/${login}/`)), `${login} pushed someone else's branch: ${text}`);
        }
        return defaultRun(command, args, options);
      }
      if (command === 'node') return { status: 0, stdout: 'v22.0.0\n', stderr: '' };
      if (command === 'pnpm' && args[0] === '--version') return { status: 0, stdout: '10.0.0\n', stderr: '' };
      if (command === 'pnpm' && args[0] === 'install') {
        assert.deepEqual(args, ['install', '--frozen-lockfile', '--ignore-scripts']);
        mkdirSync(join(options.cwd, 'node_modules'), { recursive: true });
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'pnpm' && args[0] === 'exec') {
        if (vite) return { status: 1, stdout: '', stderr: 'vite: build failed' };
        const out = args[args.indexOf('--outDir') + 1];
        write(out, { 'index.html': '<html><head><link rel="modulepreload" href="./assets/v.js"><script type="module" crossorigin src="./assets/index.js"></script>' +
          '<link rel="stylesheet" crossorigin href="./assets/index.css"></head><body><div id="root"></div></body></html>',
        'assets/index.js': 'console.log("</script>")', 'assets/index.css': 'body{margin:0}' });
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'lavish-axi') return lavish ? { status: 127, stdout: '', stderr: 'not found' } : { status: 0, stdout: 'opened\n', stderr: '' };
      if (command !== 'gh') return { status: 127, stdout: '', stderr: `${command}: not found` };
      return gh(login, args);
    };
    const ctx = (dir = join(root, login)) => teamContext({ dir, run, warn: m => warnings.push(m) });
    return { login, dir: join(root, login), ctx, warnings, run };
  };
  const view = pull => ({ ...pull, headRefOid: originSha(`refs/heads/${pull.headRefName}`) });
  function gh(login, args) {
    const flag = name => args[args.indexOf(name) + 1];
    const ok = value => ({ status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
    const jsonLines = rows => ok(rows.map(r => `${JSON.stringify(r)}\n`).join(''));
    if (args[0] === 'api' && args[1] === 'user') return ok(`${login}\n`);
    if (args[0] === 'api') {
      const path = args.find(a => a.startsWith('repos/'));
      const post = args.includes('POST');
      const field = name => args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
      const [, kind, number, what] = /^repos\/[^/]+\/[^/]+\/(pulls|issues|commits)\/([^/]+)\/(\w+)$/.exec(path) || [];
      if (kind === 'commits') return ok('[]');
      const pull = github.prs.find(x => String(x.number) === number);
      if (kind === 'pulls' && what === 'reviews' && post) {
        if (pull.author.login === login) return { status: 1, stdout: '', stderr: 'Can not approve your own pull request (HTTP 422)' };
        const state = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' }[field('event')];
        pull.reviews.push({ login, state, commit: field('commit_id'), body: field('body') || '' });
        pull.reviewRequests = pull.reviewRequests.filter(r => r.login !== login);
        return ok({ state, url: `${pull.url}#review`, commit: field('commit_id'), login });
      }
      if (kind === 'pulls' && what === 'reviews') {
        assert.ok(args.includes('--paginate'));
        const jq = flag('--jq');
        return jsonLines(pull.reviews.map(r => jq.includes('who:') ? { who: r.login, state: r.state, commit: r.commit, body: r.body, url: `${pull.url}#r` }
          : { login: r.login, state: r.state, commit: r.commit }));
      }
      if (what === 'comments' && post) {
        const entry = { pr: pull.number, who: login, kind: kind === 'pulls' ? 'line' : 'general', body: field('body'), path: field('path'), line: Number(field('line')) || null,
          side: field('side'), commit: field('commit_id') };
        github.comments.push(entry);
        return ok(`${pull.url}#c${github.comments.length}\n`);
      }
      if (what === 'comments') {
        const mine = github.comments.filter(c => c.pr === pull.number && c.kind === (kind === 'pulls' ? 'line' : 'general'));
        return jsonLines(mine.map((c, i) => ({ who: c.who, body: c.body, url: `${pull.url}#c${i}`, ...(c.kind === 'line' ? { path: c.path, line: c.line, outdated: false } : {}) })));
      }
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      const head = args.includes('--head') ? flag('--head') : null;
      return ok(github.prs.filter(x => (!head || x.headRefName === head) && (flag('--state') === 'all' || x.state === 'OPEN')).map(view));
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const pull = github.prs.find(x => String(x.number) === args[2]);
      if (!pull) return { status: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 99.' };
      return ok(args.includes('state,mergeCommit') ? { state: pull.state, mergeCommit: pull.mergeCommit || null } : view(pull));
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      const number = github.prs.length + 1;
      github.prs.push({ number, url: `https://github.com/${REPO}/pull/${number}`, state: 'OPEN', isDraft: false, author: { login }, headRefName: flag('--head'),
        baseRefName: 'main', title: flag('--title'), body: flag('--body'), reviews: [], isCrossRepository: false, reviewRequests: [], statusCheckRollup: [] });
      return ok(`https://github.com/${REPO}/pull/${number}\n`);
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      const pull = github.prs.find(x => String(x.number) === args[2]);
      const server = join(root, `server-${pull.number}`);
      sh(root, 'clone', '-q', origin, server);
      sh(server, 'merge', '--squash', '-q', `origin/${pull.headRefName}`);
      sh(server, 'commit', '-q', '-m', `${pull.title} (#${pull.number})`);
      sh(server, 'push', '-q', 'origin', 'main');
      pull.state = 'MERGED';
      pull.mergeCommit = { oid: sh(server, 'rev-parse', 'HEAD') };
      return ok('');
    }
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  }
  return { root, origin, originSha, github, person };
}

// alice starts a task, changes App.tsx and opens a pull request.
function alicePr(w, { files = { 'src/App.tsx': lines(20).replace('line 5\n', 'line 5 padding 16\n') }, name = 'card padding' } = {}) {
  const alice = w.person('alice');
  start(alice.ctx(), name);
  write(alice.dir, files);
  const opened = pr(alice.ctx(), {});
  return { alice, pull: w.github.prs.find(x => x.url === opened.url) };
}

describe('team review: pure helpers', () => {
  const diff = ['diff --git a/src/App.tsx b/src/App.tsx', 'index 1..2 100644', '--- a/src/App.tsx', '+++ b/src/App.tsx', '@@ -4,3 +4,3 @@', ' line 4',
    '-line 5', '+line 5 padding 16', ' line 6', 'diff --git a/logo.png b/logo.png', 'new file mode 100644', 'Binary files /dev/null and b/logo.png differ',
    'diff --git a/a.ts b/b.ts', 'similarity index 90%', 'rename from a.ts', 'rename to b.ts'].join('\n');
  it('parses a diff into files, counts and commentable lines', () => {
    const files = parseDiff(diff);
    assert.deepEqual(files.map(f => [f.path, f.change, f.added, f.removed, f.binary]),
      [['src/App.tsx', 'changed', 1, 1, false], ['logo.png', 'new file', 0, 0, true], ['b.ts', 'renamed', 0, 0, false]]);
    assert.equal(files[2].from, 'a.ts');
    assert.ok(commentable(files, 'src/App.tsx', 5));
    assert.ok(commentable(files, 'src/App.tsx', 4), 'unchanged lines inside a hunk can be commented');
    assert.ok(commentable(files, 'src/App.tsx', 5, 'LEFT'));
    assert.ok(!commentable(files, 'src/App.tsx', 12));
    assert.ok(!commentable(files, 'other.ts', 1));
  });
  it('writes a review page whose line ids map to file and line, escaping content', () => {
    const files = parseDiff(diff.replace('+line 5 padding 16', '+<b onclick="x">'));
    const { html, map } = reviewPage({ pull: { title: 'Card <padding>', url: 'u' }, files, commits: [{ subject: 's' }], summary: 'sum' });
    assert.ok(!html.includes('<b onclick'));
    assert.ok(html.includes('id="f0-R5" data-source="src/App.tsx:5"'));
    assert.deepEqual(map['f0-R5'], { path: 'src/App.tsx', line: 5, side: 'RIGHT' });
    assert.deepEqual(map['f0-L5'], { path: 'src/App.tsx', line: 5, side: 'LEFT' });
    assert.deepEqual(sourceFromSelector('section#file-0 > div#f0-R5 > code', map), map['f0-R5']);
    assert.equal(sourceFromSelector('div#root > main > button:nth-of-type(2)', map), null);
    assert.equal(sourceFromSelector('', map), null);
  });
  it('inlines a Vite entry so it runs in the sandboxed frame', () => {
    const assets = { 'assets/a.js': 'x("</script>")', 'assets/a.css': 'p{}' };
    const out = inlineBuild('<link rel="modulepreload" href="./assets/v.js"><script type="module" crossorigin src="./assets/a.js"></script>' +
      '<link rel="stylesheet" crossorigin href="./assets/a.css"><script type="module" src="./assets/missing.js"></script>', p => assets[p] ?? null);
    assert.equal(out, '<script type="module">x("<\\/script>")</script><style>p{}</style><script type="module" src="./assets/missing.js"></script>');
  });
});

describe('team reviews and review', () => {
  it('lists what needs my review, not my own or drafts, and clears it once I review the latest version', t => {
    const w = world(t);
    const { pull } = alicePr(w);
    const bob = w.person('bob');
    const mine = reviews(bob.ctx());
    assert.deepEqual(mine.needsReview.map(n => [n.url, n.author, n.requested]), [[pull.url, '@alice', false]]);
    assert.match(mine.summary, /needs your review/);
    assert.deepEqual(reviews(w.person('alice').ctx()).needsReview, [], 'my own pull request never needs my review');
    pull.reviewRequests.push({ login: 'bob' });
    assert.equal(reviews(bob.ctx()).needsReview[0].why, 'you were asked to review');
    review(bob.ctx(), pull.number, { install: false });
    approve(bob.ctx(), pull.number);
    const after = reviews(bob.ctx());
    assert.deepEqual([after.needsReview, after.reviewed.map(r => r.yourReview)], [[], ['approved']]);
    pull.isDraft = true;
    assert.deepEqual(reviews(bob.ctx()).reviewed, [], 'drafts are not listed');
  });
  it('checks the change out in a detached, git-excluded review copy, installs without scripts and summarises it', t => {
    const w = world(t);
    const { pull } = alicePr(w, { files: { 'src/App.tsx': lines(20).replace('line 5\n', 'line 5 padding 16\n'), 'src/Card.tsx': 'export const Card = 1;\n' } });
    const bob = w.person('bob');
    const result = review(bob.ctx(), '@alice');
    assert.equal(result.dir, join(bob.dir, '.figma-cli/reviews/pr-1'));
    assert.equal(sh(result.dir, 'rev-parse', 'HEAD'), w.originSha('refs/heads/alice/card-padding'));
    assert.equal(defaultRun('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: result.dir }).status, 1, 'the review copy is detached');
    assert.deepEqual(result.files, ['changed: src/App.tsx (+1 −1)', 'new file: src/Card.tsx (+1 −0)']);
    assert.equal(result.installed, true);
    assert.ok(existsSync(join(result.dir, 'node_modules')));
    assert.match(result.summary, /@alice's "Card padding" changes 2 files \(\+2 −1 lines\)/);
    assert.equal(sh(bob.dir, 'status', '--porcelain'), '', 'the review copy is invisible to the clone\'s saves');
    assert.equal(sh(bob.dir, 'symbolic-ref', '--short', 'HEAD'), 'main', 'bob\'s own checkout is untouched');
    assert.equal(review(bob.ctx(), pull.url, { install: false }).refreshed, false);
  });
  it('updates the review copy to a newer version, refusing when it has local edits', t => {
    const w = world(t);
    const { alice, pull } = alicePr(w);
    const bob = w.person('bob');
    const first = review(bob.ctx(), pull.number, { install: false });
    write(alice.dir, { 'src/More.tsx': 'x\n' });
    save(alice.ctx());
    const second = review(bob.ctx(), pull.number, { install: false });
    assert.equal(second.refreshed, true);
    assert.equal(sh(first.dir, 'rev-parse', 'HEAD'), w.originSha('refs/heads/alice/card-padding'));
    write(alice.dir, { 'src/Even.tsx': 'y\n' });
    save(alice.ctx());
    write(first.dir, { 'src/App.tsx': 'local edit\n' });
    code(() => review(bob.ctx(), pull.number, { install: false }), 'TEAM_REVIEW_DIRTY');
    assert.equal(review(bob.ctx(), pull.number, { remove: true }).removed, true);
    assert.ok(!existsSync(first.dir));
    assert.equal(review(bob.ctx(), pull.number, { install: false }).refreshed, false);
  });
  it('refuses my own pull request, closed ones, unknown ones and ambiguous logins', t => {
    const w = world(t);
    const { alice, pull } = alicePr(w);
    code(() => review(alice.ctx(), pull.number, { install: false }), 'TEAM_SELF_REVIEW');
    const bob = w.person('bob');
    code(() => review(bob.ctx(), 99, { install: false }), 'TEAM_PR_NOT_FOUND');
    code(() => review(bob.ctx(), 'carol', { install: false }), 'TEAM_PR_NOT_FOUND');
    code(() => review(bob.ctx(), 'https://github.com/other/repo/pull/1', { install: false }), 'TEAM_PR_NOT_FOUND');
    sh(alice.dir, 'switch', '-q', 'main');
    alicePr(w, { name: 'second', files: { 'src/B.tsx': 'b\n' } });
    code(() => review(bob.ctx(), 'alice', { install: false }), 'TEAM_AMBIGUOUS');
    pull.state = 'CLOSED';
    code(() => review(bob.ctx(), pull.number, { install: false }), 'TEAM_PR_CLOSED');
  });
  it('keeps going without an install when the project cannot install', t => {
    const w = world(t);
    const { pull } = alicePr(w);
    const bob = w.person('bob');
    const result = review(bob.ctx(), pull.number, { installFn: () => { throw new Error('kit dependency'); } });
    assert.equal(result.installed, false);
    assert.match(result.warnings[0], /kit dependency/);
  });
  it('opens the change page and an inlined app build in Lavish', t => {
    const w = world(t);
    const { pull } = alicePr(w);
    const bob = w.person('bob');
    const result = review(bob.ctx(), pull.number, { lavish: true });
    const [change, app] = result.lavish.pages.map(p => p.page);
    assert.equal(result.lavish.opened, 2);
    assert.equal(change, join(result.dir, '.lavish/review/index.html'));
    assert.ok(readFileSync(change, 'utf8').includes('data-source="src/App.tsx:5"'));
    assert.equal(JSON.parse(readFileSync(join(result.dir, '.lavish/review/source-map.json'), 'utf8')).lines['f0-R5'].line, 5);
    assert.ok(readFileSync(app, 'utf8').includes('<script type="module">console.log("<\\/script>")</script>'));
    assert.ok(w.github.calls.some(c => c.command === 'lavish-axi' && c.args[0] === change));
    assert.equal(review(bob.ctx(), pull.number, { install: false }).refreshed, false, 'the Lavish files do not count as edits');
  });
  it('reuses the make start design build, and warns when the app does not build or Lavish is missing', t => {
    const w = world(t);
    const { pull } = alicePr(w);
    const broken = w.person('bob', { vite: 1, lavish: 1 });
    const result = review(broken.ctx(), pull.number, { lavish: true });
    assert.deepEqual([result.lavish.pages.length, result.lavish.opened], [1, 0]);
    assert.ok(broken.warnings.some(m => /could not be built/.test(m)) && broken.warnings.some(m => /lavish-axi is not installed/.test(m)));
    write(result.dir, { '.lavish/prototype/index.html': '<html></html>' });
    const again = review(w.person('bob').ctx(), pull.number, { lavish: true, install: false });
    assert.equal(again.lavish.pages[1].page, join(result.dir, '.lavish/prototype/index.html'));
  });
});

describe('team comment', () => {
  it('posts line comments on changed lines and general comments otherwise, quoting the target', t => {
    const w = world(t);
    const { pull } = alicePr(w);
    const bob = w.person('bob');
    const copy = review(bob.ctx(), pull.number, { lavish: true, install: false });
    const head = w.originSha('refs/heads/alice/card-padding');
    const line = comment(bob.ctx(), pull.number, { message: 'Use 12', file: 'src/App.tsx', line: 5 });
    assert.equal(line.comment.kind, 'line');
    assert.deepEqual(w.github.comments.at(-1), { pr: 1, who: 'bob', kind: 'line', body: 'Use 12', path: 'src/App.tsx', line: 5, side: 'RIGHT', commit: head });
    const mapped = comment(bob.ctx(), pull.number, { message: 'Too tight', selector: 'section#file-0 > div#f0-R5 > code' });
    assert.deepEqual([mapped.comment.kind, mapped.comment.path, mapped.comment.line], ['line', 'src/App.tsx', 5]);
    const app = comment(bob.ctx(), pull.number, { message: 'Button too small', selector: 'div#root > button', text: 'Save' });
    assert.equal(app.comment.kind, 'general');
    assert.equal(w.github.comments.at(-1).body, '> On `div#root > button` "Save":\n\nButton too small');
    const sourced = comment(bob.ctx(), pull.number, { message: 'Nice', selector: 'div#root > p', source: 'src/App.tsx:6' });
    assert.equal(sourced.comment.kind, 'line');
    const outside = comment(bob.ctx(), pull.number, { message: 'Hmm', file: 'src/App.tsx', line: 15 });
    assert.equal(outside.comment.kind, 'general');
    assert.match(outside.fallback, /not a changed line/);
    assert.match(w.github.comments.at(-1).body, /^> On `src\/App.tsx:15`:/);
    assert.equal(comment(bob.ctx(), pull.number, { message: 'Looks good overall' }).comment.kind, 'general');
    assert.equal(comment(teamContext({ dir: copy.dir, run: bob.run }), pull.number, { message: 'from the copy', file: 'src/App.tsx', line: 5 }).comment.kind, 'line');
    code(() => comment(bob.ctx(), pull.number, { message: ' ' }), 'TEAM_BAD_COMMENT');
    code(() => comment(bob.ctx(), pull.number, { message: 'x', file: 'src/App.tsx' }), 'TEAM_BAD_COMMENT');
    code(() => comment(bob.ctx(), pull.number, { message: 'x', source: 'nope' }), 'TEAM_BAD_COMMENT');
  });
});

describe('team approve and request-changes', () => {
  it('refuses self-approval and self-requested changes before calling GitHub', t => {
    const w = world(t);
    const { alice, pull } = alicePr(w);
    const before = w.github.calls.length;
    code(() => approve(alice.ctx(), pull.number), 'TEAM_SELF_REVIEW');
    code(() => requestChanges(alice.ctx(), pull.number, { message: 'x' }), 'TEAM_SELF_REVIEW');
    assert.ok(!w.github.calls.slice(before).some(c => c.args.includes('POST')));
    assert.deepEqual(pull.reviews, []);
  });
  it('approves as the reviewer\'s own login on the reviewed version, and refuses a stale review copy', t => {
    const w = world(t);
    const { alice, pull } = alicePr(w);
    const bob = w.person('bob');
    review(bob.ctx(), pull.number, { install: false });
    write(alice.dir, { 'src/Late.tsx': 'late\n' });
    save(alice.ctx());
    code(() => approve(bob.ctx(), pull.number), 'TEAM_REVIEW_OUTDATED');
    assert.deepEqual(pull.reviews, []);
    review(bob.ctx(), pull.number, { install: false });
    const result = approve(bob.ctx(), pull.number, { message: 'Ship it' });
    assert.deepEqual([result.as, result.state, result.commit], ['@bob', 'APPROVED', w.originSha('refs/heads/alice/card-padding')]);
    assert.deepEqual(pull.reviews.at(-1), { login: 'bob', state: 'APPROVED', commit: result.commit, body: 'Ship it' });
  });
  it('approves GitHub\'s head without a review copy, with a warning, and refuses drafts and closed PRs', t => {
    const w = world(t);
    const { pull } = alicePr(w);
    const bob = w.person('bob');
    pull.isDraft = true;
    code(() => approve(bob.ctx(), pull.number), 'TEAM_PR_NOT_READY');
    pull.isDraft = false;
    const result = approve(bob.ctx(), pull.number);
    assert.equal(result.reviewCopy, false);
    assert.ok(bob.warnings.some(m => /no review copy/.test(m)));
    code(() => requestChanges(bob.ctx(), pull.number, {}), 'TEAM_BAD_COMMENT');
    pull.state = 'MERGED';
    code(() => approve(bob.ctx(), pull.number), 'TEAM_PR_CLOSED');
  });
  it('never saves, syncs or pushes from the review copy', t => {
    const w = world(t);
    const { pull } = alicePr(w);
    const bob = w.person('bob');
    const { dir } = review(bob.ctx(), pull.number, { install: false });
    const before = w.originSha('refs/heads/alice/card-padding');
    const inCopy = teamContext({ dir, run: bob.run });
    write(dir, { 'src/App.tsx': 'bob was here\n' });
    code(() => save(inCopy), 'TEAM_REVIEW_COPY');
    code(() => sync(inCopy), 'TEAM_REVIEW_COPY');
    code(() => start(inCopy, 'sneaky'), 'TEAM_REVIEW_COPY');
    code(() => merge(inCopy), 'TEAM_REVIEW_COPY');
    assert.ok(!w.github.calls.some(c => c.login === 'bob' && c.command === 'git' && c.args[0] === 'push'));
    assert.equal(w.originSha('refs/heads/alice/card-padding'), before);
  });
});

describe('team feedback and address', () => {
  it('shows the author the reviews and comments, and team merge counts the reviewer\'s current approval', t => {
    const w = world(t);
    const { alice, pull } = alicePr(w);
    const bob = w.person('bob');
    review(bob.ctx(), pull.number, { install: false });
    comment(bob.ctx(), pull.number, { message: 'Use 12', file: 'src/App.tsx', line: 5 });
    requestChanges(bob.ctx(), pull.number, { message: 'Padding is off' });
    const seen = feedback(alice.ctx());
    assert.deepEqual(seen.changesRequestedBy, ['@bob']);
    assert.deepEqual(seen.feedback.map(f => [f.who, f.kind, f.where || null, f.says]),
      [['@bob', 'asked for changes', null, 'Padding is off'], ['@bob', 'line', 'src/App.tsx:5', 'Use 12']]);
    code(() => merge(alice.ctx(), { buildCheck: false }), 'TEAM_CHANGES_REQUESTED');
    sh(alice.dir, 'switch', '-q', 'main');
    code(() => address(alice.ctx()), 'TEAM_NO_PR');
    code(() => address(alice.ctx(), 'bob'), 'TEAM_PR_NOT_FOUND');
  });
  it('takes the author back to their branch with the comments as a to-do list, then save, sync and merge work', t => {
    const w = world(t);
    const { alice, pull } = alicePr(w);
    const bob = w.person('bob');
    review(bob.ctx(), pull.number, { install: false });
    comment(bob.ctx(), pull.number, { message: 'Use 12', file: 'src/App.tsx', line: 5 });
    requestChanges(bob.ctx(), pull.number, { message: 'Padding is off' });
    sh(alice.dir, 'switch', '-q', 'main');
    const result = address(alice.ctx(), pull.number);
    assert.equal(sh(alice.dir, 'symbolic-ref', '--short', 'HEAD'), 'alice/card-padding');
    assert.deepEqual(result.todo.map(t => t.says), ['Padding is off', 'Use 12']);
    assert.match(result.summary, /Switched to alice\/card-padding/);
    write(alice.dir, { 'src/App.tsx': lines(20).replace('line 5\n', 'line 5 padding 12\n') });
    save(alice.ctx(), { message: 'Address review comments' });
    sync(alice.ctx());
    code(() => merge(alice.ctx(), { buildCheck: false }), 'TEAM_CHANGES_REQUESTED');
    review(bob.ctx(), pull.number, { install: false });
    approve(bob.ctx(), pull.number);
    const merged = merge(alice.ctx(), { buildCheck: false });
    assert.deepEqual(merged.approvedBy, ['@bob']);
  });
  it('refuses to address someone else\'s pull request or with unsaved changes', t => {
    const w = world(t);
    const { alice, pull } = alicePr(w);
    const bob = w.person('bob');
    code(() => address(bob.ctx(), pull.number), 'TEAM_NOT_YOUR_BRANCH');
    sh(alice.dir, 'switch', '-q', 'main');
    write(alice.dir, { 'notes.txt': 'unsaved\n' });
    code(() => address(alice.ctx(), pull.number), 'TEAM_UNSAVED');
    code(() => feedback(alice.ctx()), 'TEAM_NO_PR');
  });
});
