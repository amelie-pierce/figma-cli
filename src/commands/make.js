import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { program } from '../lib/cli-core.js';
import { MakeTransport } from '../make-transport.js';
import { MakeClient } from '../make-client.js';
import { decodeMakeSource } from '../make-source.js';
import { requireSessionOnly } from '../make-session.js';
import { driftExitCode, digest } from '../make-drift.js';
import { buildStatus, checkWriteMode, linkedRepo, MODE_CODES, parseMarker, readGithub, recordLinkedRepo, refuseMarkerPaths,
  repoName, statusExitCode } from '../make-project.js';
import { CONFIRM_FLAG, runModeChange } from '../make-mode.js';
import { DEPLOY_CODES, deployAbort, deployApply, deployPlan, deployResume, deployVerify } from '../make-deploy.js';
import { cloneProject, install, LOCAL_CODES, pullProject, repoRoot, resolveCloneRepo, runDev } from '../make-local.js';
import { afterManifestPath, applySync, exportDelta, parsePackage, parseRequest, planSync, validatePlanDigest, VENDOR_ROOT,
  writeApplyOutputs } from '../make-sync.js';

const make = program.command('make')
  .description('Experimental direct source-file editing in Figma Make Desktop')
  .addHelpText('after', '\nAll Make commands accept --port PORT (global option). Use connection --save-port PORT to persist it.' +
    '\n\nReads (read, files, verify) see the open session\'s working copy. The original writes' +
    '\n(replace, create, import, remove) are session-only and require --session-only.' +
    '\nEvery write refuses in team mode, and in ambiguous mode without --solo.' +
    '\nOnly make mode team|solo adds or removes the .figma-cli/project.json team marker.' +
    '\nGit-mode write/delete use Make client VFS; save-version records a saved version.' +
    '\nclone, install, pull and dev run a team-mode project locally from GitHub main; they never write to Make.' +
    '\nIn team mode only make deploy writes to Make: a repo admin deploys GitHub main from a local clone.');

function report(value) { console.log(JSON.stringify(value, null, 2)); }
function failure(error) {
  console.error(JSON.stringify({ error: error.message,
    ...(error.endpoint ? { code: error.code, port: error.port, endpoint: error.endpoint, reason: error.reason, recovery: error.recovery } : {}),
    ...(error.backupPath ? { backupPath: error.backupPath } : {}),
    ...(error.receiptPath ? { receiptPath: error.receiptPath } : {}),
    ...(error.version ? { version: error.version } : {}),
    ...(error.completedWrites ? { completedWrites: error.completedWrites } : {}),
    ...(error.code === 'MAKE_SESSION_ONLY_REQUIRED' || MODE_CODES.includes(error.code) || LOCAL_CODES.includes(error.code) ||
      DEPLOY_CODES.includes(error.code) ? { code: error.code } : {}),
    ...(error.paths ? { paths: error.paths } : {}),
    ...(error.dir ? { dir: error.dir } : {}),
    ...(error.sessionWrites ? { sessionWrites: error.sessionWrites, requestedPaths: error.requestedPaths, observedWrites: error.observedWrites } : {}) }));
  process.exitCode = 1;
}
function sourceBytes(path) {
  if (path === '-' || path === '/dev/stdin') {
    process.stdin._handle?.setBlocking(true);
    return readFileSync(0);
  }
  return readFileSync(resolve(path));
}
function timeout(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 500 || n > 120000) throw new Error('Timeout must be 500–120000 milliseconds');
  return n;
}
function target(command, timeoutDefault = 15000) {
  return command.requiredOption('--file <key-or-url>', 'Exact open Make file key or URL')
    .option('--timeout <ms>', 'Maximum operation time', timeout, timeoutDefault);
}
// Every Make write honours solo/team mode.
function modeGated(command) {
  return command.option('--solo', 'Write although a repo is known but Make holds no team marker (ambiguous mode)')
    .option('--repo <owner/repo>', 'GitHub repo this Make file pushes to, if any; without a marker this makes the mode ambiguous', repoName);
}
// Make writes reach only the open session's working copy; refuse before
// connecting unless the caller accepted that with --session-only.
function sessionWrite(command) {
  return modeGated(target(command).option('--session-only', 'Accept that the write is lost when the file is reopened unless saved in Make'));
}
async function withClient(options, fn, write, paths = []) {
  let client;
  try {
    refuseMarkerPaths(paths);
    if (write && write !== 'mode') requireSessionOnly(write, options);
    client = new MakeClient({ timeoutMs: options.timeout });
    await client.connect(options.file);
    if (write) {
      const { warning, note } = await checkWriteMode(client, options);
      if (warning) console.error(`warning: ${warning}`);
      if (note) console.error(`note: ${note}`);
    }
    await fn(client);
  } catch (error) { failure(error); }
  finally { client?.close(); }
}

make.command('list').description('List open Make projects on the configured desktop port')
  .action(async () => {
    try {
      report((await MakeTransport.listTargets()).map(({ fileKey, title, url }) => ({ fileKey, title, url })));
    } catch (error) { failure(error); }
  });

target(make.command('inspect').description('Inspect editor readiness without changing source'))
  .action(options => withClient(options, async client => report(await client.inspect())));

target(make.command('ui').description('Report bounded Make workspace control metadata without reading source or selecting tabs'))
  .action(options => withClient(options, async client => report(await client.ui())));

target(make.command('preview').description('Inspect the running Make preview through the desktop connection'))
  .action(options => withClient(options, async client => report(await client.preview())));

target(make.command('files').description('Expand and list the source-file tree of the open session\'s working copy'))
  .action(options => withClient(options, async client => report(await client.files())));

target(make.command('diagnostics <path>').description('Read the selected source editor diagnostics when available'))
  .action((path, options) => withClient(options, async client => report(await client.diagnostics(path))));

target(make.command('read <path>').description('Read source and its SHA-256 from the open session\'s working copy through the filesystem bridge, at any depth'))
  .option('--remote', 'Require the filesystem bridge; never fall back to the editor buffer')
  .option('--out <local-file>', 'Write source to a new local file instead of stdout')
  .action((path, options) => withClient(options, async client => {
    const result = await client.read(path, { remote: options.remote });
    if (!options.out) return report(result);
    const outputPath = resolve(options.out);
    writeFileSync(outputPath, result.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const { content, ...metadata } = result;
    report({ ...metadata, bytes: Buffer.byteLength(content), outputPath });
  }));

sessionWrite(make.command('replace <path>').description('Session-only: back up and replace one existing source file at any depth in the open session\'s working copy, then read it back'))
  .requiredOption('--from <local-file>', 'UTF-8 source to write into the Make session')
  .requiredOption('--expected-sha256 <hash>', 'SHA-256 returned by the prior read; stale content is rejected')
  .option('--backup-dir <directory>', 'Local backup location (defaults to ~/.figma-cli/make-backups)')
  .action((path, options) => withClient(options, async client => {
    const bytes = sourceBytes(options.from);
    const content = decodeMakeSource(bytes);
    report(await client.replace(path, content, {
      expectedSha256: options.expectedSha256,
      backupDir: options.backupDir ? resolve(options.backupDir) : undefined,
    }));
  }, 'replace', [path]));

sessionWrite(make.command('create <path>').description('Session-only: create one new UTF-8 source file in the open session\'s working copy; existing paths are rejected'))
  .requiredOption('--from <source>', 'Existing UTF-8 file, or - for stdin (no local copy required)')
  .action((path, options) => withClient(options, async client => {
    report(await client.importFiles([{ path, content: decodeMakeSource(sourceBytes(options.from)) }]));
  }, 'create', [path]));

sessionWrite(make.command('import').description('Session-only: import new source files from a JSON manifest into the open session\'s working copy; never overwrite existing paths'))
  .requiredOption('--manifest <source>', 'JSON {files:[{path,content}]} file, or - for stdin')
  .action(options => withClient(options, async client => {
    const bytes = sourceBytes(options.manifest);
    if (bytes.length > 32 * 1024 * 1024) throw new Error('Make import manifest is limited to 32 MiB.');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    refuseMarkerPaths(Array.isArray(manifest?.files) ? manifest.files.map(file => file?.path) : []);
    report(await client.importFiles(manifest.files));
  }, 'import'));

sessionWrite(make.command('remove <path>').description('Session-only: back up and remove one exact text file from the open session\'s working copy after checking its SHA-256'))
  .requiredOption('--expected-sha256 <hash>', 'Expected original source hash; changed files are refused')
  .action((path, options) => withClient(options, async client => {
    report(await client.remove(path, { expectedSha256: options.expectedSha256 }));
  }, 'remove', [path]));

target(make.command('verify').description('Compare the open session\'s working copy against a manifest; this does not prove the files were saved'))
  .requiredOption('--manifest <source>', 'JSON {files:[{path,content}]} file, or - for stdin')
  .action(options => withClient(options, async client => {
    const bytes = sourceBytes(options.manifest);
    if (bytes.length > 32 * 1024 * 1024) throw new Error('Make verification manifest is limited to 32 MiB.');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    report(await client.verifyFiles(manifest.files));
  }));

target(make.command('drift').description('Read-only vendor inventory, manifest comparison and saved/pending-state check'), 120000)
  .requiredOption('--manifest <source>', 'VENDOR.json file, or - for stdin')
  .option('--receipt <file>', 'External receipt pinning the manifest and saved git SHA')
  .option('--root <path>', 'Vendor root in Make', 'src/vendor/atomic-aui')
  .option('--json', 'Print the complete machine-readable result')
  .action(options => withClient(options, async client => {
    const result = await client.drift(sourceBytes(options.manifest), {
      root: options.root, receiptBytes: options.receipt ? sourceBytes(options.receipt) : undefined,
    });
    if (options.json) report(result);
    else {
      console.log(`Make ${result.fileKey}: ${result.persistence?.mode || 'unknown'} mode, saved ${result.persistence?.savedVersion || 'unverified'}, pending ${result.persistence?.pendingCount ?? 'unknown'}`);
      console.log('Persistence scan: direct Make provider props, bounded at 100000 React fibers');
      console.log(`Vendor ${result.root}: ${Object.entries(result.counts).map(([status, count]) => `${status}=${count}`).join(' ')}`);
      console.log(`VENDOR.json: ${result.manifest.inMake?.sha256 || 'missing'} (${result.manifest.inMake?.bytes ?? 0} bytes)`);
      for (const file of result.files) {
        console.log(`${file.status}\t${file.path}\t${file.actual?.bytes ?? '-'}\t${file.actual?.sha256 ?? '-'}${file.expected ? `\texpected ${file.expected.bytes} ${file.expected.sha256}` : ''}`);
      }
      for (const reason of result.reasons) console.log(`drift: ${reason}`);
    }
    process.exitCode = driftExitCode(result);
  }));

target(make.command('status').description('Read-only project status: Make saved and working tree SHAs, solo/team mode and, with --repo, GitHub main'), 120000)
  .option('--repo <owner/repo>', 'Compare with this GitHub repo through your gh login (GET requests only); records the link in ~/.figma-cli for the write gate', repoName)
  .option('--json', 'Print the complete machine-readable result')
  .addHelpText('after', '\nExit codes: 0 all read and nothing needs attention; 1 the status could not be read' +
    '\n(Make or GitHub error); 2 read completely, with attention items listed.')
  .action(options => withClient(options, async client => {
    const make = await client.projectStatus();
    const marker = parseMarker(make.markerBytes, client.fileKey);
    let github;
    let githubError;
    if (options.repo) {
      const trunk = marker.state === 'valid' && marker.repo === options.repo ? marker.trunk : 'main';
      try { github = await readGithub(options.repo, { trunk }); }
      catch (error) { githubError = error.message; }
      if (github) recordLinkedRepo(client.fileKey, options.repo);
    }
    const linked = options.repo ? null : linkedRepo(client.fileKey);
    const result = buildStatus({ fileKey: client.fileKey, make, marker, repo: options.repo, linked, github, githubError });
    if (options.json) report(result);
    else {
      const m = result.make;
      console.log(`Make ${result.fileKey}: ${m.mode || 'unknown'} mode, saved ${m.savedVersion || 'none'}, pending ${m.pendingCount ?? 'unknown'}`);
      console.log(`Tree ${m.tree} (${m.treeSource}), working copy ${m.workingTree}, ${m.files} files, ${m.excluded.length} excluded (${m.excludeSource})`);
      if (m.latestAiVersion) console.log(`Latest AI-turn version ${m.latestAiVersion.versionNumber} (${m.latestAiVersion.gitSha})${m.baselineFromAiTurn ? ', the saved baseline' : ''}`);
      console.log(`Mode: ${result.mode.mode}${result.mode.repo ? ` (${result.mode.repo})` : ''}${result.mode.reason ? `: ${result.mode.reason}` : ''}`);
      const g = result.github;
      if (g?.error) console.log(`GitHub ${g.repo}: ${g.error}`);
      else if (g) {
        console.log(`GitHub ${g.repo} ${g.trunk} ${g.main.commit} tree ${g.main.tree}; default branch ${g.defaultBranch}`);
        console.log(`Base: ${g.base ? `${g.base.tag} ${g.base.commit} tree ${g.base.tree}` : 'none (no make-deploy tag)'}`);
        console.log(`Make vs ${g.trunk}: ${g.relation}${g.differingPaths?.length ? ` (${g.differingPaths.length} paths differ)` : ''}`);
        console.log(`Unreviewed commits: ${g.unreviewed.length} of ${g.commitsChecked} checked${g.truncated ? ' (truncated)' : ''}`);
        console.log(`Your permission: ${g.permission}${g.mayDeploy ? ' (may deploy)' : ''}`);
        console.log(`Mirror: ${g.mirror.state}: ${g.mirror.reason}`);
      }
      for (const item of result.attention) console.log(`attention: ${item}`);
    }
    process.exitCode = statusExitCode(result);
  }));

modeGated(target(make.command('write <path>').description('Write one git-mode Make file through Make client VFS; save-version is required to persist it'), 120000)
  .requiredOption('--from <source>', 'Existing UTF-8 file, or - for stdin')
  .option('--expected-sha256 <hash>', 'Required for an existing file; omit for a new file')
  .option('--backup-dir <directory>', 'Private backup directory for replaced content')
  .option('--first-version', 'Only for a git-mode file with no saved version yet; refused once it has one')
  .action((path, options) => withClient(options, async client => report(await client.writeDurable(path, decodeMakeSource(sourceBytes(options.from)), {
    expectedSha256: options.expectedSha256, firstVersion: options.firstVersion === true, backupDir: options.backupDir ? resolve(options.backupDir) : undefined,
  })), 'mode', [path])));

modeGated(target(make.command('delete <path>').description('Delete one git-mode Make file through Make client VFS after backup; save-version is required'), 120000)
  .requiredOption('--expected-sha256 <hash>', 'Current SHA-256 of the file to remove')
  .option('--backup-dir <directory>', 'Private backup directory')
  .option('--first-version', 'Only for a git-mode file with no saved version yet; refused once it has one')
  .action((path, options) => withClient(options, async client => report(await client.deleteDurable(path, {
    expectedSha256: options.expectedSha256, firstVersion: options.firstVersion === true, backupDir: options.backupDir ? resolve(options.backupDir) : undefined,
  })), 'mode', [path])));

modeGated(target(make.command('save-version').description('Save only the exact expected pending git-mode paths using Make createVersion'), 120000)
  .requiredOption('--title <title>', 'Make version title')
  .requiredOption('--expected-path <path>', 'One pending path; repeat for every expected path', (path, paths = []) => [...paths, path])
  .option('--receipt-out <path>', 'Write version ID, git SHA and changed-file set to a new private JSON file')
  .option('--first-version', 'Create the first version of a git-mode file that has none; needs --since')
  .option('--since <commit>', 'With --first-version: the sandbox head make status reported before the writes; the expected paths must equal the working copy\'s difference from it')
  .action(options => withClient(options, async client => {
    if (options.since && !options.firstVersion) throw new Error('--since applies only with --first-version; no Make version was requested.');
    const outputPath = options.receiptOut ? resolve(options.receiptOut) : null;
    if (outputPath && existsSync(outputPath)) throw new Error('Receipt path already exists; no Make version was requested.');
    const writeReceipt = version => {
      if (!outputPath) return;
      writeFileSync(outputPath, `${JSON.stringify(version, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      version.receiptPath = outputPath;
    };
    let result;
    try {
      result = options.firstVersion ? await client.saveFirstVersion(options.title, options.expectedPath, { since: options.since })
        : await client.saveVersion(options.title, options.expectedPath);
    }
    catch (error) {
      if (error.version) {
        try { writeReceipt(error.version); }
        catch (receiptError) { error.message += ` The local receipt also failed: ${receiptError.message}`; }
      }
      throw error;
    }
    try { writeReceipt(result); }
    catch (error) {
      report(result);
      throw new Error(`Make version was saved but the local receipt failed: ${error.message}`);
    }
    report(result);
  }, 'mode', options.expectedPath)));

target(make.command('export-delta').description('Export a clean saved Make delta for atomic-cli intake-make-delta'), 120000)
  .requiredOption('--manifest <source>', 'Trusted VENDOR.json baseline')
  .requiredOption('--who <identity>', 'Engineer requesting the export')
  .requiredOption('--out <file>', 'New private delta JSON file')
  .requiredOption('--candidate-dir <dir>', 'Workspace candidates at full Make paths; files differing from the baseline are reported as conflicts')
  .option('--path <path>', 'Exact vendor path; repeat to limit the delta', (path, paths = []) => [...paths, path])
  .option('--dependency <path>', 'Exact unchanged support file; repeat as needed', (path, paths = []) => [...paths, path])
  .action(options => withClient(options, async client => {
    const out = resolve(options.out);
    if (existsSync(out)) throw new Error('Delta output already exists.');
    const scan = await client.inventoryVendor(VENDOR_ROOT, { includeBytes: true });
    const delta = exportDelta({ ...scan, baselineBytes: sourceBytes(options.manifest), candidateDir: options.candidateDir,
      fileKey: client.fileKey, who: options.who, paths: options.path, dependencyPaths: options.dependency });
    writeFileSync(out, `${JSON.stringify(delta, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    report({ outputPath: out, fileKey: client.fileKey, version: delta.make.savedVersionGitSha, conflicts: delta.conflicts,
      files: delta.files.map(({ path, status, before, after, workspace, conflict }) => ({ path, status, before, after, workspace, conflict })) });
  }));

modeGated(target(make.command('sync').description('Plan or apply an explicit package-bound workspace-to-Make sync'), 120000)
  .requiredOption('--package <dir>', 'atomic-cli package-make-kit output directory')
  .requiredOption('--manifest <file>', 'Trusted VENDOR.json baseline')
  .requiredOption('--request <file>', 'Explicit sync request JSON')
  .requiredOption('--candidate-dir <dir>', 'Root containing explicitly scoped workspace component candidates')
  .option('--generation-manifest <file>', 'Committed generated.manifest.json bytes, needed for token updates')
  .option('--plan-out <file>', 'New reviewed plan JSON file (dry-run default)')
  .option('--apply <file>', 'Apply this reviewed plan only')
  .option('--receipt-out <file>', 'New private receipt JSON file (required with --apply)')
  .option('--backup-dir <dir>', 'Private backup directory for replaced/deleted Make files')
  .option('--title <title>', 'Saved Make version title', 'AtomicAUI explicit sync')
  .action(options => withClient(options, async client => {
    if (!!options.apply === !!options.planOut) throw new Error('Choose exactly one of --plan-out or --apply.');
    if (options.apply && !options.receiptOut) throw new Error('Apply requires --receipt-out.');
    const output = resolve(options.apply ? options.receiptOut : options.planOut);
    if (existsSync(output) || (options.apply && existsSync(afterManifestPath(output)))) {
      throw new Error('Output file already exists; no sync was attempted.');
    }
    const requestBytes = sourceBytes(options.request);
    const request = parseRequest(requestBytes, client.fileKey);
    const packageData = parsePackage(resolve(options.package));
    const baselineBytes = sourceBytes(options.manifest);
    const generationManifestBytes = options.generationManifest ? sourceBytes(options.generationManifest) : null;
    const scan = await client.inventoryVendor(VENDOR_ROOT, { includeBytes: true });
    const { plan, vendorBytes } = planSync({ request, requestSha256: digest(requestBytes), packageData,
      baselineBytes, candidateDir: options.candidateDir, generationManifestBytes,
      ...scan, fileKey: client.fileKey });
    if (!options.apply) {
      writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      return report({ planPath: output, digest: plan.digest, fileKey: plan.fileKey, makeVersion: plan.makeVersion,
        workspaceCommit: plan.workspaceCommit, unresolved: plan.unresolved, outOfScopeDrift: plan.outOfScopeDrift,
        actions: plan.actions });
    }
    const reviewed = validatePlanDigest(JSON.parse(sourceBytes(options.apply).toString('utf8')));
    if (reviewed.digest !== plan.digest) throw new Error('Reviewed sync plan is stale; no Make files were written.');
    let result;
    try {
      result = await applySync(client, { plan, vendorBytes, packageData,
        candidateDir: options.candidateDir, generationManifestBytes, title: options.title,
        backupDir: options.backupDir ? resolve(options.backupDir) : undefined });
    } catch (error) {
      if (error.completedWrites?.length || error.version) {
        const vendorWritten = error.completedWrites?.some(write => write.path === `${VENDOR_ROOT}/VENDOR.json`);
        const manifestPath = writeApplyOutputs(output, { schema: 'figma-cli/make-sync-receipt@1', outcome: 'uncertain',
          planDigest: plan.digest, fileKey: client.fileKey, requestId: request.requestId,
          completedWrites: error.completedWrites, version: error.version || null,
          error: error.message }, vendorWritten ? vendorBytes : null);
        error.message += ` Recovery receipt: ${output}. Run make drift with --manifest ${manifestPath || 'the trusted baseline'} to read the saved version and pending paths before reconciling.`;
      }
      throw error;
    }
    const { version, drift, writes } = result;
    const receipt = { schema: 'figma-cli/make-sync-receipt@1', requestId: request.requestId, who: request.who,
      direction: request.direction, fileKey: client.fileKey, scope: plan.scope, choices: request.choices,
      planDigest: plan.digest, baselineManifestSha256: plan.baselineManifestSha256,
      beforeManifestSha256: plan.vendorBefore.sha256,
      workspaceCommit: plan.workspaceCommit, previousMakeVersion: plan.makeVersion,
      makeVersion: version, files: writes, generatedTreeDigest: plan.generatedTreeDigest,
      verification: 'saved-clean-drift-matched; fresh-sandbox-reload-pending' };
    const manifestPath = writeApplyOutputs(output, receipt, vendorBytes);
    report({ receiptPath: output, afterManifestPath: manifestPath, makeVersion: version, drift: { ok: drift.ok, counts: drift.counts, batches: drift.batches } });
  }, 'mode')));

// The team-mode toggle. It is the only command that adds or removes the
// marker, and it bypasses the team-mode write gate for that one path only.
const mode = make.command('mode').description('Turn team mode on or off: add or remove the .figma-cli/project.json marker and save it as its own Make version');
function modeCommand(command) {
  return target(command, 120000)
    .option('--first-version', 'Only for a git-mode file with no saved version yet: save the change as its first version')
    .option('--since <commit>', 'With --first-version, when the marker change is already in the working copy: the sandbox head from before it')
    .option('--dry-run', 'Report what would change without writing to Make');
}
modeCommand(mode.command('team').description('Write the team marker {fileKey, repo, trunk: "main"}, save it as a version and verify it after a reload'))
  .requiredOption('--repo <owner/repo>', 'GitHub repo this Make file deploys from (read through your gh login, GET requests only)', repoName)
  .action(options => withClient(options, async client => report(await runModeChange(client, {
    action: 'team', repo: options.repo, firstVersion: options.firstVersion === true, since: options.since, dryRun: options.dryRun === true,
  }))));
modeCommand(mode.command('solo').description('Remove the team marker, save that as a version and verify it after a reload; a linked repo\'s admins only'))
  .option(CONFIRM_FLAG, 'Confirm turning team mode off')
  .action(options => withClient(options, async client => report(await runModeChange(client, {
    action: 'solo', firstVersion: options.firstVersion === true, since: options.since, dryRun: options.dryRun === true,
    confirm: options.yesTurnOffTeamMode === true,
  }))));

// Deploy GitHub main into a team-mode Make file. It is the one Make write that
// team mode allows, so it runs its own guards instead of the write gate.
target(make.command('deploy').description('Deploy GitHub main from a local clone into a team-mode Make file (repo admins only). Dry run by default'), 120000)
  .option('--dir <path>', 'Local clone of the repo, on a clean main equal to GitHub\'s (default: current folder)')
  .option('--plan-out <file>', 'Dry run: write the plan here instead of ~/.figma-cli/deploys/plans/')
  .option('--apply <plan>', 'Re-plan, check the reviewed plan still holds, then write, save one version, check drift, record the receipt and push the tag')
  .option('--verify <receipt>', 'Reload Make, confirm the deployed version and tree, and finalise an uncertain receipt (pushes a missing tag)')
  .option('--resume <receipt>', 'Finish an interrupted deploy that saved no version: write the remaining paths, then save')
  .option('--abort <receipt>', 'Undo an interrupted deploy that saved no version: restore the written paths from backups')
  .addHelpText('after', '\nGuards: team-mode Make file; your gh login is an admin of its repo; the clone is on main, clean and equal' +
    '\nto GitHub\'s main, which arrived through a merged pull request; pnpm install --frozen-lockfile and the build pass; Make' +
    '\nis in git mode with a saved version, nothing pending, idle, and equal to the last make-deploy/<n> tag\'s main tree.' +
    '\nBinary, large and LFS files are refused. Receipts are private, under ~/.figma-cli/deploys/.')
  .action(options => withClient(options, async client => {
    const chosen = ['apply', 'verify', 'resume', 'abort'].filter(name => options[name]);
    if (chosen.length > 1) throw new Error(`Choose one of --apply, --verify, --resume or --abort, not ${chosen.map(name => `--${name}`).join(' and ')}.`);
    if (options.planOut && chosen.length) throw new Error('--plan-out applies only to a dry run.');
    const deps = { warn: message => console.error(`warning: ${message}`) };
    const dir = options.dir ? resolve(options.dir) : undefined;
    if (options.apply) return report(await deployApply(client, { dir, planPath: options.apply }, deps));
    if (options.verify) return report(await deployVerify(client, { dir, receiptPath: options.verify }, deps));
    if (options.resume) return report(await deployResume(client, { dir, receiptPath: options.resume }, deps));
    if (options.abort) return report(await deployAbort(client, { receiptPath: options.abort }, deps));
    report(await deployPlan(client, { dir, planOut: options.planOut }, deps));
  }));

// Local runs of a team-mode project. They read GitHub through the caller's
// own gh and git logins and never write to Make; only clone --file reads Make
// (the team marker, through the same client VFS read as the write gate).
const localWarning = message => console.error(`warning: ${message}`);
make.command('clone [repo] [dir]').description('Clone a team-mode project\'s GitHub repo at main with your own gh login, then install it (frozen lockfile, --ignore-scripts)')
  .option('--file <key-or-url>', 'Take the repo from this open Make file\'s team marker instead of naming owner/repo')
  .option('--timeout <ms>', 'Maximum time to read the Make team marker', timeout, 15000)
  .addHelpText('after', '\nWith --file, the only argument is the folder: make clone --file KEY [dir].' +
    '\nStops before installing when package.json has a @make-kits/* dependency (kit attached in Make),' +
    '\nwhich installs only inside Make. Never copies Make\'s .npmrc; warns on a committed .npmrc credential.')
  .action(async (repoArg, dirArg, options) => {
    let client;
    try {
      let repo = repoArg;
      let dir = dirArg;
      let markerBytes;
      let fileKey;
      if (options.file) {
        if (dirArg !== undefined) throw new Error('With --file, pass only the folder: make clone --file KEY [dir].');
        [repo, dir] = [undefined, repoArg];
        client = new MakeClient({ timeoutMs: options.timeout });
        await client.connect(options.file);
        fileKey = client.fileKey;
        markerBytes = await client.projectMarker();
        client.close();
        client = null;
      }
      const resolved = resolveCloneRepo({ repo, fileKey, markerBytes });
      report(cloneProject({ ...resolved, dir }, { warn: localWarning }));
    } catch (error) { failure(error); }
    finally { client?.close(); }
  });

make.command('install [dir]').description('Install a cloned project\'s dependencies with pnpm, its frozen lockfile and --ignore-scripts, after the toolchain, kit and .npmrc checks')
  .action(dir => {
    try {
      const root = repoRoot(resolve(dir || '.'));
      report({ dir: root, ...install(root, { warn: localWarning }) });
    }
    catch (error) { failure(error); }
  });

make.command('pull [dir]').description('Fetch GitHub main and fast-forward local main only; reinstall (--ignore-scripts) only when the lockfile changed')
  .addHelpText('after', '\nRefuses when local main has commits that are not on GitHub, or main has uncommitted tracked changes.' +
    '\nOn another branch, only the local main ref moves; your branch and node_modules stay as they are.')
  .action(dir => {
    try { report(pullProject(resolve(dir || '.'), { warn: localWarning })); }
    catch (error) { failure(error); }
  });

make.command('dev [dir]').description('Run the project\'s dev server (pnpm run dev from package.json scripts.dev) in the foreground and print its local URL')
  .addHelpText('after', '\nIt runs until stopped (Ctrl-C). Agents must start it as a background job and poll the printed' +
    '\nURL (for example curl -sf http://localhost:5173/) instead of waiting for the command to return.')
  .action(async dir => {
    try {
      const result = await runDev(repoRoot(resolve(dir || '.')));
      process.exitCode = result.code;
    } catch (error) { failure(error); }
  });
