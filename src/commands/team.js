import { resolve } from 'node:path';
import { program } from '../lib/cli-core.js';
import { conflicts, merge, pr, save, start, status, sync, TEAM_CODES, teamContext } from '../make-team.js';

// The plain-language git layer for a team-mode project's local clone. Each
// verb is deterministic: an agent picks the verb from the person's words and
// explains the JSON result; it never runs git itself. GitHub only, through the
// person's own git and gh logins; nothing here reads or writes Figma.
const team = program.command('team')
  .description('Plain-language git for a team-mode Make project clone: start, save, sync, conflicts, pr, merge, status')
  .addHelpText('after', '\nRun inside the project clone (or pass --dir). Work happens only on your own <gh-login>/<task> branch.' +
    '\nNever pushes to or force-pushes main; merges only your own pull request into main, after an approval' +
    '\nfrom someone other than its author. Results are JSON with a plain-language "summary".');

const report = value => console.log(JSON.stringify(value, null, 2));
const warn = message => console.error(`warning: ${message}`);
function failure(error) {
  console.error(JSON.stringify({ error: error.message,
    ...(TEAM_CODES.includes(error.code) ? { code: error.code } : {}),
    ...(error.files ? { files: error.files } : {}),
    ...(error.secrets ? { secrets: error.secrets } : {}),
    ...(error.large ? { large: error.large } : {}),
    ...(error.conflicts ? { conflicts: error.conflicts, untouched: error.untouched } : {}),
    ...(error.url ? { url: error.url } : {}) }, null, 2));
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

verb(team.command('sync').description('Get the latest: save, then bring in GitHub main (rebase) and push your branch with --force-with-lease')
  .option('-m, --message <text>', 'Commit message for any unsaved changes'),
(ctx, options) => sync(ctx, { message: options.message }));

verb(team.command('conflicts').description('Fix the conflict: auto-resolve only pnpm-lock.yaml and identical changes; otherwise undo and name who else changed each file'),
  ctx => conflicts(ctx));

verb(team.command('pr').description('Ready for review: sync, save, then open (or reuse) a pull request into main and request reviews from the areas map')
  .option('--title <text>', 'Pull request title (default: the task name)')
  .option('-m, --message <text>', 'Commit message for any unsaved changes'),
(ctx, options) => pr(ctx, { title: options.title, message: options.message }));

verb(team.command('merge').description('Merge it: squash-merge your own approved pull request into main, delete the branch, return to main'),
  ctx => merge(ctx));

verb(team.command('status').description('What\'s going on: branch, unsaved files, pull request and review state, and how far behind main')
  .option('--no-fetch', 'Do not fetch main from GitHub first'),
(ctx, options) => status(ctx, { fetch: options.fetch !== false }));
