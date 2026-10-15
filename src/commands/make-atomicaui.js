import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MakeClient } from '../make-client.js';
import { checkWriteMode } from '../make-project.js';
import { teamContext, readProject, start, save, pr } from '../make-team.js';
import { digest, vendorManifest } from '../make-drift.js';
import { ATOMICAUI_ROOT, ATOMICAUI_SITE, RELEASE_ROOT, buildRelease, changeReport, downloadRelease,
  installRelease, installedStatus, latestRelease, nextPatch, planBreakingFixes, version } from '../make-atomicaui.js';

const format = value => `${JSON.stringify(value, null, 2)}\n`;
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const PUBLISH = [
  'Open the AtomicAUI 7.0 kit in Figma Make and click Publish.',
  'Set Who can view to Anyone with the link. Leave password protection off.',
  'Keep the existing sienna-khaki-58053801.figma.site address, publish, then close the dialog.',
];

function requireClean(state) {
  if (!state || state.mode !== 'git' || !state.hasBaseline || !/^[a-f0-9]{40}$/.test(state.savedVersion || '') ||
      state.isLoading || state.error || state.pendingCount !== 0 || !Array.isArray(state.pendingPaths) || state.pendingPaths.length) {
    throw new Error('AtomicAUI operation requires a clean saved git-mode Make version.');
  }
}
async function withMake(file, fn) {
  const client = new MakeClient({ timeoutMs: 120000 });
  try { await client.connect(file); return await fn(client); }
  finally { client.close(); }
}
function fileNames(tree) { return new Set(tree.filter(entry => entry.kind === 'file').map(entry => entry.path)); }

export async function releaseAtomicaui(client, { requestedVersion, breakingChanges = [] } = {}) {
  await checkWriteMode(client, {});
  requireClean((await client._driftState(Date.now() + 120000)).state);
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
  if ([...tree].some(path => path.startsWith(prefix))) throw new Error(`AtomicAUI ${selected} already exists. Release folders are immutable.`);
  const scan = await client.inventoryVendor(ATOMICAUI_ROOT, { includeBytes: true });
  requireClean(scan.state);
  const release = buildRelease({ inventory: scan.inventory, contents: scan.contents, version: selected, breakingChanges });
  const completed = [];
  try {
    for (const [path, bytes] of release.output) {
      const result = await client.writeDurable(path, decode(bytes), { expectedSha256: path === latestPath ? oldLatestHash : undefined });
      if (result.changed) completed.push(path);
    }
  } catch (error) {
    error.completedWrites = completed.map(path => ({ path }));
    throw error;
  }
  const expected = [...release.output.keys()].sort();
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
function reviewHtml(report) {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const list = (heading, paths) => `<section><h2>${heading} <small>${paths.length}</small></h2><ul>${paths.map(path => `<li>${escape(path)}</li>`).join('')}</ul></section>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AtomicAUI ${escape(report.to)} review</title><style>body{font:16px system-ui;margin:0;background:#f4f6f9;color:#17212e}main{max-width:1100px;margin:auto;padding:48px 24px}h1{font-size:2rem;margin:0 0 8px}p{color:#526071}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:32px 0}.cards div,section{background:white;border:1px solid #dbe2e9;border-radius:12px;padding:20px}.cards strong{display:block;font-size:2rem}section{margin:16px 0}small{color:#526071}ul{columns:2;overflow-wrap:anywhere;padding-left:22px}li{padding:3px 0}@media(max-width:700px){.cards{grid-template-columns:1fr}ul{columns:1}}</style><main><h1>AtomicAUI ${escape(report.to)}</h1><p>Library change review from ${escape(report.from || 'no installation')} to ${escape(report.to)}. Compare app screens in the pull request before merging.</p><div class="cards"><div><strong>${report.added.length}</strong>added files</div><div><strong>${report.changed.length}</strong>changed files</div><div><strong>${report.removed.length}</strong>removed files</div></div>${list('Added', report.added)}${list('Changed', report.changed)}${list('Removed', report.removed)}<section><h2>Breaking changes</h2><ul>${report.breakingChanges.map(item => `<li>${escape(typeof item === 'string' ? item : item.note)}</li>`).join('')}</ul></section></main></html>\n`;
}
export async function installTeamRelease(directory, release, { mode } = {}) {
  const root = resolve(directory);
  const project = readProject(root);
  if (!project.repo) throw new Error('No team-mode project marker in this clone. Use --file for a solo Make file.');
  const vendorDir = join(root, ATOMICAUI_ROOT);
  const preflight = installedStatus(vendorDir);
  if (preflight.localEdits.length) throw new Error(`Local AtomicAUI edits refuse ${mode}: ${preflight.localEdits.join(', ')}`);
  if (mode === 'add' && preflight.installed) throw new Error('AtomicAUI is already installed. Use upgrade.');
  if (mode === 'upgrade' && !preflight.installed) throw new Error('AtomicAUI is not installed. Use add.');
  if (!existsSync(join(root, 'src/main.tsx')) || !existsSync(join(root, 'package.json'))) {
    throw new Error('AtomicAUI needs src/main.tsx and package.json for provider wiring.');
  }
  const readSource = async path => existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null;
  await planBreakingFixes(release.manifest, readSource);
  const ctx = teamContext({ dir: root });
  const started = start(ctx, `atomicaui-${mode}-${release.manifest.version}`);
  const afterStart = installedStatus(vendorDir);
  if (afterStart.localEdits.length || (mode === 'add' ? afterStart.installed : !afterStart.installed)) {
    throw new Error('AtomicAUI project changed after starting the branch; install refused.');
  }
  const fixes = await planBreakingFixes(release.manifest, readSource);
  const report = installRelease(root, release);
  const wiring = providerChanges(fixes.get('src/main.tsx')?.content || readFileSync(join(root, 'src/main.tsx'), 'utf8'),
    fixes.get('package.json')?.content || readFileSync(join(root, 'package.json'), 'utf8'));
  for (const [path, entry] of fixes) {
    if (path !== 'src/main.tsx' && path !== 'package.json') writeFileSync(join(root, path), entry.content);
  }
  for (const [path, content] of wiring) if (readFileSync(join(root, path), 'utf8') !== content) writeFileSync(join(root, path), content);
  const reviewPath = join(root, 'docs/atomicaui-review.html');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(reviewPath, reviewHtml(report));
  const saved = save(ctx, { message: `Add AtomicAUI ${release.manifest.version} (${report.added.length} added, ${report.changed.length} changed, ${report.removed.length} removed)` });
  const pullRequest = pr(ctx, { title: `AtomicAUI ${release.manifest.version} ${mode}` });
  return { mode: 'team', branch: started.branch, report, reviewPath: 'docs/atomicaui-review.html', saved: saved.saved,
    pullRequest: pullRequest.url };
}

export async function installSoloRelease(client, release, { mode } = {}) {
  await checkWriteMode(client, {});
  requireClean((await client._driftState(Date.now() + 120000)).state);
  const names = fileNames(await client.files());
  const hasVendor = [...names].some(path => path.startsWith(`${ATOMICAUI_ROOT}/`));
  if (mode === 'add' && hasVendor) throw new Error('AtomicAUI vendor folder already exists. Use upgrade.');
  if (mode === 'upgrade' && !hasVendor) throw new Error('AtomicAUI is not installed. Use add.');
  let before = { installed: false, version: null, files: new Map(), localEdits: [] }, existing = new Map();
  if (hasVendor) {
    const scan = await client.inventoryVendor(ATOMICAUI_ROOT, { includeBytes: true });
    requireClean(scan.state);
    const vendorBytes = scan.contents.get('VENDOR.json');
    if (!vendorBytes) throw new Error('AtomicAUI VENDOR.json is missing.');
    const vendor = vendorManifest(vendorBytes, ATOMICAUI_ROOT);
    if (scan.inventory.size !== vendor.files.size + 1) throw new Error('AtomicAUI vendor has local added or missing files.');
    for (const [path, item] of vendor.files) {
      const actual = scan.inventory.get(path);
      if (!actual || actual.sha256 !== item.sha256 || actual.bytes !== item.bytes) throw new Error(`Local AtomicAUI edit refuses upgrade: ${path}`);
    }
    before = { installed: true, version: JSON.parse(decode(vendorBytes)).atomicauiRelease?.version || null, files: vendor.files, localEdits: [] };
    existing = scan.inventory;
  }
  const report = changeReport(before, release);
  const fixReads = new Map();
  const fixes = await planBreakingFixes(release.manifest, async path => {
    const read = await client.read(path, { remote: true });
    fixReads.set(path, read);
    return read.content;
  });
  const main = fixReads.get('src/main.tsx') || await client.read('src/main.tsx', { remote: true });
  const pkg = fixReads.get('package.json') || await client.read('package.json', { remote: true });
  const wiring = providerChanges(fixes.get('src/main.tsx')?.content || main.content,
    fixes.get('package.json')?.content || pkg.content);
  const vendor = JSON.parse(decode(release.files.get('VENDOR.json')));
  vendor.atomicauiRelease = { version: release.manifest.version, manifestSha256: release.manifestSha256, site: release.site };
  const writes = [];
  const write = async (path, content, expectedSha256) => {
    const result = await client.writeDurable(path, content, { expectedSha256 });
    if (result.changed) writes.push(path);
  };
  try {
    for (const [path, bytes] of release.files) {
      if (path === 'VENDOR.json') continue;
      await write(`${ATOMICAUI_ROOT}/${path}`, decode(bytes), existing.get(path)?.sha256);
    }
    for (const path of report.removed) {
      await client.deleteDurable(`${ATOMICAUI_ROOT}/${path}`, { expectedSha256: existing.get(path).sha256 });
      writes.push(`${ATOMICAUI_ROOT}/${path}`);
    }
    await write(`${ATOMICAUI_ROOT}/VENDOR.json`, format(vendor), existing.get('VENDOR.json')?.sha256);
    for (const [path, entry] of fixes) {
      if (path !== 'src/main.tsx' && path !== 'package.json') await write(path, entry.content, fixReads.get(path).sha256);
    }
    for (const [path, content] of wiring) {
      const original = path === 'src/main.tsx' ? main : pkg;
      if (content !== original.content) await write(path, content, original.sha256);
    }
  } catch (error) { error.completedWrites = writes.map(path => ({ path })); throw error; }
  const saved = await client.saveVersion(`AtomicAUI ${release.manifest.version} ${mode}`, writes.sort());
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
  return { mode: 'solo', report, savedVersion: saved.versionNumber, savedGitSha: saved.gitSha,
    verification: 'saved-version-clean-pending; vendor-content-matched' };
}

export function registerAtomicaui(make, report, failure) {
  const atomicaui = make.command('atomicaui').description('Release, add, upgrade or check the AtomicAUI library');
  atomicaui.command('release').description('Snapshot the kit vendor into a new immutable site release; publishing remains a Figma click')
    .requiredOption('--file <key>', 'Exact AtomicAUI 7.0 Make file key')
    .option('--version <X.Y.Z>', 'Release version; defaults to the next patch')
    .option('--breaking-notes <json-file>', 'JSON array of breaking notes and exact app fixes')
    .action(async options => {
      try {
        const breakingChanges = options.breakingNotes ? JSON.parse(readFileSync(resolve(options.breakingNotes), 'utf8')) : [];
        report(await withMake(options.file, client => releaseAtomicaui(client, { requestedVersion: options.version, breakingChanges })));
      }
      catch (error) { failure(error); }
    });
  const install = mode => atomicaui.command(mode).description(`${mode === 'add' ? 'Install' : 'Upgrade'} AtomicAUI in a team clone or solo Make file`)
    .option('--file <key>', 'Exact solo Make file key; required for direct Make writes')
    .option('--dir <path>', 'Team-mode project clone (defaults to current directory)')
    .option(mode === 'add' ? '--version <X.Y.Z>' : '--to <X.Y.Z>', 'Pin a release version instead of latest')
    .action(async options => {
      try {
        if (options.file && options.dir) throw new Error('Use --file for solo Make or --dir for a team clone, not both.');
        const release = await downloadRelease({ version: options.version || options.to });
        report(options.file ? await withMake(options.file, client => installSoloRelease(client, release, { mode }))
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
          if (!readProject(root).repo) throw new Error('No team project marker here. Pass --file for a solo Make file.');
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
