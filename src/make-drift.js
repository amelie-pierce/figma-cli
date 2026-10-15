import { createHash } from 'node:crypto';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const driftExitCode = result => result.ok ? 0 : 1;
export const isAtomicauiReleasePath = path => path === 'public/atomicaui' || path.startsWith('public/atomicaui/');
const HASH = /^[a-f0-9]{64}$/;

export function sourcePath(path) {
  if (typeof path !== 'string' || !path || path.length > 512 || path.startsWith('/') ||
      path.split('/').some(part => !part || part === '.' || part === '..' || part.trim() !== part) ||
      /[\\:\u0000-\u001f\u007f]/.test(path)) {
    throw new Error('Use an unambiguous project-relative Make path.');
  }
  return path;
}

export function vendorManifest(bytes, root = 'src/vendor/atomic-aui') {
  sourcePath(root);
  if (!Buffer.isBuffer(bytes) || bytes.length > 32 * 1024 * 1024) throw new Error('Vendor manifest must be at most 32 MiB.');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Vendor manifest is not valid UTF-8 JSON.'); }
  if (!value || !Array.isArray(value.files) || !value.files.length || value.files.length > 10000) {
    throw new Error('Vendor manifest needs 1–10000 files.');
  }
  const files = new Map();
  const folded = new Set();
  for (const file of value.files) {
    const path = sourcePath(file?.path);
    if (path === 'VENDOR.json') throw new Error('Vendor manifest cannot list itself.');
    const key = path.toLowerCase();
    if (folded.has(key)) throw new Error(`Duplicate or case-ambiguous vendor path: ${path}`);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !HASH.test(file.sha256)) {
      throw new Error(`Vendor manifest has invalid byte count or SHA-256: ${path}`);
    }
    folded.add(key);
    files.set(path, { path, bytes: file.bytes, sha256: file.sha256 });
  }
  return { root, files, sha256: digest(bytes), bytes: bytes.length };
}

export function externalReceipt(bytes, { fileKey, manifestSha256 }) {
  if (bytes == null) return null;
  if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024) throw new Error('External receipt must be at most 1 MiB.');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('External receipt is not valid UTF-8 JSON.'); }
  if (value?.fileKey !== fileKey || value?.manifestSha256 !== manifestSha256 ||
      typeof value?.savedVersionGitSha !== 'string' || !/^[a-f0-9]{40}$/.test(value.savedVersionGitSha)) {
    throw new Error('External receipt must pin the exact Make file key, manifest SHA-256 and full saved git SHA.');
  }
  return { fileKey, manifestSha256, savedVersionGitSha: value.savedVersionGitSha };
}

export function compareVendor(manifest, inventory, { manifestFile, stateBefore, stateAfter, receipt } = {}) {
  const files = [];
  const counts = { matched: 0, mismatched: 0, missing: 0, extra: 0 };
  const paths = new Set([...manifest.files.keys(), ...inventory.keys()].filter(path => !isAtomicauiReleasePath(path)));
  paths.delete('VENDOR.json');
  for (const path of [...paths].sort()) {
    const expected = manifest.files.get(path);
    const actual = inventory.get(path);
    const status = !expected ? 'extra' : !actual ? 'missing'
      : expected.bytes === actual.bytes && expected.sha256 === actual.sha256 ? 'matched' : 'mismatched';
    counts[status]++;
    files.push({ path, status, ...(expected ? { expected } : {}), ...(actual ? { actual } : {}) });
  }
  const reasons = [];
  if (!manifestFile) reasons.push('VENDOR.json is missing from the Make root');
  else if (manifestFile.sha256 !== manifest.sha256 || manifestFile.bytes !== manifest.bytes) {
    reasons.push('Make VENDOR.json differs from the supplied manifest');
  }
  if (counts.mismatched || counts.missing || counts.extra) reasons.push('Vendor inventory differs from the manifest');
  if (!stateBefore || !stateAfter) reasons.push('Make saving mode or pending state is unavailable');
  else {
    if (JSON.stringify(stateBefore) !== JSON.stringify(stateAfter)) reasons.push('Make version or pending state changed during inventory');
    if (stateAfter.isLoading || stateAfter.error) reasons.push('Make pending-state check is incomplete');
    if (!stateAfter.hasBaseline || !/^[a-f0-9]{40}$/.test(stateAfter.savedVersion || '')) {
      reasons.push('Saved Make version is unverified');
    }
    if (stateAfter.pendingCount !== 0) reasons.push('Make has pending changes');
    if (stateAfter.mode !== 'git') reasons.push('Snapshot-mode persistence is unverified');
    if (receipt && receipt.savedVersionGitSha !== stateAfter.savedVersion) reasons.push('External receipt saved version differs');
  }
  return { ok: reasons.length === 0, reasons, root: manifest.root,
    manifest: { sha256: manifest.sha256, bytes: manifest.bytes, inMake: manifestFile || null },
    receipt: receipt ? { matched: receipt.savedVersionGitSha === stateAfter?.savedVersion,
      savedVersionGitSha: receipt.savedVersionGitSha } : null,
    persistence: stateAfter || null, counts, files };
}

export function verifyGeneratedManifest(bytes, inventory) {
  if (!Buffer.isBuffer(bytes)) throw new Error('Generated manifest is missing.');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Generated manifest is not valid UTF-8 JSON.'); }
  if (value?.schema !== 'atomic-cli/generated-manifest@1' || !Array.isArray(value.files) ||
      !value.tree || value.files.length > 10000) throw new Error('Generated manifest has an unsupported schema.');
  const recorded = new Map();
  for (const file of value.files) {
    const path = sourcePath(file?.path);
    if (recorded.has(path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !HASH.test(file.sha256)) {
      throw new Error(`Invalid generated manifest entry: ${path}`);
    }
    recorded.set(path, file);
  }
  for (const required of ['.generated', 'splash-bootstrap.js']) {
    if (!recorded.has(required)) throw new Error(`Generated manifest omits required file: ${required}`);
  }
  const sorted = [...recorded.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const summary = { fileCount: sorted.length, bytes: sorted.reduce((n, f) => n + f.bytes, 0),
    digest: digest(sorted.map(f => `${f.path}\t${f.bytes}\t${f.sha256}\n`).join('')) };
  if (summary.fileCount !== value.tree.fileCount || summary.bytes !== value.tree.bytes ||
      summary.digest !== value.tree.digest) throw new Error('Generated manifest summary is inconsistent.');
  const actual = new Map([...inventory].filter(([path]) => path.startsWith('tokens/generated/'))
    .map(([path, entry]) => [path.slice('tokens/generated/'.length), entry]));
  if (actual.size !== recorded.size) throw new Error('Generated tree has missing or extra files.');
  for (const [path, expected] of recorded) {
    const file = actual.get(path);
    if (!file || file.bytes !== expected.bytes || file.sha256 !== expected.sha256) {
      throw new Error(`Generated tree differs from manifest: ${path}`);
    }
  }
  return summary;
}
