import { resolve } from 'node:path';
import { program } from '../lib/cli-core.js';
import { conflicts, merge, pr, save, start, status, sync, TEAM_CODES, teamContext } from '../make-team.js';
import { address, approve, comment, feedback, requestChanges, review, reviews } from '../make-team-review.js';

// The plain-language git layer for a team-mode project's local clone. Each
// verb is deterministic: an agent picks the verb from the person's words and
// explains the JSON result; it never runs git itself. GitHub only, through the
// person's own git and gh logins; nothing here reads or writes Figma.
const team = program.command('team')
  .description('Plain-language git for a team-mode Make project clone: start, save, sync, conflicts, pr, merge, status, and cross-review')
  .addHelpText('after', '\nRun inside the project clone (or pass --dir). Work happens only on your own <gh-login>/<task> branch.' +
    '\nNever pushes to or force-pushes main; merges only your own pull request into main, after an approval' +
    '\nfrom someone other than its author. Reviewers look at a pull request in a detached review copy, never on the' +
    '\nauthor\'s branch, and approve or ask for changes as themselves; nobody approves their own.' +
    '\nResults are JSON with a plain-language "summary".');

const report = value => console.log(JSON.stringify(value, null, 2));
const warn = message => console.error(`warning: ${message}`);
function failure(error) {
  console.error(JSON.stringify({ error: error.message,
    ...(TEAM_CODES.includes(error.code) ? { code: error.code } : {}),
    ...(error.files ? { files: error.files } : {}),
    ...(error.secrets ? { secrets: error.secrets } : {}),
    ...(error.large ? { large: error.large } : {}),
    ...(error.conflicts ? { conflicts: error.conflicts, untouched: error.untouched } : {}),
    ...(error.url ? { url: error.url } : {}),
    ...(error.choices ? { choices: error.choices } : {}) }, null, 2));
  process.exitCode = 1;
}
const verb = (command, fn) => command.option('--dir <path>', 'The project clone (default: current folder)')
  .action((...args) => {
    const options = args[args.length - 2];
    try { report(fn(teamContext({ dir: resolve(options.dir || '.'), warn }), ...args.slice(0, -2), options)); }
    catch (error) { failure(error); }
  });

verb(team.command('start <name>').description('Start a task: a fresh <gh-login>/<slug> branch from the latest main, pushed to GitHub')
  .option('--save-first', 'Save unsaved changes before starting (on main they move onto the new branch)'),
(ctx, name, options) => start(ctx, name, { saveFirst: options.saveFirst === true }));

verb(team.command('save').description('Save my progress: format and build when the project has those scripts, block secrets, commit and push your branch')
  .option('-m, --message <text>', 'Commit message (default: generated from the changed files)'),
(ctx, options) => save(ctx, { message: options.message }));

verb(team.command('sync').description('Get the latest: commit, bring in newer saves of your branch and GitHub main (rebase), then push your branch with --force-with-lease')
  .option('-m, --message <text>', 'Commit message for any unsaved changes'),
(ctx, options) => sync(ctx, { message: options.message }));

verb(team.command('conflicts').description('Fix the conflict: auto-resolve only pnpm-lock.yaml and identical changes; otherwise undo and name who else changed each file. Never finishes a rebase it did not start'),
  ctx => conflicts(ctx));

verb(team.command('pr').description('Ready for review: sync, save, then open (or reuse) a pull request into main and request reviews from the areas map')
  .option('--title <text>', 'Pull request title (default: the task name)')
  .option('-m, --message <text>', 'Commit message for any unsaved changes'),
(ctx, options) => pr(ctx, { title: options.title, message: options.message }));

verb(team.command('merge').description('Merge it: squash-merge your own approved pull request into main after a green build, delete the branch, return to main')
  .option('--no-build-check', 'Merge even when the pull request has no GitHub checks and the project has no build script'),
(ctx, options) => merge(ctx, { buildCheck: options.buildCheck !== false }));

verb(team.command('status').description('What\'s going on: branch, unsaved files, pull request and review state, and how far behind main')
  .option('--no-fetch', 'Do not fetch main from GitHub first'),
(ctx, options) => status(ctx, { fetch: options.fetch !== false }));

// Cross-review. A <pr> is its number, its link, or the author's GitHub login.
verb(team.command('reviews').description('What needs my review: open pull requests by others where you are asked, or have not reviewed the latest version'),
  ctx => reviews(ctx));

verb(team.command('review <pr>').description('Review a teammate\'s change: a detached review copy under .figma-cli/reviews/, installed without scripts, with a plain summary')
  .option('--lavish', 'Open the change, line by line, in Lavish for notes (and the make start design build, when there is one)')
  .option('--app', 'Also build the app with its own Vite config for Lavish (runs the pull request\'s build code here, like make dev)')
  .option('--no-install', 'Do not install the review copy\'s dependencies')
  .option('--remove', 'Delete the review copy (and any edits in it)'),
(ctx, ref, options) => review(ctx, ref, { lavish: options.lavish === true, app: options.app === true, install: options.install !== false,
  remove: options.remove === true }));

verb(team.command('comment <pr>').description('Comment on a pull request: on a changed line, or a general comment that quotes the target')
  .requiredOption('-m, --message <text>', 'What the comment says')
  .option('--file <path>', 'File of a line comment')
  .option('--line <n>', 'Line of a line comment (in the new version)')
  .option('--old', 'The line is a removed line (old version)')
  .option('--selector <css>', 'A Lavish note\'s CSS locator; lines of the review page map to their source line')
  .option('--source <file:line>', 'Source of an app element (its data-source), when Lavish showed one')
  .option('--text <text>', 'The element\'s text, quoted in a general comment'),
(ctx, ref, options) => comment(ctx, ref, { message: options.message, file: options.file, line: options.line, side: options.old ? 'LEFT' : 'RIGHT',
  selector: options.selector, source: options.source, text: options.text }));

verb(team.command('approve <pr>').description('Approve a teammate\'s pull request as yourself, on the version you reviewed. Never your own')
  .option('-m, --message <text>', 'Optional note with the approval'),
(ctx, ref, options) => approve(ctx, ref, { message: options.message }));

verb(team.command('request-changes <pr>').description('Ask a teammate for changes as yourself, on the version you reviewed. Never your own')
  .requiredOption('-m, --message <text>', 'What should change'),
(ctx, ref, options) => requestChanges(ctx, ref, { message: options.message }));

verb(team.command('feedback [pr]').description('Show my review feedback: approvals, requests for changes and comments on your pull request'),
  (ctx, ref) => feedback(ctx, ref));

verb(team.command('address [pr]').description('Address the comments: back on your own branch, with the reviewers\' comments as a to-do list'),
  (ctx, ref) => address(ctx, ref));
