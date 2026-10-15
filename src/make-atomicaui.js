import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, lstatSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { sourcePath, vendorManifest } from './make-drift.js';

export const ATOMICAUI_SITE = 'https://sienna-khaki-58053801.figma.site';
export const ATOMICAUI_ROOT = 'src/vendor/atomic-aui';
export const RELEASE_ROOT = 'public/atomicaui';
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_PART = Math.floor(MAX_TEXT / 4) * 3;
const MAX_ARCHIVE = 128 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export function version(value) {
  if (!VERSION.test(value || '')) throw new Error('AtomicAUI version must be X.Y.Z.');
  return value;
}
export function nextPatch(value) {
  const parts = version(value).split('.').map(Number);
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function octal(number, width) {
  const value = number.toString(8);
  if (value.length > width - 1) throw new Error('AtomicAUI archive entry is too large.');
  return `${value.padStart(width - 1, '0')}\0`;
}
function tarPath(path) {
  sourcePath(path);
  const bytes = Buffer.byteLength(path);
  if (bytes <= 100) return [path, ''];
  const at = path.lastIndexOf('/');
  if (at < 0 || Buffer.byteLength(path.slice(at + 1)) > 100 || Buffer.byteLength(path.slice(0, at)) > 155) {
    throw new Error(`AtomicAUI archive path is too long: ${path}`);
  }
  return [path.slice(at + 1), path.slice(0, at)];
}

export function packArchive(files) {
  const blocks = [];
  for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const [name, prefix] = tarPath(path);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write(octal(0o644, 8), 100, 8, 'ascii');
    header.write(octal(0, 8), 108, 8, 'ascii');
    header.write(octal(0, 8), 116, 8, 'ascii');
    header.write(octal(bytes.length, 12), 124, 12, 'ascii');
    header.write(octal(0, 12), 136, 12, 'ascii');
    header.fill(32, 148, 156);
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write(prefix, 345, 155, 'utf8');
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(octal(sum, 8), 148, 8, 'ascii');
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
}

export function unpackArchive(archive, expected) {
  if (!Buffer.isBuffer(archive) || archive.length > MAX_ARCHIVE) throw new Error('AtomicAUI archive exceeds the size limit.');
  const tar = gunzipSync(archive, { maxOutputLength: MAX_ARCHIVE });
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const checksum = Number.parseInt(header.toString('ascii', 148, 156).replace(/\0.*$/, '').trim(), 8);
    const copy = Buffer.from(header); copy.fill(32, 148, 156);
    if (!Number.isSafeInteger(checksum) || copy.reduce((sum, byte) => sum + byte, 0) !== checksum ||
        header.toString('ascii', 257, 263) !== 'ustar\0' || header.toString('ascii', 156, 157) !== '0') {
      throw new Error('AtomicAUI archive has an invalid tar entry.');
    }
    const field = (start, end) => header.toString('utf8', start, end).replace(/\0.*$/, '');
    const name = field(0, 100), prefix = field(345, 500);
    const path = sourcePath(prefix ? `${prefix}/${name}` : name);
    const size = Number.parseInt(field(124, 136).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || !expected.has(path) || files.has(path) ||
        offset + 512 + size > tar.length) throw new Error(`AtomicAUI archive has an unexpected entry: ${path}`);
    const bytes = Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
    const item = expected.get(path);
    if (bytes.length !== item.bytes || sha(bytes) !== item.sha256) throw new Error(`AtomicAUI archive file hash differs: ${path}`);
    files.set(path, bytes);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (files.size !== expected.size) throw new Error('AtomicAUI archive is missing files.');
  return files;
}

export function buildRelease({ inventory, contents, version: releaseVersion, breakingChanges = [] }) {
  version(releaseVersion);
  validateBreakingChanges(breakingChanges);
  const vendorBytes = contents.get('VENDOR.json');
  if (!vendorBytes) throw new Error('Kit VENDOR.json is missing.');
  const vendor = vendorManifest(vendorBytes, ATOMICAUI_ROOT);
  if (inventory.size !== vendor.files.size + 1) throw new Error('Kit vendor tree has extra or missing files.');
  const files = new Map([['VENDOR.json', vendorBytes]]);
  for (const [path, item] of vendor.files) {
    const bytes = contents.get(path), actual = inventory.get(path);
    if (!bytes || !actual || actual.bytes !== item.bytes || actual.sha256 !== item.sha256 ||
        bytes.length !== item.bytes || sha(bytes) !== item.sha256) throw new Error(`Kit vendor differs from VENDOR.json: ${path}`);
    files.set(path, bytes);
  }
  const records = [...files].sort(([a], [b]) => a.localeCompare(b))
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) }));
  const archive = packArchive(files);
  const parts = [];
  const output = new Map();
  const base = `${RELEASE_ROOT}/${releaseVersion}`;
  for (let offset = 0, number = 0; offset < archive.length; offset += MAX_PART, number++) {
    const chunk = archive.subarray(offset, offset + MAX_PART);
    const encoded = Buffer.from(chunk.toString('base64'));
    const path = `atomicaui-${releaseVersion}.tar.gz.b64.${String(number).padStart(3, '0')}`;
    parts.push({ path, bytes: encoded.length, sha256: sha(encoded), decodedBytes: chunk.length, decodedSha256: sha(chunk) });
    output.set(`${base}/${path}`, encoded);
  }
  const manifest = { schema: 'figma-cli/atomicaui-release@1', version: releaseVersion, vendorSha256: sha(vendorBytes),
    files: records, archive: { bytes: archive.length, sha256: sha(archive), parts }, breakingChanges };
  const manifestBytes = json(manifest);
  const latest = { schema: 'figma-cli/atomicaui-latest@1', version: releaseVersion,
    manifest: `${releaseVersion}/manifest.json`, manifestSha256: sha(manifestBytes) };
  for (const [path, bytes] of files) {
    const target = `${base}/files/${path}`;
    if (bytes.length > MAX_TEXT) throw new Error(`Make source file exceeds 2 MiB: ${path}`);
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    output.set(target, bytes);
  }
  output.set(`${base}/manifest.json`, manifestBytes);
  output.set(`${base}/manifest.sha256`, Buffer.from(`${sha(manifestBytes)}\n`));
  output.set(`${RELEASE_ROOT}/latest.json`, json(latest));
  for (const [path, bytes] of output) if (bytes.length > MAX_TEXT) throw new Error(`Make release file exceeds 2 MiB: ${path}`);
  return { output, manifest, latest, archive };
}

function parseJson(bytes, what) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${what} is not valid UTF-8 JSON.`); }
}
function validateManifest(bytes, expectedHash, expectedVersion) {
  if (!HASH.test(expectedHash || '') || sha(bytes) !== expectedHash) throw new Error('AtomicAUI manifest SHA-256 differs.');
  const manifest = parseJson(bytes, 'AtomicAUI manifest');
  if (manifest?.schema !== 'figma-cli/atomicaui-release@1' || version(manifest.version) !== expectedVersion ||
      !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 10000 ||
      !Array.isArray(manifest.archive?.parts) || manifest.archive.parts.length < 1 ||
      !HASH.test(manifest.archive.sha256 || '') || !Number.isSafeInteger(manifest.archive.bytes) ||
      !HASH.test(manifest.vendorSha256 || '') || !Array.isArray(manifest.breakingChanges)) throw new Error('Invalid AtomicAUI release manifest.');
  const files = new Map(), folded = new Set();
  for (const item of manifest.files) {
    const path = sourcePath(item.path);
    if (!HASH.test(item.sha256 || '') || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || folded.has(path.toLowerCase())) {
      throw new Error(`Invalid AtomicAUI release file: ${path}`);
    }
    folded.add(path.toLowerCase()); files.set(path, item);
  }
  if (!files.has('VENDOR.json') || files.get('VENDOR.json').sha256 !== manifest.vendorSha256) throw new Error('AtomicAUI vendor manifest is missing.');
  validateBreakingChanges(manifest.breakingChanges);
  const seen = new Set();
  for (const part of manifest.archive.parts) {
    if (sourcePath(part.path).includes('/') || seen.has(part.path) || !HASH.test(part.sha256 || '') ||
        !HASH.test(part.decodedSha256 || '') || !Number.isSafeInteger(part.bytes) || part.bytes > MAX_TEXT ||
        !Number.isSafeInteger(part.decodedBytes) || part.decodedBytes < 1) throw new Error('Invalid AtomicAUI archive part.');
    seen.add(part.path);
  }
  return { manifest, files };
}

function validateBreakingChanges(notes) {
  if (!Array.isArray(notes) || notes.length > 100) throw new Error('AtomicAUI breaking changes must be an array of at most 100 notes.');
  for (const item of notes) {
    if (!item || typeof item.note !== 'string' || !item.note.trim() || item.note.length > 2000 ||
        !Array.isArray(item.fixes) || !item.fixes.length || item.fixes.length > 100) {
      throw new Error('Each AtomicAUI breaking note needs one or more app fixes.');
    }
    for (const fix of item.fixes) {
      const path = sourcePath(fix?.path);
      if (!(path.startsWith('src/') || path === 'package.json') || path.startsWith(`${ATOMICAUI_ROOT}/`) ||
          typeof fix.find !== 'string' || !fix.find || typeof fix.replace !== 'string' ||
          fix.find.length > 10000 || fix.replace.length > 10000) {
        throw new Error(`Invalid AtomicAUI breaking-change fix: ${path}`);
      }
    }
  }
}

export async function planBreakingFixes(manifest, readSource) {
  validateBreakingChanges(manifest.breakingChanges);
  const files = new Map();
  for (const item of manifest.breakingChanges) for (const fix of item.fixes) {
    let entry = files.get(fix.path);
    if (!entry) {
      const original = await readSource(fix.path);
      if (typeof original !== 'string') throw new Error(`Breaking-change fix target is missing: ${fix.path}`);
      entry = { original, content: original };
      files.set(fix.path, entry);
    }
    const at = entry.content.indexOf(fix.find);
    if (at < 0 || entry.content.indexOf(fix.find, at + fix.find.length) >= 0) {
      throw new Error(`Breaking-change fix needs exactly one match in ${fix.path}.`);
    }
    entry.content = entry.content.slice(0, at) + fix.replace + entry.content.slice(at + fix.find.length);
  }
  return files;
}

export async function getBytes(url, { fetchImpl = fetch, allowHttp = false } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) throw new Error('AtomicAUI download requires HTTPS.');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('AtomicAUI URL cannot carry credentials or query parameters.');
  const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit' });
  if (response.status !== 200 || /(?:^|;)\s*text\/html\b/i.test(response.headers.get('content-type') || '')) {
    throw new Error(`AtomicAUI download refused HTTP ${response.status} ${response.headers.get('content-type') || ''}: ${parsed.pathname}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_TEXT) throw new Error(`AtomicAUI download exceeds 2 MiB: ${parsed.pathname}`);
  return bytes;
}

export async function latestRelease({ site = ATOMICAUI_SITE, fetchImpl, allowHttp = false } = {}) {
  const bytes = await getBytes(`${site}/atomicaui/latest.json`, { fetchImpl, allowHttp });
  const latest = parseJson(bytes, 'AtomicAUI latest pointer');
  if (latest?.schema !== 'figma-cli/atomicaui-latest@1' || version(latest.version) !== latest.version ||
      latest.manifest !== `${latest.version}/manifest.json` || !HASH.test(latest.manifestSha256 || '')) {
    throw new Error('Invalid AtomicAUI latest pointer.');
  }
  return latest;
}

export async function downloadRelease({ site = ATOMICAUI_SITE, version: pinned, fetchImpl, allowHttp = false } = {}) {
  const opts = { fetchImpl, allowHttp };
  let selected, expectedHash;
  if (pinned) {
    selected = version(pinned);
    const hashBytes = await getBytes(`${site}/atomicaui/${selected}/manifest.sha256`, opts);
    expectedHash = hashBytes.toString('ascii').trim();
  } else {
    const latest = await latestRelease({ site, ...opts });
    selected = latest.version; expectedHash = latest.manifestSha256;
  }
  const base = `${site}/atomicaui/${selected}`;
  const encodedPath = path => path.split('/').map(encodeURIComponent).join('/');
  const { manifest, files: expected } = validateManifest(await getBytes(`${base}/manifest.json`, opts), expectedHash, selected);
  const chunks = [];
  for (const part of manifest.archive.parts) {
    const encoded = await getBytes(`${base}/${encodedPath(part.path)}`, opts);
    if (encoded.length !== part.bytes || sha(encoded) !== part.sha256 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded.toString('ascii'))) {
      throw new Error(`AtomicAUI archive part differs: ${part.path}`);
    }
    const chunk = Buffer.from(encoded.toString('ascii'), 'base64');
    if (chunk.toString('base64') !== encoded.toString('ascii') || chunk.length !== part.decodedBytes || sha(chunk) !== part.decodedSha256) {
      throw new Error(`AtomicAUI decoded part differs: ${part.path}`);
    }
    chunks.push(chunk);
  }
  const archive = Buffer.concat(chunks);
  if (archive.length !== manifest.archive.bytes || sha(archive) !== manifest.archive.sha256) throw new Error('AtomicAUI archive SHA-256 differs.');
  const files = unpackArchive(archive, expected);
  for (const item of manifest.files) {
    const served = await getBytes(`${base}/files/${encodedPath(item.path)}`, opts);
    if (served.length !== item.bytes || sha(served) !== item.sha256 || !served.equals(files.get(item.path))) {
      throw new Error(`AtomicAUI source file differs: ${item.path}`);
    }
  }
  const vendor = vendorManifest(files.get('VENDOR.json'), ATOMICAUI_ROOT);
  if (vendor.files.size !== files.size - 1) throw new Error('AtomicAUI VENDOR.json file count differs.');
  for (const [path, item] of vendor.files) if (!files.has(path) || files.get(path).length !== item.bytes || sha(files.get(path)) !== item.sha256) {
    throw new Error(`AtomicAUI VENDOR.json differs: ${path}`);
  }
  return { manifest, manifestSha256: expectedHash, files, site };
}

function localFiles(root) {
  const found = new Map();
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error('AtomicAUI vendor root symlink refused.');
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name), rel = relative(root, path).split(sep).join('/');
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`AtomicAUI vendor symlink refused: ${rel}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) found.set(sourcePath(rel), readFileSync(path));
      else throw new Error(`AtomicAUI vendor entry refused: ${rel}`);
    }
  }
  if (existsSync(root)) walk(root);
  return found;
}

export function installedStatus(root) {
  const files = localFiles(root);
  if (!files.size) return { installed: false, version: null, localEdits: [] };
  const manifestBytes = files.get('VENDOR.json');
  if (!manifestBytes) return { installed: true, version: null, localEdits: ['VENDOR.json missing'] };
  const vendor = vendorManifest(manifestBytes, ATOMICAUI_ROOT);
  const edits = [];
  for (const [path, item] of vendor.files) {
    const bytes = files.get(path);
    if (!bytes) edits.push(`missing ${path}`);
    else if (bytes.length !== item.bytes || sha(bytes) !== item.sha256) edits.push(`changed ${path}`);
  }
  for (const path of files.keys()) if (path !== 'VENDOR.json' && !vendor.files.has(path)) edits.push(`added ${path}`);
  const metadata = parseJson(manifestBytes, 'AtomicAUI VENDOR.json');
  return { installed: true, version: metadata.atomicauiRelease?.version || null,
    manifestSha256: metadata.atomicauiRelease?.manifestSha256 || null, localEdits: edits.sort(), files: vendor.files };
}

export function changeReport(before, release) {
  const previous = before.files || new Map();
  const next = new Map(release.manifest.files.filter(item => item.path !== 'VENDOR.json').map(item => [item.path, item]));
  const added = [], changed = [], removed = [];
  for (const [path, item] of next) {
    if (!previous.has(path)) added.push(path);
    else if (previous.get(path).sha256 !== item.sha256) changed.push(path);
  }
  for (const path of previous.keys()) if (!next.has(path)) removed.push(path);
  return { from: before.version, to: release.manifest.version, added, changed, removed,
    breakingChanges: release.manifest.breakingChanges };
}

export function installRelease(directory, release) {
  const target = resolve(directory, ATOMICAUI_ROOT);
  const before = installedStatus(target);
  if (before.localEdits.length) throw new Error(`Local AtomicAUI edits refuse install: ${before.localEdits.join(', ')}`);
  const report = changeReport(before, release);
  mkdirSync(dirname(target), { recursive: true });
  const staging = mkdtempSync(join(dirname(target), '.atomicaui-stage-'));
  let backup = null;
  try {
    for (const [path, bytes] of release.files) {
      if (path === 'VENDOR.json') continue;
      const destination = join(staging, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes, { flag: 'wx' });
    }
    const vendor = parseJson(release.files.get('VENDOR.json'), 'AtomicAUI VENDOR.json');
    vendor.atomicauiRelease = { version: release.manifest.version, manifestSha256: release.manifestSha256, site: release.site };
    writeFileSync(join(staging, 'VENDOR.json'), json(vendor), { flag: 'wx' });
    const staged = installedStatus(staging);
    if (staged.localEdits.length || staged.version !== release.manifest.version) throw new Error('Staged AtomicAUI vendor failed verification.');
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      backup = `${target}.backup-${process.pid}-${Date.now()}`;
      renameSync(target, backup);
    }
    try { renameSync(staging, target); }
    catch (error) { if (backup) renameSync(backup, target); throw error; }
    if (backup) rmSync(backup, { recursive: true, force: true });
    return report;
  } finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); }
}
