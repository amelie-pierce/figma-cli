import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MakeClient } from '../make-client.js';
import { checkWriteMode } from '../make-project.js';
import { currentBranch, fail, fetchMain, listChanges, ORIGIN_TRUNK, pr, remoteBranchSha, requireNoOperation, revOf, save, start,
  taskBranch, teamContext } from '../make-team.js';
import { review } from '../make-team-review.js';
import { listenNotice } from '../lavish-listen.js';
import { digest, vendorManifest } from '../make-drift.js';
import { ATOMICAUI_ROOT, ATOMICAUI_SITE, RELEASE_ROOT, buildRelease, changeReport, downloadRelease,
  installRelease, installedStatus, latestRelease, nextPatch, planBreakingFixes, version } from '../make-atomicaui.js';

const format = value => `${JSON.stringify(value, null, 2)}\n`;
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const PUBLISH = [
  'After the release is saved, open the kit in Figma Make > Make settings > General.',
  'If the site is already Published, click Unpublish, then Publish to rebuild the site.',
  'Set Who can view to Anyone on the web and leave password protection off. Keep the existing site address.',
  'Complete Publish and close the dialog. The address can return 404 for about a minute during republishing.',
  'Update kit and Publish kit update the kit package; they do not rebuild the site.',
];

function requireClean(state, allowedPending = null) {
  if (!state || state.mode !== 'git' || !state.hasBaseline || !/^[a-f0-9]{40}$/.test(state.savedVersion || '') ||
      state.isLoading || state.error || !Array.isArray(state.pendingPaths) || state.pendingCount !== state.pendingPaths.length ||
      (allowedPending ? state.pendingPaths.some(path => !allowedPending.has(path)) : state.pendingCount !== 0)) {
    throw new Error('AtomicAUI operation requires a clean saved git-mode Make version.');
  }
}
async function withMake(file, fn) {
  const client = new MakeClient({ timeoutMs: 120000 });
  try { await client.connect(file); return await fn(client); }
  finally { client.close(); }
}
function fileNames(tree) { return new Set(tree.filter(entry => entry.kind === 'file').map(entry => entry.path)); }

export async function releaseAtomicaui(client, { requestedVersion, breakingChanges = [], resume = false, partBase64Bytes } = {}) {
  await checkWriteMode(client, {});
  if (resume && !requestedVersion) throw new Error('Resuming an AtomicAUI release requires --version.');
  const resumePrefix = resume ? `${RELEASE_ROOT}/${version(requestedVersion)}/` : null;
  const releasePending = state => requireClean(state, resume && state ? new Set(state.pendingPaths.filter(path =>
    path.startsWith(resumePrefix) || path === `${RELEASE_ROOT}/latest.json`)) : null);
  releasePending((await client._driftState(Date.now() + 120000)).state);
  const tree = fileNames(await client.files());
  const latestPath = `${RELEASE_ROOT}/latest.json`;
  let current = null, oldLatestHash = null;
  if (tree.has(latestPath)) {
    const prior = await client.read(latestPath, { remote: true });
    current = JSON.parse(prior.content);
    if (current?.schema !== 'figma-cli/atomicaui-latest@1') throw new Error('Existing AtomicAUI latest.json has an unsupported schema.');
    version(current.version);
    oldLatestHash = prior.sha256;
  }
  const selected = requestedVersion ? version(requestedVersion) : current ? nextPatch(current.version) : '7.0.0';
  const prefix = `${RELEASE_ROOT}/${selected}/`;
  const existingRelease = [...tree].filter(path => path.startsWith(prefix));
  if (!resume && existingRelease.length) throw new Error(`AtomicAUI ${selected} already exists. Release folders are immutable.`);
  if (resume && !existingRelease.length) throw new Error(`AtomicAUI ${selected} has no interrupted release to resume.`);
  const scan = await client.inventoryVendor(ATOMICAUI_ROOT, { includeBytes: true });
  releasePending(scan.state);
  if (resume && (!scan.state.pendingCount || existingRelease.some(path => !scan.state.pendingPaths.includes(path)))) {
    throw new Error(`AtomicAUI ${selected} is not an entirely unsaved release folder; immutable release refused.`);
  }
  const release = buildRelease({ inventory: scan.inventory, contents: scan.contents, version: selected, breakingChanges,
    ...(partBase64Bytes === undefined ? {} : { partBase64Bytes }) });
  const expected = [...release.output.keys()].sort();
  const expectedSet = new Set(expected);
  if (resume && (existingRelease.some(path => !expectedSet.has(path)) ||
      scan.state.pendingPaths.some(path => !expectedSet.has(path)))) {
    throw new Error('Interrupted AtomicAUI release contains an unexpected path.');
  }
  const completed = [];
  const replacements = new Map();
  if (resume) {
    for (const path of existingRelease) {
      const actual = await client.read(path, { remote: true });
      const bytes = release.output.get(path);
      if (Buffer.byteLength(actual.content) === bytes.length && digest(Buffer.from(actual.content)) === digest(bytes)) completed.push(path);
      else replacements.set(path, actual.sha256);
    }
    if (tree.has(latestPath) && current?.version === selected) {
      const actual = await client.read(latestPath, { remote: true });
      if (digest(Buffer.from(actual.content)) === digest(release.output.get(latestPath))) completed.push(latestPath);
      else replacements.set(latestPath, actual.sha256);
    }
  }
  const completedSet = new Set(completed);
  try {
    for (const [path, bytes] of release.output) {
      if (completedSet.has(path)) continue;
      const result = await client.writeDurable(path, decode(bytes),
        { expectedSha256: replacements.get(path) || (path === latestPath ? oldLatestHash : undefined), releaseAsset: true });
      if (result.changed) { completed.push(path); completedSet.add(path); }
    }
  } catch (error) {
    error.completedWrites = completed.map(path => ({ path }));
    throw error;
  }
  if (completed.length !== expected.length) throw new Error('AtomicAUI release write set differs from the expected path set.');
  const saved = await client.saveVersion(`AtomicAUI ${selected} library release`, expected);
  for (let offset = 0; offset < expected.length; offset += 16) {
    const files = expected.slice(offset, offset + 16).map(path => ({ path, content: decode(release.output.get(path)) }));
    const verified = await client.verifyFiles(files);
    if (verified.verification !== 'remote-content-matched' || verified.files.length !== files.length) {
      throw new Error('AtomicAUI saved release verification did not match.');
    }
  }
  requireClean((await client._driftState(Date.now() + 120000)).state);
  return { version: selected, fileCount: release.manifest.files.length, releasePaths: expected.length,
    archiveParts: release.manifest.archive.parts.length, manifestSha256: digest(release.output.get(`${prefix}manifest.json`)),
    savedVersion: saved.versionNumber, savedGitSha: saved.gitSha, verification: 'saved-version-clean-pending; remote-content-matched',
    publishSteps: PUBLISH };
}

export async function verifyAtomicauiRelease(client, requestedVersion) {
  const selected = version(requestedVersion);
  const before = (await client._driftState(Date.now() + 120000)).state;
  requireClean(before);
  const actual = await client.inventoryVendor(RELEASE_ROOT, { includeBytes: true });
  requireClean(actual.state);
  if (actual.state.savedVersion !== before.savedVersion) throw new Error('Make version changed during release verification.');
  const requested = new Set();
  const fetchImpl = async url => {
    const path = decodeURIComponent(new URL(url).pathname).replace(/^\/atomicaui\//, '');
    requested.add(path);
    const bytes = actual.contents.get(path), observed = actual.inventory.get(path);
    const intact = bytes && observed && observed.bytes === bytes.length && observed.sha256 === digest(bytes);
    return { status: intact ? 200 : 404, headers: { get: () => 'application/octet-stream' }, arrayBuffer: async () => intact ? bytes : Buffer.alloc(0) };
  };
  let release;
  try { release = await downloadRelease({ site: 'https://saved-release.invalid', version: selected, fetchImpl }); }
  catch (error) { throw new Error(`Saved AtomicAUI release differs: ${error.message}`); }
  const saved = [...actual.inventory.keys()].filter(path => path.startsWith(`${selected}/`)).sort();
  if (JSON.stringify(saved) !== JSON.stringify([...requested].sort())) throw new Error('Saved AtomicAUI release path set differs.');
  const latestBytes = actual.contents.get('latest.json');
  let latest = null;
  if (latestBytes) {
    try { latest = JSON.parse(decode(latestBytes)); } catch { throw new Error('Saved AtomicAUI latest.json is invalid JSON.'); }
  }
  const isLatest = latest?.version === selected;
  if (isLatest && (latest.schema !== 'figma-cli/atomicaui-latest@1' || latest.manifest !== `${selected}/manifest.json` ||
      latest.manifestSha256 !== release.manifestSha256)) {
    throw new Error('Saved AtomicAUI release differs: latest.json');
  }
  const after = (await client._driftState(Date.now() + 120000)).state;
  requireClean(after);
  if (after.savedVersion !== before.savedVersion) throw new Error('Make version changed during release verification.');
  return { version: selected, releasePaths: saved.length, sourceFiles: release.manifest.files.length, latest: isLatest,
    manifestSha256: release.manifestSha256, savedGitSha: after.savedVersion,
    verification: 'saved-version-clean-pending; manifest-chain-matched' };
}

function providerChanges(main, pkg) {
  const mainPath = 'src/main.tsx';
  let nextMain = main;
  if (!main.includes("./vendor/atomic-aui/tokens/index.scss")) {
    nextMain = `import './vendor/atomic-aui/tokens/index.scss'\n${nextMain}`;
  }
  if (!main.includes('AuiIdentityProvider')) {
    if (!nextMain.includes('<App />')) throw new Error('Cannot find <App /> in src/main.tsx for AtomicAUI provider wiring.');
    nextMain = `import { AuiIdentityProvider } from './vendor/atomic-aui'\n${nextMain}`
      .replace('<App />', '<AuiIdentityProvider brand="atomic" theme="light"><App /></AuiIdentityProvider>');
  }
  const packageValue = JSON.parse(pkg);
  const hasSass = packageValue.dependencies?.sass || packageValue.devDependencies?.sass;
  if (!hasSass) packageValue.devDependencies = { ...packageValue.devDependencies, sass: '^1.89.0' };
  const nextPackage = hasSass ? pkg : format(packageValue);
  return new Map([['src/main.tsx', nextMain], ['package.json', nextPackage]]);
}
function changeSummary(report) {
  const notes = report.breakingChanges.map(item => typeof item === 'string' ? item : item.note);
  return `AtomicAUI ${report.from || 'not installed'} to ${report.to}: ${report.added.length} added, ${report.changed.length} changed, ` +
    `${report.removed.length} removed files.${notes.length ? ` Breaking changes: ${notes.join('; ')}.` : ''}`;
}
export function teamChangeReport(ctx, report) {
  const changed = ctx.git(['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', `${ORIGIN_TRUNK}...HEAD`], 'Listing the changed files')
    .split('\n').filter(path => path && !insideVendor(path));
  const notes = report.breakingChanges.map(item => item.note);
  return [`AtomicAUI ${report.from || 'not installed'} to ${report.to}.`, '',
    `- ${ATOMICAUI_ROOT}/: ${report.added.length} added, ${report.changed.length} changed, ${report.removed.length} removed`,
    ...changed.map(path => `- ${path}`),
    ...(notes.length ? ['', 'Breaking changes fixed in this pull request:', ...notes.map(note => `- ${note}`)] : [])].join('\n');
}
function installDependencies(ctx, root) {
  const manager = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
  const args = manager === 'pnpm' ? ['install', '--ignore-scripts', '--no-frozen-lockfile'] : ['install', '--ignore-scripts'];
  const installed = ctx.run(manager, args, { cwd: root });
  if (installed.status !== 0) throw new Error(`AtomicAUI dependency install failed: ${(installed.stderr || installed.stdout).trim().split('\n').pop()}`);
}
const OWN_FILES = new Set(['src/main.tsx', 'package.json', 'pnpm-lock.yaml', 'package-lock.json']);
const insideVendor = path => path.startsWith(`${ATOMICAUI_ROOT}/`);
function showAt(ctx, ref, path) {
  const result = ctx.tryGit(['show', `${ref}:${path}`]);
  return result.status === 0 ? result.stdout : null;
}
function vendorAt(ctx, ref) {
  const text = showAt(ctx, ref, `${ATOMICAUI_ROOT}/VENDOR.json`);
  if (text === null) return { installed: false, version: null, files: new Map() };
  return { installed: true, version: JSON.parse(text).atomicauiRelease?.version || null,
    files: vendorManifest(Buffer.from(text), ATOMICAUI_ROOT).files };
}
export function prepareTeamBranch(ctx, { mode, manifest }) {
  const name = `atomicaui-${mode}-${manifest.version}`;
  const branch = taskBranch(ctx.login(), name);
  requireNoOperation(ctx);
  fetchMain(ctx);
  const local = revOf(ctx, `refs/heads/${branch}`);
  const remote = remoteBranchSha(ctx, branch);
  const current = currentBranch(ctx);
  const dirty = listChanges(ctx).flatMap(change => [change.path, change.from].filter(Boolean));
  if (!local && !remote) {
    if (dirty.length) fail(`AtomicAUI ${mode} requires a clean working tree; save or discard your changes first. Nothing was changed.`, 'TEAM_UNSAVED');
    return { branch: start(ctx, name).branch, continued: false };
  }
  const pulls = ctx.ghJson(['pr', 'list', '--repo', ctx.repo(), '--head', branch, '--state', 'all', '--json', 'url,state,headRefName,isCrossRepository',
    '--limit', '20'], 'Looking up your pull request');
  const finished = (Array.isArray(pulls) ? pulls : []).find(pull => pull.headRefName === branch && !pull.isCrossRepository && pull.state !== 'OPEN');
  if (finished) {
    fail(`${branch} already has a ${String(finished.state).toLowerCase()} pull request (${finished.url}), so this AtomicAUI ${mode} was not continued. ` +
      'Nothing was changed.', 'TEAM_BRANCH_EXISTS');
  }
  if (dirty.length && (current !== branch || !dirty.every(insideVendor))) {
    fail(`AtomicAUI ${mode} can continue only with unsaved changes inside ${ATOMICAUI_ROOT}/ on ${branch}; save or discard the others first. ` +
      'Nothing was changed.', 'TEAM_UNSAVED');
  }
  if (remote) ctx.git(['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], `Getting ${branch} from GitHub`);
  const email = ctx.tryGit(['config', 'user.email']).stdout.trim();
  const fixPaths = new Set(manifest.breakingChanges.flatMap(item => item.fixes || []).map(fix => fix.path));
  const own = path => insideVendor(path) || OWN_FILES.has(path) || fixPaths.has(path);
  for (const ref of new Set([local, remote].filter(Boolean))) {
    const authors = ctx.git(['log', '--format=%ae', `${ORIGIN_TRUNK}..${ref}`]).split('\n').filter(Boolean);
    const paths = ctx.git(['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', `${ORIGIN_TRUNK}...${ref}`]).split('\n').filter(Boolean);
    const foreign = [...new Set(authors.filter(author => author !== email))].map(author => `a save by ${author}`)
      .concat(paths.filter(path => !own(path)));
    if (foreign.length) {
      fail(`${branch} has work this AtomicAUI ${mode} did not make (${foreign.join(', ')}), so it was not continued. Nothing was changed.`,
        'TEAM_BRANCH_EXISTS');
    }
  }
  if (current !== branch) {
    ctx.git(local ? ['switch', '--quiet', branch] : ['switch', '--quiet', '-c', branch, `refs/remotes/origin/${branch}`], `Switching to ${branch}`);
  }
  ctx.warn('Continuing your earlier AtomicAUI update.');
  return { branch, continued: true };
}
export async function installTeamRelease(directory, release, { mode } = {}) {
  const root = resolve(directory);
  const ctx = teamContext({ dir: root, warn: message => console.error(message) });
  ctx.repo(); // A GitHub origin is sufficient when a team marker has not been created yet.
  const vendorDir = join(root, ATOMICAUI_ROOT);
  const preflight = installedStatus(vendorDir);
  if (preflight.localEdits.length) throw new Error(`Local AtomicAUI edits refuse ${mode}: ${preflight.localEdits.join(', ')}`);
  fetchMain(ctx);
  const before = vendorAt(ctx, ORIGIN_TRUNK);
  if (mode === 'add' && before.installed) throw new Error('AtomicAUI is already installed. Use upgrade.');
  if (mode === 'upgrade' && !before.installed) throw new Error('AtomicAUI is not installed. Use add.');
  if (showAt(ctx, ORIGIN_TRUNK, 'src/main.tsx') === null || showAt(ctx, ORIGIN_TRUNK, 'package.json') === null) {
    throw new Error('AtomicAUI needs src/main.tsx and package.json for provider wiring.');
  }
  const fixes = await planBreakingFixes(release.manifest, async path => showAt(ctx, ORIGIN_TRUNK, path));
  const started = prepareTeamBranch(ctx, { mode, manifest: release.manifest });
  if (installedStatus(vendorDir).localEdits.length) throw new Error('AtomicAUI project changed after starting the branch; install refused.');
  installRelease(root, release);
  const report = changeReport(before, release);
  const wiring = providerChanges(fixes.get('src/main.tsx')?.content || readFileSync(join(root, 'src/main.tsx'), 'utf8'),
    fixes.get('package.json')?.content || readFileSync(join(root, 'package.json'), 'utf8'));
  const changed = new Map([...fixes].filter(([path]) => path !== 'src/main.tsx' && path !== 'package.json')
    .map(([path, entry]) => [path, entry.content]).concat([...wiring]));
  for (const [path, content] of changed) {
    if (!existsSync(join(root, path)) || readFileSync(join(root, path), 'utf8') !== content) writeFileSync(join(root, path), content);
  }
  installDependencies(ctx, root);
  const saved = save(ctx, { message: `Update ${report.added.length + report.changed.length + report.removed.length} files under ${ATOMICAUI_ROOT}` });
  const pullRequest = pr(ctx, {
    title: `${mode === 'add' ? 'Add' : 'Upgrade'} ${ATOMICAUI_ROOT} (${report.added.length + report.changed.length + report.removed.length} files)`,
    body: teamChangeReport(ctx, report),
  });
  const visual = review(ctx, pullRequest.url, { lavish: true, app: true });
  return { mode: 'team', branch: started.branch, continued: started.continued, report, saved: saved.saved, pullRequest: pullRequest.url,
    review: { dir: visual.dir, run: visual.run, ...(visual.lavish ? { lavish: visual.lavish } : {}) },
    ...(visual.listen ? { listen: visual.listen } : {}), ...(visual.warnings ? { warnings: visual.warnings } : {}),
    summary: `${started.continued ? 'Continuing your earlier AtomicAUI update. ' : ''}${changeSummary(report)} Opened ${pullRequest.url} on ${started.branch}.` };
}

function reverseFixes(fixes, content) {
  let text = content;
  for (const fix of [...fixes].reverse()) {
    const at = text.indexOf(fix.replace);
    if (!fix.replace || at < 0 || text.indexOf(fix.replace, at + fix.replace.length) >= 0) return null;
    text = text.slice(0, at) + fix.find + text.slice(at + fix.replace.length);
  }
  return text;
}
export async function installSoloRelease(client, release, { mode, resume = false, file } = {}) {
  await checkWriteMode(client, {});
  const allFixes = release.manifest.breakingChanges.flatMap(item => item.fixes);
  const fixPaths = new Set(allFixes.map(fix => fix.path));
  const ownPath = path => insideVendor(path) || path === 'src/main.tsx' || path === 'package.json' || fixPaths.has(path);
  const allowed = state => resume && Array.isArray(state?.pendingPaths) ? new Set(state.pendingPaths.filter(ownPath)) : null;
  const pending = (await client._driftState(Date.now() + 120000)).state;
  requireClean(pending, allowed(pending));
  if (resume && !pending.pendingCount) throw new Error(`No interrupted AtomicAUI ${mode} exists to resume.`);
  const pendingSet = new Set(pending.pendingPaths);
  const differs = path => { throw new Error(`Interrupted AtomicAUI ${mode} differs from the verified release: ${path}`); };
  const names = fileNames(await client.files());
  const hasVendor = [...names].some(insideVendor);
  if (mode === 'upgrade' && !hasVendor) throw new Error('AtomicAUI is not installed. Use add.');
  const scan = hasVendor ? await client.inventoryVendor(ATOMICAUI_ROOT, { includeBytes: true })
    : { inventory: new Map(), contents: new Map(), state: pending };
  requireClean(scan.state, allowed(scan.state));
  const vendor = JSON.parse(decode(release.files.get('VENDOR.json')));
  vendor.atomicauiRelease = { version: release.manifest.version, manifestSha256: release.manifestSha256, site: release.site };
  const vendorContent = format(vendor);
  const vendorPath = `${ATOMICAUI_ROOT}/VENDOR.json`;
  const currentVendor = scan.contents.get('VENDOR.json');
  const metadataDone = resume && pendingSet.has(vendorPath) && !!currentVendor && decode(currentVendor) === vendorContent;
  if (pendingSet.has(vendorPath) && !metadataDone) differs(vendorPath);
  const existing = scan.inventory;
  let before = { installed: false, version: null, files: new Map() };
  if (currentVendor && !metadataDone) {
    if (mode === 'add') throw new Error('AtomicAUI vendor folder already exists. Use upgrade.');
    const old = vendorManifest(currentVendor, ATOMICAUI_ROOT);
    for (const [path, item] of old.files) {
      const actual = existing.get(path);
      if (pendingSet.has(`${ATOMICAUI_ROOT}/${path}`)) continue;
      if (!actual || actual.sha256 !== item.sha256 || actual.bytes !== item.bytes) throw new Error(`Local AtomicAUI edit refuses upgrade: ${path}`);
    }
    before = { installed: true, version: JSON.parse(decode(currentVendor)).atomicauiRelease?.version || null, files: old.files };
  } else if (!currentVendor && mode === 'upgrade') throw new Error('AtomicAUI VENDOR.json is missing.');
  for (const [path, actual] of existing) {
    if (path === 'VENDOR.json') continue;
    const wanted = release.files.get(path);
    const matches = wanted && actual.sha256 === digest(wanted) && actual.bytes === wanted.length;
    if (pendingSet.has(`${ATOMICAUI_ROOT}/${path}`)) { if (!matches) differs(`${ATOMICAUI_ROOT}/${path}`); continue; }
    if (mode === 'add' && !metadataDone) throw new Error('AtomicAUI vendor folder already exists. Use upgrade.');
    if (metadataDone ? !matches : !before.files.has(path)) throw new Error(`AtomicAUI vendor has a local added file: ${path}`);
  }
  for (const path of pendingSet) {
    const rel = insideVendor(path) ? path.slice(ATOMICAUI_ROOT.length + 1) : null;
    if (!rel || rel === 'VENDOR.json') continue;
    if (release.files.has(rel) ? !existing.has(rel)
      : existing.has(rel) || mode !== 'upgrade' || !(metadataDone || before.files.has(rel))) differs(path);
  }
  const report = metadataDone && mode === 'upgrade'
    ? { from: null, to: release.manifest.version, resumed: true, added: [],
      changed: [...pendingSet].filter(path => insideVendor(path) && path !== vendorPath && release.files.has(path.slice(ATOMICAUI_ROOT.length + 1)))
        .map(path => path.slice(ATOMICAUI_ROOT.length + 1)).sort(),
      removed: [...pendingSet].filter(path => insideVendor(path) && !release.files.has(path.slice(ATOMICAUI_ROOT.length + 1)))
        .map(path => path.slice(ATOMICAUI_ROOT.length + 1)).sort(),
      breakingChanges: release.manifest.breakingChanges }
    : changeReport(before, release);
  const reads = new Map();
  const readCurrent = async path => {
    if (!reads.has(path)) reads.set(path, await client.read(path, { remote: true }));
    return reads.get(path);
  };
  const fixes = await planBreakingFixes(release.manifest, async path => {
    const current = (await readCurrent(path)).content;
    if (!pendingSet.has(path)) return current;
    const original = reverseFixes(allFixes.filter(fix => fix.path === path), current);
    if (original === null) differs(path);
    return original;
  });
  const main = await readCurrent('src/main.tsx');
  const pkg = await readCurrent('package.json');
  const wiring = providerChanges(fixes.get('src/main.tsx')?.content || main.content,
    fixes.get('package.json')?.content || pkg.content);
  const appWrites = new Map([...fixes].map(([path, entry]) => [path, entry.content]).concat([...wiring]));
  for (const [path, content] of appWrites) if (pendingSet.has(path) && (await readCurrent(path)).content !== content) differs(path);
  const writes = [...pendingSet];
  const write = async (path, content, expectedSha256, vendorTreeFallback = false) => {
    const result = await client.writeDurable(path, content, { expectedSha256, vendorTreeFallback });
    if (result.changed) writes.push(path);
  };
  try {
    for (const [path, bytes] of release.files) {
      if (path === 'VENDOR.json' || pendingSet.has(`${ATOMICAUI_ROOT}/${path}`)) continue;
      const actual = existing.get(path);
      if (actual && actual.sha256 === digest(bytes) && actual.bytes === bytes.length) continue;
      await write(`${ATOMICAUI_ROOT}/${path}`, decode(bytes), actual?.sha256, true);
    }
    for (const path of report.removed) {
      if (!existing.has(path)) continue;
      await client.deleteDurable(`${ATOMICAUI_ROOT}/${path}`, { expectedSha256: existing.get(path).sha256,
        vendorTreeFallback: true });
      writes.push(`${ATOMICAUI_ROOT}/${path}`);
    }
    for (const [path, content] of appWrites) {
      const current = await readCurrent(path);
      if (content !== current.content) await write(path, content, current.sha256);
    }
    if (!metadataDone) await write(vendorPath, vendorContent, existing.get('VENDOR.json')?.sha256, true);
  } catch (error) { error.completedWrites = writes.map(path => ({ path })); throw error; }
  const saved = await client.saveVersion(`AtomicAUI ${release.manifest.version} ${mode}`, [...new Set(writes)].sort());
  const verify = await client.inventoryVendor(ATOMICAUI_ROOT, { includeBytes: true });
  requireClean(verify.state);
  if (verify.inventory.size !== release.files.size) throw new Error('Saved AtomicAUI vendor file count differs.');
  for (const item of release.manifest.files) {
    if (item.path === 'VENDOR.json') continue;
    const actual = verify.inventory.get(item.path);
    if (!actual || actual.sha256 !== item.sha256 || actual.bytes !== item.bytes) throw new Error(`Saved AtomicAUI vendor differs: ${item.path}`);
  }
  const savedVendor = verify.contents.get('VENDOR.json');
  if (!savedVendor || JSON.parse(decode(savedVendor)).atomicauiRelease?.manifestSha256 !== release.manifestSha256) {
    throw new Error('Saved AtomicAUI release metadata differs.');
  }
  const preview = `figma-cli make preview --file ${file || 'KEY'}`;
  return { mode: 'solo', report, savedVersion: saved.versionNumber, savedGitSha: saved.gitSha,
    verification: 'saved-version-clean-pending; vendor-content-matched', preview,
    summary: `${changeSummary(report)} Saved as Make version ${saved.versionNumber}. Review the app in the Make Preview tab (${preview}).` };
}

export function registerAtomicaui(make, print, failure) {
  const report = value => {
    print(value);
    const notice = listenNotice(value?.listen);
    if (notice) console.error(notice);
  };
  const atomicaui = make.command('atomicaui').description('Release, add, upgrade or check the AtomicAUI library');
  atomicaui.command('release').description('Snapshot the kit vendor into a new immutable site release; publishing remains a Figma click')
    .requiredOption('--file <key>', 'Exact AtomicAUI 7.0 Make file key')
    .option('--version <X.Y.Z>', 'Release version; defaults to the next patch')
    .option('--resume', 'Verify and continue an interrupted, unsaved release of the exact --version')
    .option('--part-bytes <n>', 'Maximum base64 part and direct source size in bytes (default 524288)')
    .option('--breaking-notes <json-file>', 'JSON array of breaking notes and exact app fixes')
    .action(async options => {
      try {
        const breakingChanges = options.breakingNotes ? JSON.parse(readFileSync(resolve(options.breakingNotes), 'utf8')) : [];
        report(await withMake(options.file, client => releaseAtomicaui(client, { requestedVersion: options.version,
          breakingChanges, resume: options.resume, partBase64Bytes: options.partBytes === undefined ? undefined : Number(options.partBytes) })));
      }
      catch (error) { failure(error); }
    });
  atomicaui.command('verify-release').description('Read back the exact saved kit release path set and hashes')
    .requiredOption('--file <key>', 'Exact AtomicAUI 7.0 Make file key')
    .requiredOption('--version <X.Y.Z>', 'Saved release version')
    .action(async options => {
      try { report(await withMake(options.file, client => verifyAtomicauiRelease(client, options.version))); }
      catch (error) { failure(error); }
    });
  const install = mode => atomicaui.command(mode).description(`${mode === 'add' ? 'Install' : 'Upgrade'} AtomicAUI in a team clone or solo Make file`)
    .option('--file <key>', 'Exact solo Make file key; required for direct Make writes')
    .option('--dir <path>', 'Team-mode project clone (defaults to current directory)')
    .option(mode === 'add' ? '--version <X.Y.Z>' : '--to <X.Y.Z>', 'Pin a release version instead of latest')
    .option('--resume', `Continue an interrupted, unsaved solo ${mode} after verifying every pending file`)
    .action(async options => {
      try {
        if (options.file && options.dir) throw new Error('Use --file for solo Make or --dir for a team clone, not both.');
        if (options.resume && !options.file) throw new Error('--resume is only for a solo Make file with --file.');
        const release = await downloadRelease({ version: options.version || options.to });
        report(options.file ? await withMake(options.file, client => installSoloRelease(client, release, { mode, resume: options.resume, file: options.file }))
          : await installTeamRelease(options.dir || '.', release, { mode }));
      } catch (error) { failure(error); }
    });
  install('add'); install('upgrade');
  atomicaui.command('status').description('Installed version, local edits, and latest available version')
    .option('--file <key>', 'Exact solo Make file key')
    .option('--dir <path>', 'Team-mode clone (defaults to current directory)')
    .action(async options => {
      try {
        if (options.file && options.dir) throw new Error('Use --file or --dir, not both.');
        const latest = await latestRelease();
        if (!options.file) {
          const root = resolve(options.dir || '.');
          teamContext({ dir: root }).repo();
          const local = installedStatus(join(root, ATOMICAUI_ROOT));
          report({ mode: 'team', installedVersion: local.version, localEdits: local.localEdits, latestVersion: latest.version });
        } else report(await withMake(options.file, async client => {
          const names = fileNames(await client.files());
          if (![...names].some(path => path.startsWith(`${ATOMICAUI_ROOT}/`))) {
            return { mode: 'solo', installedVersion: null, localEdits: [], latestVersion: latest.version };
          }
          const scan = await client.inventoryVendor(ATOMICAUI_ROOT, { includeBytes: true });
          const vendorBytes = scan.contents.get('VENDOR.json');
          if (!vendorBytes) return { mode: 'solo', installedVersion: null, localEdits: ['VENDOR.json missing'], latestVersion: latest.version };
          const vendor = vendorManifest(vendorBytes, ATOMICAUI_ROOT);
          const edits = [];
          for (const [path, item] of vendor.files) {
            const actual = scan.inventory.get(path);
            if (!actual) edits.push(`missing ${path}`);
            else if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) edits.push(`changed ${path}`);
          }
          for (const path of scan.inventory.keys()) if (path !== 'VENDOR.json' && !vendor.files.has(path)) edits.push(`added ${path}`);
          return { mode: 'solo', installedVersion: JSON.parse(decode(vendorBytes)).atomicauiRelease?.version || null,
            localEdits: edits.sort(), latestVersion: latest.version, savedVersion: scan.state?.savedVersion || null };
        }));
      } catch (error) { failure(error); }
    });
}
