import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { install } from './make-local.js';
import { count, currentBranch, fail, fetchMain, findPr, isReviewCopy, listChanges, ORIGIN_TRUNK, PR_FIELDS, readReviews, remoteBranchSha,
  requireNoOperation, requireOwnBranch, REVIEWS_DIR, revOf, reviewState, teamContext, TRUNK } from './make-team.js';

// `figma-cli team reviews|review|comment|approve|request-changes|feedback|address`:
// cross-review between designers. A reviewer looks at someone else's pull
// request in a detached review copy (a git worktree under the clone) that no
// team verb will save, sync or push from, comments, and approves or asks for
// changes through gh as themselves. Nobody approves or asks for changes on
// their own pull request. The author reads the feedback and goes back to their
// own branch to address it. Nothing here reads or writes Figma.

const REVIEW_FIELDS = `${PR_FIELDS},body`;
const LAVISH_DIR = '.lavish/review';
const DESIGN_PAGE = '.lavish/prototype/index.html';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const at = login => `@${login}`;
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

// --- finding the pull request ------------------------------------------------

// The main clone, also when a verb runs inside a review copy.
export function mainRoot(ctx) {
  const out = ctx.git(['worktree', 'list', '--porcelain'], 'Listing this clone\'s folders');
  const first = /^worktree (.+)$/m.exec(out);
  return first ? first[1] : ctx.root;
}

export const reviewCopyPath = (root, number) => join(root, REVIEWS_DIR, `pr-${number}`);

function viewPr(ctx, number) {
  const result = ctx.run('gh', ['pr', 'view', String(number), '--repo', ctx.repo(), '--json', REVIEW_FIELDS], { cwd: ctx.root });
  if (result.status !== 0 && /not found|could not resolve/i.test(result.stderr)) fail(`There is no pull request #${number} in ${ctx.repo()}.`, 'TEAM_PR_NOT_FOUND');
  if (result.status !== 0) {
    fail(`Looking up pull request #${number} failed: ${(result.stderr || 'gh failed').trim().split('\n').pop()}. Check gh auth status.`, 'TEAM_GH_FAILED');
  }
  try { return JSON.parse(result.stdout); } catch { fail('gh returned an unreadable pull request.', 'TEAM_GH_FAILED'); }
}

function openPrs(ctx) {
  const list = ctx.ghJson(['pr', 'list', '--repo', ctx.repo(), '--state', 'open', '--base', TRUNK, '--json', REVIEW_FIELDS, '--limit', '100'],
    'Listing open pull requests');
  return (Array.isArray(list) ? list : []).filter(pull => !pull.isCrossRepository);
}

// "12", "#12", a pull request URL of this repo, or a GitHub login ("bob",
// "@bob") with exactly one open pull request.
export function resolvePr(ctx, ref) {
  const text = String(ref ?? '').trim();
  if (!text) fail('Say which pull request: its number, its link, or the person\'s GitHub login.', 'TEAM_PR_NOT_FOUND');
  const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(text);
  if (url && !same(url[1], ctx.repo())) fail(`${text} belongs to ${url[1]}, not this project (${ctx.repo()}).`, 'TEAM_PR_NOT_FOUND');
  const number = url?.[2] || /^#?(\d+)$/.exec(text)?.[1];
  if (number) return viewPr(ctx, number);
  const login = text.replace(/^@/, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) fail(`"${text}" is not a pull request number, link or GitHub login.`, 'TEAM_PR_NOT_FOUND');
  const theirs = openPrs(ctx).filter(pull => same(pull.author?.login, login));
  if (!theirs.length) fail(`${at(login)} has no open pull request into ${TRUNK} in ${ctx.repo()}.`, 'TEAM_PR_NOT_FOUND');
  if (theirs.length > 1) {
    fail(`${at(login)} has ${theirs.length} open pull requests: ${theirs.map(p => `${p.url} (${p.title})`).join('; ')}. Say which one.`, 'TEAM_AMBIGUOUS',
      { choices: theirs.map(p => ({ url: p.url, title: p.title })) });
  }
  return theirs[0];
}

function requireReviewable(ctx, pull, { what = 'review' } = {}) {
  if (pull.state !== 'OPEN') fail(`${pull.url} is ${String(pull.state).toLowerCase()}, so there is nothing to ${what}.`, 'TEAM_PR_CLOSED', { url: pull.url });
  if (pull.isCrossRepository) fail(`${pull.url} comes from a fork; figma-cli reviews only pull requests from branches in ${ctx.repo()}.`, 'TEAM_PR_NOT_READY');
  if (pull.baseRefName !== TRUNK) fail(`${pull.url} targets ${pull.baseRefName}, not ${TRUNK}.`, 'TEAM_PR_NOT_READY');
}

function requireNotAuthor(ctx, pull, what) {
  const login = ctx.login();
  if (same(pull.author?.login, login)) {
    fail(`${pull.url} is your own pull request, so you cannot ${what} it; someone else has to. ` +
      'Say "show my review feedback" to see what reviewers said.', 'TEAM_SELF_REVIEW', { url: pull.url });
  }
  return login;
}

// The PR head, fetched as the remote-tracking ref of its branch; it must be
// the commit GitHub reports, so the review is of exactly that version.
function fetchHead(ctx, pull) {
  const tracking = `refs/remotes/origin/${pull.headRefName}`;
  ctx.git(['fetch', '--quiet', 'origin', `+refs/heads/${pull.headRefName}:${tracking}`], `Getting ${at(pull.author?.login)}'s changes from GitHub`);
  const sha = revOf(ctx, tracking);
  if (sha !== pull.headRefOid) fail(`${pull.url} changed while it was being fetched. Ask again.`, 'TEAM_OUT_OF_DATE', { url: pull.url });
  return sha;
}

// --- the change in plain words ---------------------------------------------

const unquote = path => path.startsWith('"') ? JSON.parse(path) : path;

// git diff → [{ path, from?, change, binary, added, removed, hunks: [{ header, lines: [{ kind, old, new, text }] }] }]
export function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { path: null, change: 'changed', binary: false, added: 0, removed: 0, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('new file mode')) file.change = 'new file';
      else if (line.startsWith('deleted file mode')) file.change = 'deleted';
      else if (line.startsWith('rename from ')) { file.from = unquote(line.slice(12)); file.change = 'renamed'; }
      else if (line.startsWith('rename to ')) file.path = unquote(line.slice(10));
      else if (line.startsWith('--- ') && line !== '--- /dev/null') file.path ??= unquote(line.slice(4)).replace(/^a\//, '');
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = unquote(line.slice(4)).replace(/^b\//, '');
      else if (line.startsWith('Binary files ')) {
        file.binary = true;
        file.path ??= unquote(/ and (?:b\/)?(.+?) differ$/.exec(line)?.[1] || '');
        if (file.path === '/dev/null') file.path = unquote(/^Binary files (?:a\/)?(.+?) and /.exec(line)?.[1] || '');
      }
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+')) { hunk.lines.push({ kind: '+', new: newLine++, text: line.slice(1) }); file.added++; }
    else if (line.startsWith('-')) { hunk.lines.push({ kind: '-', old: oldLine++, text: line.slice(1) }); file.removed++; }
    else if (line.startsWith(' ')) hunk.lines.push({ kind: ' ', old: oldLine++, new: newLine++, text: line.slice(1) });
  }
  return files.filter(f => f.path);
}

function readDiff(ctx, base, head) {
  return parseDiff(ctx.git(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', `${base}...${head}`], 'Comparing the change with main'));
}

// The lines GitHub accepts a line comment on: every line shown in the diff,
// on the new side (added or unchanged) or the old side (removed).
export function commentable(files, path, line, side = 'RIGHT') {
  const file = files.find(f => f.path === path);
  return !!file?.hunks.some(h => h.lines.some(l => side === 'LEFT' ? l.kind === '-' && l.old === line : l.kind !== '-' && l.new === line));
}

const describeFile = f => `${f.change === 'renamed' ? `renamed ${f.from} → ${f.path}` : `${f.change}: ${f.path}`}` +
  (f.binary ? ' (binary)' : ` (+${f.added} −${f.removed})`);

export function changeSummary(pull, files, commits) {
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return `${at(pull.author?.login)}'s "${pull.title}" changes ${plural(files.length, 'file')} (+${added} −${removed} lines) in ${plural(commits.length, 'save')}: ` +
    `${files.slice(0, 6).map(f => f.path).join(', ')}${files.length > 6 ? `, and ${files.length - 6} more` : ''}.`;
}

// --- the Lavish review page ------------------------------------------------

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// One page: the summary, then every diff line as an element with an id and a
// data-source. Lavish's CSS locator stops at the nearest id, so a note on a
// line names exactly one entry of the source map.
export function reviewPage({ pull, files, commits, summary }) {
  const map = {};
  const body = files.map((file, index) => {
    const lines = file.binary ? '<p class="bin">Binary file; open the app to see it.</p>' : file.hunks.map(hunk =>
      `<div class="hunk">${escapeHtml(hunk.header)}</div>` + hunk.lines.map(line => {
        const side = line.kind === '-' ? 'LEFT' : 'RIGHT';
        const number = side === 'LEFT' ? line.old : line.new;
        const id = `f${index}-${side === 'LEFT' ? 'L' : 'R'}${number}`;
        map[id] = { path: file.path, line: number, side };
        const kind = line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : 'ctx';
        return `<div class="ln ${kind}" id="${id}" data-source="${escapeHtml(`${file.path}:${number}`)}"><span class="no">${number}</span>` +
          `<span class="mk">${line.kind === ' ' ? '' : escapeHtml(line.kind)}</span><code>${escapeHtml(line.text) || ' '}</code></div>`;
      }).join('')).join('');
    return `<section id="file-${index}"><h2>${escapeHtml(describeFile(file))}</h2>${lines}</section>`;
  }).join('\n');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review: ${escapeHtml(pull.title)}</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --fg: #1f2328; --muted: #59636e; --add: #dafbe1; --del: #ffebe9; --line: #d1d9e0; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --add: #12261e; --del: #25171c; --line: #30363d; } }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
header p { color: var(--muted); max-width: 70ch; }
section { margin: 24px 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
h2 { margin: 0; padding: 8px 12px; font-size: 14px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.hunk { padding: 4px 12px; color: var(--muted); font: 12px ui-monospace, monospace; border-bottom: 1px solid var(--line); }
.ln { display: grid; grid-template-columns: 4em 1.5em minmax(0, 1fr); font: 12px/1.6 ui-monospace, monospace; }
.ln code { white-space: pre-wrap; overflow-wrap: anywhere; }
.no { color: var(--muted); text-align: right; padding-right: 8px; user-select: none; }
.mk { text-align: center; user-select: none; }
.add { background: var(--add); } .del { background: var(--del); }
.bin { padding: 8px 12px; color: var(--muted); }
</style></head>
<body><header><h1>${escapeHtml(pull.title)}</h1>
<p>${escapeHtml(summary)}</p>
<p>${escapeHtml(pull.url)} · saves: ${commits.map(c => escapeHtml(c.subject)).join(' · ')}</p>
<p>Click a line and leave a note: it becomes a comment on that line of the pull request.</p></header>
${body}
</body></html>
`;
  return { html, map };
}

// The selector's last #id that the source map knows, else null.
export function sourceFromSelector(selector, map = {}) {
  const ids = [...String(selector || '').matchAll(/#((?:\\.|[A-Za-z0-9_-])+)/g)].map(m => m[1].replace(/\\(.)/g, '$1'));
  for (const id of ids.reverse()) if (map[id]) return map[id];
  return null;
}

// Vite's index.html with its entry script and stylesheets inlined, so it runs
// in Lavish's sandboxed (opaque-origin) frame, which blocks module and
// crossorigin loads from the page's folder. Images still load from assets/.
export function inlineBuild(html, readAsset) {
  return html
    .replace(/<link\s+rel="modulepreload"[^>]*>\s*/g, '')
    .replace(/<script\s+type="module"[^>]*\ssrc="\.?\/?([^"]+)"[^>]*><\/script>/g, (whole, src) => {
      const code = readAsset(src);
      return code == null ? whole : `<script type="module">${code.replace(/<\/script/gi, '<\\/script')}</script>`;
    })
    .replace(/<link\s+rel="stylesheet"[^>]*\shref="\.?\/?([^"]+)"[^>]*>/g, (whole, href) => {
      const css = readAsset(href);
      return css == null ? whole : `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`;
    });
}

function hasVite(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return !!(pkg.dependencies?.vite || pkg.devDependencies?.vite);
  } catch { return false; }
}

// The app page: the make start design build when the review copy has one
// (static HTML; Lavish runs it sandboxed). Only when asked (--app), a
// relative-base Vite build with its entry inlined: that runs the pull
// request's own build config on this computer, like make dev does.
function appPage(ctx, dir, { build = false } = {}) {
  const design = join(dir, DESIGN_PAGE);
  if (existsSync(design)) return { page: design, how: 'the make start design build' };
  if (!build) return null;
  if (!hasVite(dir) || !existsSync(join(dir, 'node_modules'))) { ctx.warn('The app was not built for Lavish: it needs Vite and an install.'); return null; }
  const out = join(dir, LAVISH_DIR, 'app');
  const built = ctx.run('pnpm', ['exec', 'vite', 'build', '--base', './', '--outDir', out, '--emptyOutDir'], { cwd: dir });
  if (built.status !== 0) { ctx.warn(`The app could not be built for Lavish, so only the change page opens: ${(built.stderr || built.stdout).trim().split('\n').pop()}`); return null; }
  const index = join(out, 'index.html');
  if (!existsSync(index)) return null;
  const read = path => { try { return readFileSync(join(out, path), 'utf8'); } catch { return null; } };
  writeFileSync(index, inlineBuild(readFileSync(index, 'utf8'), read));
  return { page: index, how: 'a Vite build of the app' };
}

function openLavish(ctx, page) {
  const result = ctx.run('lavish-axi', [page], { cwd: dirname(page) });
  if (result.status === 127) { ctx.warn(`lavish-axi is not installed; open ${page} in a browser instead.`); return false; }
  if (result.status !== 0) { ctx.warn(`lavish-axi could not open ${page}: ${(result.stderr || result.stdout).trim().split('\n').pop()}`); return false; }
  return true;
}

// --- reviewer verbs ----------------------------------------------------------

// What needs my review: open pull requests into main by someone else, not
// drafts, where I am asked to review or have not reviewed the latest version.
// My own open pull requests are listed apart, with who they wait on.
export function reviews(ctx) {
  const login = ctx.login();
  const needs = [];
  const done = [];
  const yours = [];
  for (const pull of openPrs(ctx)) {
    if (same(pull.author?.login, login)) {
      const state = reviewState({ author: login, head: pull.headRefOid, reviews: readReviews(ctx, pull.number), requests: pull.reviewRequests || [] });
      yours.push({ url: pull.url, title: pull.title, draft: !!pull.isDraft, approvedBy: state.approvedBy.map(r => at(r.who)),
        changesRequestedBy: state.changesRequestedBy.map(r => at(r.who)), waitingOn: state.waitingOn.map(at) });
      continue;
    }
    if (pull.isDraft) continue;
    const mine = readReviews(ctx, pull.number).filter(r => same(r.login, login));
    const last = mine[mine.length - 1] || null;
    const requested = (pull.reviewRequests || []).some(r => same(r.login, login));
    const entry = { url: pull.url, title: pull.title, author: at(pull.author?.login), requested };
    const current = last && last.commit === pull.headRefOid;
    if (requested || !current) {
      needs.push({ ...entry, why: requested ? 'you were asked to review' : last ? 'it changed since you last reviewed it' : 'nobody asked you, and you have not reviewed it yet' });
    } else {
      done.push({ ...entry, yourReview: { APPROVED: 'approved', CHANGES_REQUESTED: 'asked for changes', COMMENTED: 'commented' }[last.state] || last.state.toLowerCase() });
    }
  }
  needs.sort((a, b) => Number(b.requested) - Number(a.requested));
  return { verb: 'reviews', login: at(login), needsReview: needs, reviewed: done, yours,
    summary: (needs.length ? `${plural(needs.length, 'pull request')} ${needs.length === 1 ? 'needs' : 'need'} your review: ` +
      `${needs.map(n => `${n.author}'s "${n.title}" (${n.url})`).join('; ')}.` : 'Nothing needs your review right now.') +
      (yours.length ? ` Your own open pull request${yours.length === 1 ? '' : 's'}, which someone else must review: ${yours.map(y => y.url).join(', ')}.` : '') };
}

// Review: fetch the pull request's head into a detached review copy under
// the clone, install without running scripts, and describe the change.
export function review(ctx, ref, { install: doInstall = true, lavish = false, app = false, remove = false, installFn = install } = {}) {
  const root = mainRoot(ctx);
  const pull = resolvePr(ctx, ref);
  const dir = reviewCopyPath(root, pull.number);
  if (remove) {
    if (!existsSync(dir)) return { verb: 'review', url: pull.url, removed: false, summary: `There is no review copy of ${pull.url} to remove.` };
    ctx.git(['-C', root, 'worktree', 'remove', '--force', dir], 'Removing the review copy');
    return { verb: 'review', url: pull.url, removed: true, dir, summary: `Removed the review copy of ${pull.url}.` };
  }
  requireReviewable(ctx, pull);
  const own = same(pull.author?.login, ctx.login());
  const base = fetchMain(ctx);
  const head = fetchHead(ctx, pull);
  excludeReviews(ctx, root);
  let refreshed = false;
  if (existsSync(dir)) {
    const copy = teamContext({ dir, run: ctx.run, warn: ctx.warn });
    const edits = listChanges(copy).filter(c => !c.path.startsWith('.lavish/'));
    const was = revOf(copy, 'HEAD');
    if (was !== head) {
      if (edits.length) {
        fail(`The review copy of ${pull.url} has local edits (${edits.map(c => c.path).join(', ')}), so it was not updated to the latest version. ` +
          'Remove it with --remove and review again.', 'TEAM_REVIEW_DIRTY', { url: pull.url });
      }
      ctx.git(['-C', dir, 'checkout', '--quiet', '--detach', head], 'Updating the review copy');
      refreshed = true;
    }
  } else {
    mkdirSync(dirname(dir), { recursive: true });
    ctx.git(['-C', root, 'worktree', 'add', '--quiet', '--detach', dir, head], 'Making the review copy');
  }
  const mergeBase = ctx.git(['merge-base', base, head], 'Finding where the change left main');
  const files = readDiff(ctx, mergeBase, head);
  const commits = ctx.git(['log', '--reverse', '--format=%H%x09%s', `${mergeBase}..${head}`]).split('\n').filter(Boolean)
    .map(row => ({ sha: row.slice(0, 40), subject: row.slice(41) }));
  const summary = changeSummary(pull, files, commits);
  const warnings = [];
  let installed = null;
  if (doInstall && existsSync(join(dir, 'package.json'))) {
    try { installFn(dir, { run: ctx.run, ignorePnpmfile: true, warn: message => { warnings.push(message); ctx.warn(message); } }); installed = true; }
    catch (error) { installed = false; warnings.push(`Not installed, so the app cannot run yet: ${error.message}`); ctx.warn(warnings[warnings.length - 1]); }
  }
  if (own) warnings.push('This is your own pull request: you can look at it here, but someone else has to approve it.');
  const result = { verb: 'review', url: pull.url, title: pull.title, author: at(pull.author?.login), ...(own ? { own: true } : {}), head, dir, refreshed,
    files: files.map(describeFile), saves: commits.map(c => c.subject), ...(installed == null ? {} : { installed }),
    run: `figma-cli make dev --dir ${JSON.stringify(dir)}` };
  if (lavish || app) {
    const { html, map } = reviewPage({ pull, files, commits, summary });
    const pageDir = join(dir, LAVISH_DIR);
    mkdirSync(pageDir, { recursive: true });
    const page = join(pageDir, 'index.html');
    writeFileSync(page, html);
    writeFileSync(join(pageDir, 'source-map.json'), `${JSON.stringify({ url: pull.url, head, lines: map }, null, 2)}\n`);
    const built = appPage(ctx, dir, { build: app });
    const pages = [{ page, shows: 'the change, line by line' }, ...(built ? [{ page: built.page, shows: `the app (${built.how})` }] : [])];
    const opened = pages.filter(p => openLavish(ctx, p.page));
    result.lavish = { pages, opened: opened.length, poll: pages.map(p => `lavish-axi poll ${JSON.stringify(p.page)}`) };
  }
  if (warnings.length) result.warnings = warnings;
  result.summary = `${summary} Review copy: ${relative(root, dir)}${refreshed ? ' (updated to the latest version)' : ''}.` +
    (installed === false ? ' It is not installed, so the app cannot run yet.' : '') +
    (result.lavish ? ` Opened ${plural(result.lavish.opened, 'page')} in Lavish.` : '');
  return result;
}

// The review copies stay out of the clone's own saves.
function excludeReviews(ctx, root) {
  const path = resolve(root, ctx.git(['-C', root, 'rev-parse', '--git-path', 'info/exclude']));
  const line = `/${REVIEWS_DIR}/`;
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (text.split('\n').includes(line)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
}

// The commit the reviewer actually looked at: their review copy's, when they
// have one, else GitHub's head.
function reviewedCommit(ctx, pull) {
  const dir = isReviewCopy(ctx.root) && ctx.root.endsWith(`pr-${pull.number}`) ? ctx.root : reviewCopyPath(mainRoot(ctx), pull.number);
  if (!existsSync(dir)) return { sha: pull.headRefOid, copy: false };
  return { sha: ctx.git(['-C', dir, 'rev-parse', 'HEAD'], 'Reading the review copy'), copy: true };
}

// The review page's source map, only when it was made for the commit the
// comment goes on: an older page's lines may point elsewhere now.
function reviewMap(ctx, pull, sha) {
  const file = join(reviewCopyPath(mainRoot(ctx), pull.number), LAVISH_DIR, 'source-map.json');
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    return saved.head === sha ? saved.lines || {} : {};
  } catch { return {}; }
}

const quote = text => String(text).split('\n').map(line => `> ${line}`).join('\n');

// Comment: on a changed line when the target is one (by --file/--line, a
// Lavish locator from the review page, or a data-source the agent read),
// otherwise as a general comment that quotes the target.
export function comment(ctx, ref, { message, file, line, side = 'RIGHT', selector, source, text } = {}) {
  if (typeof message !== 'string' || !message.trim()) fail('Say what the comment should say (-m "…").', 'TEAM_BAD_COMMENT');
  const pull = resolvePr(ctx, ref);
  requireReviewable(ctx, pull, { what: 'comment on' });
  let target = null;
  let commit = null;
  if (file || line != null) {
    if (!file || !Number.isInteger(Number(line)) || Number(line) < 1) fail('A line comment needs both --file and a --line number.', 'TEAM_BAD_COMMENT');
    target = { path: String(file).replace(/^\.?\//, ''), line: Number(line), side: side === 'LEFT' ? 'LEFT' : 'RIGHT', from: 'file and line' };
  } else if (selector) {
    commit = reviewedCommit(ctx, pull).sha;
    const mapped = sourceFromSelector(selector, reviewMap(ctx, pull, commit));
    if (mapped) target = { ...mapped, from: 'the Lavish review page' };
  }
  if (!target && source) {
    const match = /^(.+?):(\d+)$/.exec(String(source).trim());
    if (!match) fail(`--source must look like src/App.tsx:12, not ${JSON.stringify(source)}.`, 'TEAM_BAD_COMMENT');
    target = { path: match[1].replace(/^\.?\//, ''), line: Number(match[2]), side: 'RIGHT', from: 'the element\'s data-source' };
  }
  const login = ctx.login();
  const body = message.trim();
  if (target && !commit) commit = reviewedCommit(ctx, pull).sha;
  let posted = null;
  let fallback = null;
  if (target) {
    fetchMain(ctx);
    fetchHead(ctx, pull);
    const files = readDiff(ctx, ctx.git(['merge-base', ORIGIN_TRUNK, commit], 'Finding where the change left main'), commit);
    if (!commentable(files, target.path, target.line, target.side)) fallback = `${target.path}:${target.line} is not a changed line of this pull request`;
    else {
      const result = ctx.run('gh', ['api', '--method', 'POST', `repos/${ctx.repo()}/pulls/${pull.number}/comments`, '-f', `body=${body}`,
        '-f', `commit_id=${commit}`, '-f', `path=${target.path}`, '-F', `line=${target.line}`, '-f', `side=${target.side}`, '--jq', '.html_url'], { cwd: ctx.root });
      if (result.status === 0) posted = { kind: 'line', url: result.stdout.trim(), path: target.path, line: target.line, side: target.side };
      else fallback = `GitHub would not attach it to ${target.path}:${target.line} (${(result.stderr || '').trim().split('\n').pop()})`;
    }
  }
  if (!posted) {
    const where = target ? `${target.path}:${target.line}` : selector || null;
    const about = [where && `On \`${where}\``, target && selector && `(\`${selector}\`)`, text && `"${short(text)}"`].filter(Boolean).join(' ');
    const full = about ? `${quote(`${about}:`)}\n\n${body}` : body;
    const url = ctx.gh(['api', '--method', 'POST', `repos/${ctx.repo()}/issues/${pull.number}/comments`, '-f', `body=${full}`, '--jq', '.html_url'], 'Posting the comment');
    posted = { kind: 'general', url, ...(where ? { quoted: where } : {}) };
  }
  if (fallback) ctx.warn(`${fallback}, so it was posted as a general comment that quotes it.`);
  return { verb: 'comment', url: pull.url, as: at(login), comment: posted, ...(fallback ? { fallback } : {}),
    summary: posted.kind === 'line' ? `Commented on ${posted.path} line ${posted.line} of ${pull.url} as ${at(login)}.`
      : `Commented on ${pull.url} as ${at(login)}${posted.quoted ? `, quoting ${posted.quoted}` : ''}.` };
}

// Approve or ask for changes, as the caller's own gh login, on the commit
// they reviewed. Never on their own pull request, never on an older version
// than GitHub has (team merge counts only approvals of the current head).
function decide(ctx, ref, event, { message } = {}) {
  const pull = resolvePr(ctx, ref);
  const what = event === 'APPROVE' ? 'approve' : 'ask for changes on';
  requireReviewable(ctx, pull, { what });
  const login = requireNotAuthor(ctx, pull, what);
  if (pull.isDraft && event === 'APPROVE') fail(`${pull.url} is still a draft; it can be approved once its author marks it ready.`, 'TEAM_PR_NOT_READY');
  if (event === 'REQUEST_CHANGES' && !(typeof message === 'string' && message.trim())) fail('Say what should change (-m "…").', 'TEAM_BAD_COMMENT');
  const reviewed = reviewedCommit(ctx, pull);
  if (reviewed.sha !== pull.headRefOid) {
    fail(`${at(pull.author?.login)} saved newer changes to ${pull.url} after your review copy was made, so nothing was recorded. ` +
      `Say "review ${pull.number}" again to look at the latest version first.`, 'TEAM_REVIEW_OUTDATED', { url: pull.url });
  }
  const args = ['api', '--method', 'POST', `repos/${ctx.repo()}/pulls/${pull.number}/reviews`, '-f', `event=${event}`, '-f', `commit_id=${reviewed.sha}`];
  if (message && message.trim()) args.push('-f', `body=${message.trim()}`);
  const out = ctx.ghJson([...args, '--jq', '{state: .state, url: .html_url, commit: .commit_id, login: .user.login}'],
    event === 'APPROVE' ? 'Approving the pull request' : 'Asking for changes');
  if (out?.login && !same(out.login, login)) ctx.warn(`GitHub recorded the review as @${out.login}, not ${at(login)}.`);
  const result = { verb: event === 'APPROVE' ? 'approve' : 'request-changes', url: pull.url, as: at(out?.login || login), state: out?.state || null,
    commit: out?.commit || reviewed.sha, reviewUrl: out?.url || null, reviewCopy: reviewed.copy };
  if (!reviewed.copy) ctx.warn('There was no review copy, so this was recorded on GitHub\'s latest version without running it here. Say "review" first to see it run.');
  result.summary = event === 'APPROVE'
    ? `Approved ${pull.url} as ${result.as} (version ${result.commit.slice(0, 7)}). ${at(pull.author?.login)} can now merge it; a newer save would need a fresh look.`
    : `Asked ${at(pull.author?.login)} for changes on ${pull.url} as ${result.as}. They will see it with "show my review feedback".`;
  return result;
}

export const approve = (ctx, ref, options) => decide(ctx, ref, 'APPROVE', options);
export const requestChanges = (ctx, ref, options) => decide(ctx, ref, 'REQUEST_CHANGES', options);

// --- author verbs ------------------------------------------------------------

function ownPr(ctx, ref) {
  if (ref != null && String(ref).trim()) return resolvePr(ctx, ref);
  const branch = currentBranch(ctx);
  if (!branch || branch === TRUNK) fail(`Say which pull request, or run this on your task branch.`, 'TEAM_NO_PR');
  const pull = findPr(ctx, branch);
  if (!pull) fail(`${branch} has no open pull request. Say "I'm ready for review" first.`, 'TEAM_NO_PR');
  return pull;
}

function readFeedback(ctx, pull) {
  const lines = (args, what) => ctx.gh(args, what).split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { fail('gh returned unreadable comments.', 'TEAM_GH_FAILED'); }
  });
  const reviewList = lines(['api', '--paginate', `repos/${ctx.repo()}/pulls/${pull.number}/reviews`, '--jq',
    '.[] | {who: .user.login, state: .state, commit: .commit_id, body: .body, url: .html_url}'], 'Reading the reviews');
  const lineComments = lines(['api', '--paginate', `repos/${ctx.repo()}/pulls/${pull.number}/comments`, '--jq',
    '.[] | {who: .user.login, path: .path, line: (.line // .original_line), outdated: (.line == null), body: .body, url: .html_url}'], 'Reading the line comments');
  const general = lines(['api', '--paginate', `repos/${ctx.repo()}/issues/${pull.number}/comments`, '--jq',
    '.[] | {who: .user.login, body: .body, url: .html_url}'], 'Reading the comments');
  const state = reviewState({ author: pull.author?.login, head: pull.headRefOid, reviews: reviewList.map(r => ({ login: r.who, state: r.state, commit: r.commit })) });
  return { reviewList, lineComments, general, state };
}

const short = text => String(text || '').trim().replace(/\s+/g, ' ').slice(0, 300);

function feedbackOf(ctx, pull) {
  const author = pull.author?.login;
  const { reviewList, lineComments, general, state } = readFeedback(ctx, pull);
  const items = [
    ...reviewList.filter(r => short(r.body) && !same(r.who, author)).map(r => ({ who: at(r.who), kind: { APPROVED: 'approved', CHANGES_REQUESTED: 'asked for changes', COMMENTED: 'review' }[r.state] || r.state.toLowerCase(),
      says: short(r.body), ...(r.commit !== pull.headRefOid ? { earlierVersion: true } : {}), url: r.url })),
    ...lineComments.filter(c => !same(c.who, author)).map(c => ({ who: at(c.who), kind: 'line', where: `${c.path}:${c.line}`, ...(c.outdated ? { outdated: true } : {}), says: short(c.body), url: c.url })),
    ...general.filter(c => !same(c.who, author)).map(c => ({ who: at(c.who), kind: 'comment', says: short(c.body), url: c.url })),
  ];
  return { items, state };
}

// Feedback: what reviewers said on the caller's pull request.
export function feedback(ctx, ref) {
  const pull = ownPr(ctx, ref);
  const { items, state } = feedbackOf(ctx, pull);
  const asked = state.changesRequestedBy.map(r => at(r.who));
  const approved = state.approvedBy.map(r => at(r.who));
  return { verb: 'feedback', url: pull.url, approvedBy: approved, changesRequestedBy: asked, ...(state.staleApprovals.length ? { approvedEarlierVersionBy: state.staleApprovals.map(r => at(r.who)) } : {}),
    feedback: items,
    summary: [`${pull.url}:`, approved.length ? `approved by ${approved.join(', ')}.` : 'not approved yet.', asked.length ? `${asked.join(', ')} asked for changes.` : null,
      items.length ? `${plural(items.length, 'comment')} from reviewers.` : 'No comments from reviewers yet.'].filter(Boolean).join(' ') };
}

// Address: back on the caller's own branch (fast-forwarded to GitHub's copy
// when that is simply newer), with the reviewers' comments as a to-do list.
// The person's agent makes the changes, then team save and team sync.
export function address(ctx, ref) {
  requireNoOperation(ctx);
  const pull = ownPr(ctx, ref);
  requireReviewable(ctx, pull, { what: 'address' });
  const branch = requireOwnBranch(ctx, pull.headRefName);
  const current = currentBranch(ctx);
  const notes = [];
  const tracking = `refs/remotes/origin/${branch}`;
  if (remoteBranchSha(ctx, branch)) ctx.git(['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${tracking}`], 'Getting your branch from GitHub');
  const remote = revOf(ctx, tracking);
  if (current !== branch) {
    const unsaved = listChanges(ctx);
    if (unsaved.length) fail(`You have ${plural(unsaved.length, 'unsaved file')} on ${current || 'a detached HEAD'}. Say "save my progress" first.`, 'TEAM_UNSAVED',
      { files: unsaved.map(c => c.path) });
    const switched = revOf(ctx, `refs/heads/${branch}`)
      ? ctx.tryGit(['switch', '--quiet', branch])
      : remote ? ctx.tryGit(['switch', '--quiet', '--no-track', '-c', branch, remote]) : { status: 1, stderr: `${branch} is not on GitHub` };
    if (switched.status !== 0) fail(`Could not go back to ${branch}: ${(switched.stderr || '').trim().split('\n').pop()}. Nothing was changed.`, 'TEAM_SWITCH_FAILED');
    notes.push(`Switched to ${branch}.`);
  }
  if (remote && revOf(ctx, 'HEAD') !== remote) {
    const behind = count(ctx, `HEAD..${remote}`);
    const ahead = count(ctx, `${remote}..HEAD`);
    if (behind && !ahead && !listChanges(ctx).length) { ctx.git(['merge', '--ff-only', '--quiet', remote], 'Bringing in your newer saves'); notes.push('Brought in your newer saves from GitHub.'); }
    else if (behind) notes.push('GitHub has saves this computer lacks; say "get the latest" before saving.');
  }
  const { items, state } = feedbackOf(ctx, pull);
  const todo = items.filter(item => item.kind !== 'approved');
  return { verb: 'address', url: pull.url, branch, todo, changesRequestedBy: state.changesRequestedBy.map(r => at(r.who)),
    next: ['Make each change in the to-do list', 'figma-cli team save -m "Address review comments"', 'figma-cli team sync', 'Ask the reviewers to look again'],
    summary: `${(notes.length ? notes : [`On ${branch}.`]).join(' ')} ${todo.length ? `${plural(todo.length, 'comment')} to work through from ${[...new Set(todo.map(t => t.who))].join(', ')}.`
      : 'No reviewer comments to work through.'} When done, save and get the latest, then ask for another look.` };
}
