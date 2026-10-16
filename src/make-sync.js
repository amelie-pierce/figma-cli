import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { digest, isAtomicauiReleasePath, sourcePath, vendorManifest, verifyGeneratedManifest } from './make-drift.js';
import { requireGitMode } from './make-durable.js';

const HASH = /^[a-f0-9]{64}$/;
const exactText = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const COMMIT = /^[a-f0-9]{40}$/;
export const VENDOR_ROOT = 'src/vendor/atomic-aui';
export const GENERATED = 'tokens/generated/';
export const GENERATION_MANIFEST = 'tokens/generated.manifest.json';

function json(bytes, label) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${label} is not valid UTF-8 JSON.`); }
}
function fullPath(relative) { return `${VENDOR_ROOT}/${relative}`; }
function relativePath(path) {
  sourcePath(path);
  if (!path.startsWith(`${VENDOR_ROOT}/`)) throw new Error(`Out-of-scope Make path: ${path}`);
  const relative = path.slice(VENDOR_ROOT.length + 1);
  if (relative === 'VENDOR.json') throw new Error('VENDOR.json is sync-owned metadata.');
  return relative;
}
function fileInfo(bytes) { return bytes == null ? null : { bytes: bytes.length, sha256: digest(bytes) }; }
function same(a, b) { return (a?.sha256 ?? null) === (b?.sha256 ?? null) && (a?.bytes ?? null) === (b?.bytes ?? null); }

// Read an artifact without following symlinks under its declared root.
export function readArtifact(root, path) {
  if (lstatSync(resolve(root)).isSymbolicLink()) throw new Error('Artifact root symlink refused.');
  const base = realpathSync(resolve(root));
  if (!lstatSync(base).isDirectory()) throw new Error('Artifact root must be a directory.');
  sourcePath(path);
  let at = base;
  for (const part of path.split('/')) {
    at = join(at, part);
    const stat = lstatSync(at);
    if (stat.isSymbolicLink()) throw new Error(`Artifact symlink refused: ${path}`);
  }
  if (!at.startsWith(`${base}${sep}`) || !lstatSync(at).isFile()) throw new Error(`Artifact file is not regular: ${path}`);
  return readFileSync(at);
}

export function parsePackage(packageDir) {
  const raw = readArtifact(packageDir, 'make-kit.manifest.json');
  const packageManifest = json(raw, 'Make kit package');
  if (packageManifest?.schema !== 'atomic-cli/make-kit-package@1' ||
      packageManifest.destination?.root !== `${VENDOR_ROOT}/tokens/generated` ||
      packageManifest.source?.root !== 'modules/design/atomic-aui/src/tokens/generated' ||
      !COMMIT.test(packageManifest.source?.commit || '') ||
      packageManifest.generationManifest?.path !== 'modules/design/atomic-aui/src/tokens/generated.manifest.json' ||
      !HASH.test(packageManifest.generationManifest?.sha256 || '') ||
      !Array.isArray(packageManifest.files) || !packageManifest.files.length) {
    throw new Error('Make kit package lacks a bound committed generated tree.');
  }
  const files = new Map();
  const folded = new Set();
  for (const file of packageManifest.files) {
    const path = sourcePath(file?.path);
    if (folded.has(path.toLowerCase()) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !HASH.test(file.sha256)) {
      throw new Error(`Invalid package file: ${path}`);
    }
    folded.add(path.toLowerCase());
    const bytes = readArtifact(packageDir, `${packageManifest.destination.root}/${path}`);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error(`Package file changed: ${path}`);
    files.set(path, bytes);
  }
  const sorted = [...packageManifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const tree = { fileCount: sorted.length, bytes: sorted.reduce((n, f) => n + f.bytes, 0),
    digest: digest(sorted.map(f => `${f.path}\t${f.bytes}\t${f.sha256}\n`).join('')) };
  if (tree.fileCount !== packageManifest.tree?.fileCount || tree.bytes !== packageManifest.tree?.bytes ||
      tree.digest !== packageManifest.tree?.digest) throw new Error('Package tree summary is inconsistent.');
  if (!files.has('.generated') || !files.has('splash-bootstrap.js')) {
    throw new Error('Package is missing a required generated-tree artifact.');
  }
  const expected = new Set(['make-kit.manifest.json', ...[...files.keys()].map(path => `${packageManifest.destination.root}/${path}`)]);
  const visit = (directory, relative = '') => {
    for (const name of readdirSync(directory)) {
      const path = relative ? `${relative}/${name}` : name;
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Package symlink refused: ${path}`);
      if (stat.isDirectory()) visit(absolute, path);
      else if (!stat.isFile() || !expected.delete(path)) throw new Error(`Unexpected package file: ${path}`);
    }
  };
  visit(resolve(packageDir));
  if (expected.size) throw new Error(`Package files are missing: ${[...expected].join(', ')}`);
  return { manifest: packageManifest, files, sha256: digest(raw) };
}

export function parseRequest(bytes, fileKey) {
  const request = json(bytes, 'Sync request');
  if (request?.schema !== 'figma-cli/make-sync-request@1' || request.fileKey !== fileKey ||
      typeof request.who !== 'string' || !request.who.trim() ||
      typeof request.requestId !== 'string' || !request.requestId.trim() ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(request.requestedAt || '') ||
      new Date(request.requestedAt).toISOString() !== request.requestedAt ||
      typeof request.direction !== 'string' ||
      !COMMIT.test(request.workspaceCommit || '') ||
      !Array.isArray(request.files) || !request.files.length || request.files.length > 1000 ||
      typeof request.choices !== 'object' || request.choices === null) {
    throw new Error('Sync request must record identity, direction, exact files and conflict choices.');
  }
  if (request.direction !== 'workspace-to-make') {
    throw new Error('make sync only applies workspace-to-make. Export Make changes with make export-delta, then use workspace intake-make-delta and a reviewed workspace PR.');
  }
  const paths = new Set();
  const folded = new Set();
  for (const file of request.files) {
    const path = relativePath(file?.path);
    if (folded.has(path.toLowerCase())) throw new Error(`Duplicate or case-ambiguous sync path: ${file.path}`);
    paths.add(path);
    folded.add(path.toLowerCase());
    for (const key of ['baselineSha256', 'workspaceSha256']) {
      if (file[key] !== null && !HASH.test(file[key] || '')) throw new Error(`Invalid ${key}: ${file.path}`);
    }
    if (!Array.isArray(file.dependencies)) throw new Error(`Explicit dependencies required: ${file.path}`);
  }
  for (const file of request.files) for (const dep of file.dependencies) {
    if (!paths.has(relativePath(dep))) throw new Error(`Dependency absent from exact scope: ${dep}`);
  }
  for (const path of Object.keys(request.choices)) if (!paths.has(relativePath(path))) {
    throw new Error(`Choice is outside exact scope: ${path}`);
  }
  return request;
}

function reviewDiff(before, after) {
  if (!before || !after || before.length > 16384 || after.length > 16384) return null;
  let a, b;
  try { a = new TextDecoder('utf-8', { fatal: true }).decode(before); b = new TextDecoder('utf-8', { fatal: true }).decode(after); }
  catch { return null; }
  if (a.includes('\0') || b.includes('\0')) return null;
  const left = a.split('\n'), right = b.split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left.at(-suffix - 1) === right.at(-suffix - 1)) suffix++;
  return { beforeLine: prefix + 1, removed: left.slice(prefix, left.length - suffix), added: right.slice(prefix, right.length - suffix) };
}

export function planSync({ request, requestSha256, packageData, baselineBytes, candidateDir, generationManifestBytes,
  inventory, contents, state, fileKey }) {
  requireGitMode(state);
  if (state.pendingCount !== 0 || state.pendingPaths.length) throw new Error('Unsaved Make changes refuse sync.');
  const baseline = vendorManifest(baselineBytes, VENDOR_ROOT);
  if (request.workspaceCommit !== packageData.manifest.source.commit) throw new Error('Request workspace commit differs from package commit.');
  if (!same(inventory.get('VENDOR.json'), fileInfo(baselineBytes))) throw new Error('Make VENDOR.json differs from the trusted baseline.');
  const packaged = new Map([...packageData.files].map(([path, bytes]) => [`${GENERATED}${path}`, fileInfo(bytes)]));
  const currentTokens = new Map([...inventory].filter(([path]) => path.startsWith(GENERATED)));
  const scope = new Set(request.files.map(file => relativePath(file.path)));
  const outOfScopeDrift = [...new Set([...baseline.files.keys(), ...inventory.keys()])]
    .filter(path => !isAtomicauiReleasePath(path) && path !== 'VENDOR.json' && !scope.has(path) &&
      !same(baseline.files.get(path), inventory.get(path)))
    .sort();
  const tokenScope = [...scope].some(path => path.startsWith(GENERATED) || path === GENERATION_MANIFEST);
  if (tokenScope) {
    for (const path of new Set([...packaged.keys(), GENERATION_MANIFEST])) {
      if (!scope.has(path)) throw new Error(`Token sync scope must include ${fullPath(path)}.`);
    }
    for (const path of currentTokens.keys()) if (!packaged.has(path) && !scope.has(path)) {
      throw new Error(`Generated tree has an extra path outside sync scope: ${path}`);
    }
    if (!generationManifestBytes || digest(generationManifestBytes) !== packageData.manifest.generationManifest.sha256) {
      throw new Error('Core generation manifest is missing or differs from package provenance.');
    }
    verifyGeneratedManifest(generationManifestBytes, new Map([...packaged]));
  } else {
    if (currentTokens.size !== packaged.size) throw new Error('Generated token path set differs from package.');
    for (const [path, expected] of packaged) if (!same(currentTokens.get(path), expected)) {
      throw new Error(`Generated tokens differ from Core package: ${path}`);
    }
    // Older kits carry the generated tree but not its manifest file. The
    // committed package may supply that exact manifest for read-only proof.
    const manifest = contents.get(GENERATION_MANIFEST) || generationManifestBytes;
    if (!manifest || digest(manifest) !== packageData.manifest.generationManifest.sha256) {
      throw new Error('Make generated.manifest.json differs from Core package.');
    }
    verifyGeneratedManifest(manifest, inventory);
  }
  const actions = [];
  const unresolved = [];
  const expected = new Map(baseline.files);
  for (const file of request.files) {
    const path = relativePath(file.path);
    const B = baseline.files.get(path) || null;
    if ((B?.sha256 ?? null) !== file.baselineSha256) throw new Error(`Baseline hash differs for ${file.path}.`);
    const M = inventory.get(path) || null;
    let workspaceBytes = null;
    if (path.startsWith(GENERATED)) {
      workspaceBytes = packageData.files.get(path.slice(GENERATED.length)) || null;
    } else if (path === GENERATION_MANIFEST) {
      workspaceBytes = generationManifestBytes;
    } else if (file.workspaceSha256 !== null) {
      workspaceBytes = readArtifact(candidateDir, file.path);
    }
    const W = fileInfo(workspaceBytes);
    if ((W?.sha256 ?? null) !== file.workspaceSha256) throw new Error(`Workspace candidate hash differs for ${file.path}.`);
    const equivalent = same(M, W);
    const sourceOnly = same(M, B) && !same(W, B);
    const conflict = !equivalent && !sourceOnly;
    const kind = equivalent ? 'identical' : sourceOnly ? 'source-only' : same(W, B) ? 'destination-only' :
      !B && M && W ? 'same-path-addition' : B && !M && W ? 'delete-edit' :
      B && M && !W ? 'edit-delete' : 'two-sided';
    const choice = request.choices[file.path] || null;
    let chosen = W;
    let resultBytes = workspaceBytes;
    if (conflict) {
      if (!choice || choice.action === 'stop') { unresolved.push(file.path); chosen = M; resultBytes = contents.get(path) || null; }
      else if (choice.action === 'override-workspace') { chosen = M; resultBytes = contents.get(path) || null; }
      else if (choice.action === 'override-make') { /* source candidate wins by explicit choice */ }
      else if (choice.action === 'merged') {
        if (!HASH.test(choice.expectedSha256 || '')) throw new Error(`Merged result needs expected SHA-256: ${file.path}`);
        resultBytes = readArtifact(candidateDir, choice.file);
        chosen = fileInfo(resultBytes);
        if (chosen.sha256 !== choice.expectedSha256) throw new Error(`Merged result hash differs: ${file.path}`);
      } else throw new Error(`Unknown conflict choice: ${file.path}`);
    } else if (choice) throw new Error(`Choice supplied for nonconflict: ${file.path}`);
    if (path.startsWith(GENERATED) || path === GENERATION_MANIFEST) {
      if (conflict && choice && choice.action !== 'override-make' && choice.action !== 'stop') {
        throw new Error(`Core tokens cannot accept a Make-authored result: ${file.path}`);
      }
    }
    if (chosen) expected.set(path, { path, ...chosen }); else expected.delete(path);
    actions.push({ path: file.path, kind, conflict, choice, baseline: B, before: M, workspace: W,
      after: chosen, operation: same(M, chosen) ? 'keep' : chosen ? 'write' : 'delete',
      diff: reviewDiff(contents.get(path) || null, resultBytes) });
  }
  const finalTokens = new Map([...expected].filter(([path]) => path.startsWith(GENERATED)));
  const manifestBytes = scope.has(GENERATION_MANIFEST) ? generationManifestBytes :
    (contents.get(GENERATION_MANIFEST) || generationManifestBytes);
  if (!unresolved.length) verifyGeneratedManifest(manifestBytes, finalTokens);
  const sameBaseline = expected.size === baseline.files.size && [...expected]
    .every(([path, entry]) => same(entry, baseline.files.get(path)));
  let vendorBytes = sameBaseline ? baselineBytes : Buffer.from(`${JSON.stringify({ ...JSON.parse(baselineBytes.toString('utf8')),
    files: [...expected.values()].filter(file => file.path !== 'VENDOR.json')
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }, null, 2)}\n`);
  // A full workspace vendor candidate carries the source commit and date as
  // well as the file inventory. Accept its exact bytes only when every other
  // metadata field and every planned file entry is unchanged or reviewed.
  const candidateVendorPath = join(resolve(candidateDir), VENDOR_ROOT, 'VENDOR.json');
  if (lstatSync(candidateVendorPath, { throwIfNoEntry: false })?.isFile()) {
    const candidateBytes = readArtifact(candidateDir, `${VENDOR_ROOT}/VENDOR.json`);
    const candidate = json(candidateBytes, 'Workspace VENDOR.json');
    const original = json(baselineBytes, 'Trusted VENDOR.json');
    const candidateSource = candidate.source;
    const originalSource = original.source;
    const candidateOther = { ...candidate };
    const originalOther = { ...original };
    delete candidateOther.source;
    delete candidateOther.files;
    delete originalOther.source;
    delete originalOther.files;
    if (JSON.stringify(candidateOther) !== JSON.stringify(originalOther) ||
        candidateSource?.repository !== originalSource?.repository ||
        candidateSource?.path !== originalSource?.path ||
        candidateSource?.commit !== request.workspaceCommit ||
        typeof candidateSource?.commitDate !== 'string' ||
        JSON.stringify({ ...candidateSource, commit: originalSource.commit, commitDate: originalSource.commitDate }) !== JSON.stringify(originalSource)) {
      throw new Error('Workspace VENDOR.json metadata differs outside source commit and date.');
    }
    const parsed = vendorManifest(candidateBytes, VENDOR_ROOT);
    if (parsed.files.size !== expected.size || [...expected].some(([path, entry]) => !same(entry, parsed.files.get(path)))) {
      throw new Error('Workspace VENDOR.json file inventory differs from reviewed sync result.');
    }
    vendorBytes = candidateBytes;
  }
  const vendorAfter = fileInfo(vendorBytes);
  const plan = { schema: 'figma-cli/make-sync-plan@1', fileKey, requestId: request.requestId, who: request.who,
    requestedAt: request.requestedAt, direction: request.direction, workspaceCommit: packageData.manifest.source.commit,
    makeVersion: state.savedVersion, requestSha256, packageSha256: packageData.sha256,
    baselineManifestSha256: digest(baselineBytes), beforeInventory: [...inventory.values()]
      .filter(file => !isAtomicauiReleasePath(file.path)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    candidateDir: resolve(candidateDir), scope: request.files.map(file => ({ ...file })), actions, unresolved, outOfScopeDrift,
    vendorBefore: inventory.get('VENDOR.json'), vendorAfter, generatedTreeDigest: packageData.manifest.tree.digest };
  plan.digest = digest(JSON.stringify(plan));
  return { plan, vendorBytes };
}

export function validatePlanDigest(plan) {
  if (plan?.schema !== 'figma-cli/make-sync-plan@1' || !HASH.test(plan.digest || '')) throw new Error('Invalid sync plan.');
  const { digest: recorded, ...body } = plan;
  if (digest(JSON.stringify(body)) !== recorded) throw new Error('Sync plan digest mismatch.');
  return plan;
}

function readCandidate(candidateDir, path) {
  try { return readArtifact(candidateDir, path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function exportDelta({ inventory, contents, baselineBytes, candidateDir, state, fileKey, who, paths, dependencyPaths = [] }) {
  requireGitMode(state);
  if (!lstatSync(resolve(candidateDir), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Export --candidate-dir must be an existing directory.');
  }
  if (state.pendingCount !== 0 || state.pendingPaths.length) throw new Error('Unsaved Make changes refuse export.');
  if (!who?.trim()) throw new Error('Export requires --who.');
  const baseline = vendorManifest(baselineBytes, VENDOR_ROOT);
  if (!same(inventory.get('VENDOR.json'), fileInfo(baselineBytes))) throw new Error('Make VENDOR.json differs from trusted baseline.');
  const selected = paths?.length ? new Set(paths.map(relativePath)) : null;
  const dependencies = new Set(dependencyPaths.map(relativePath));
  const all = new Set([...baseline.files.keys(), ...inventory.keys()].filter(path => !isAtomicauiReleasePath(path)));
  all.delete('VENDOR.json');
  const files = [];
  for (const path of [...all].sort()) {
    if (path === GENERATION_MANIFEST || path.startsWith(GENERATED)) {
      if (!same(baseline.files.get(path), inventory.get(path))) throw new Error(`Generated token change cannot be exported: ${path}`);
      if (dependencies.has(path)) throw new Error(`Generated token cannot be a component dependency: ${path}`);
      continue;
    }
    if (selected && !selected.has(path) && !dependencies.has(path)) continue;
    const before = baseline.files.get(path) || null;
    const after = inventory.get(path) || null;
    if (same(before, after) && !dependencies.has(path)) continue;
    const workspace = fileInfo(readCandidate(candidateDir, fullPath(path)));
    files.push({ path: fullPath(path), status: same(before, after) ? 'dependency' : !before ? 'added' : !after ? 'deleted' : 'changed',
      before, after, workspace, conflict: !same(workspace, before),
      ...(after ? { contentBase64: contents.get(path).toString('base64') } : {}) });
  }
  if (contents.has(GENERATION_MANIFEST)) verifyGeneratedManifest(contents.get(GENERATION_MANIFEST), inventory);
  if (selected && [...selected].some(path => !all.has(path))) throw new Error('Selected path is absent from baseline and Make.');
  if ([...dependencies].some(path => !all.has(path) || !inventory.has(path))) throw new Error('Dependency is absent from saved Make.');
  if (!files.length) throw new Error('No exportable saved changes in scope.');
  return { schema: 'figma-cli/make-delta@1', who, make: { fileKey, savedVersionGitSha: state.savedVersion },
    baselineManifestSha256: digest(baselineBytes), conflicts: files.filter(file => file.conflict).map(file => file.path), files };
}

export async function applySync(client, { plan, vendorBytes, packageData, candidateDir, generationManifestBytes, title, backupDir }) {
  if (plan.unresolved.length) throw new Error(`Unresolved sync conflicts: ${plan.unresolved.join(', ')}`);
  if (plan.outOfScopeDrift.length) throw new Error(`Out-of-scope Make drift needs separate reconciliation: ${plan.outOfScopeDrift.join(', ')}`);
  if (plan.actions.some(action => action.choice?.action === 'override-workspace')) {
    throw new Error('Override-workspace requires workspace review and a new committed package before Make apply.');
  }
  const changed = plan.actions.filter(action => action.operation !== 'keep');
  if (!changed.length && plan.vendorBefore.sha256 === plan.vendorAfter.sha256) throw new Error('Sync has no Make changes to save.');
  const prepared = changed.map(action => {
    if (action.operation === 'delete') return { action, content: null };
    const relative = action.path.slice(`${VENDOR_ROOT}/`.length);
    let bytes;
    if (relative.startsWith(GENERATED)) bytes = packageData.files.get(relative.slice(GENERATED.length));
    else if (relative === GENERATION_MANIFEST) bytes = generationManifestBytes;
    else if (action.choice?.action === 'merged') bytes = readArtifact(candidateDir, action.choice.file);
    else bytes = readArtifact(candidateDir, action.path);
    if (!bytes || !same(fileInfo(bytes), action.after)) throw new Error(`Planned bytes changed before write: ${action.path}`);
    try { return { action, content: exactText(bytes) }; }
    catch { throw new Error(`Planned bytes are not valid UTF-8: ${action.path}`); }
  });
  const vendorContent = plan.vendorBefore.sha256 !== plan.vendorAfter.sha256 ? exactText(vendorBytes) : null;
  const writes = [];
  try {
    for (const { action, content } of prepared) {
      const result = action.operation === 'delete'
        ? await client.deleteDurable(action.path, { expectedSha256: action.before.sha256, backupDir, vendorTreeFallback: true })
        : await client.writeDurable(action.path, content, { expectedSha256: action.before?.sha256, backupDir,
          vendorTreeFallback: true });
      writes.push({ path: action.path, before: action.before, after: action.after, backupPath: result.backupPath });
    }
    if (vendorContent !== null) {
      const result = await client.writeDurable(`${VENDOR_ROOT}/VENDOR.json`, vendorContent,
        { expectedSha256: plan.vendorBefore.sha256, backupDir, vendorTreeFallback: true });
      writes.push({ path: `${VENDOR_ROOT}/VENDOR.json`, before: plan.vendorBefore,
        after: plan.vendorAfter, backupPath: result.backupPath });
    }
    const version = await client.saveVersion(title, writes.map(write => write.path));
    const drift = await client.drift(vendorBytes);
    if (!drift.ok) {
      const error = new Error(`Make version ${version.versionNumber} saved but final drift failed: ${drift.reasons.join('; ')}`);
      error.version = version;
      throw error;
    }
    return { version, drift, writes };
  } catch (error) {
    error.completedWrites = writes;
    throw error;
  }
}

export function afterManifestPath(receiptPath) {
  return `${receiptPath.replace(/\.json$/, '')}.VENDOR.json`;
}

export function writeApplyOutputs(receiptPath, receipt, vendorBytes) {
  const manifestPath = vendorBytes ? afterManifestPath(receiptPath) : null;
  if (manifestPath) writeFileSync(manifestPath, vendorBytes, { mode: 0o600, flag: 'wx' });
  writeFileSync(receiptPath, `${JSON.stringify({ ...receipt,
    ...(manifestPath ? { afterManifestPath: manifestPath, afterManifestSha256: digest(vendorBytes) } : {}) }, null, 2)}\n`,
  { mode: 0o600, flag: 'wx' });
  return manifestPath;
}
