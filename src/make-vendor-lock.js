import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { sourcePath, vendorManifest } from './make-drift.js';

// An app that installed AtomicAUI from a release (make atomicaui add/upgrade)
// records that release in src/vendor/atomic-aui/VENDOR.json as
// `atomicauiRelease`. Every upgrade replaces that folder, so a direct edit
// there would silently be lost: the user-facing write verbs, team commits and
// deploy refuse it. Only the AtomicAUI release, add/upgrade and sync commands
// write the folder, through the client's internal writers. The kit that
// authors AtomicAUI vendors workspace source, whose VENDOR.json records no
// release, and a project without VENDOR.json is not affected.
export const LOCKED_VENDOR_ROOT = 'src/vendor/atomic-aui';
const UPGRADE = 'figma-cli make atomicaui upgrade';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const lockError = (message, code) => Object.assign(new Error(message), { code });

// The release the vendor folder was installed from, or null when VENDOR.json
// records none (a kit's workspace vendor) or is not JSON.
export function installedRelease(vendorJson) {
  try {
    const release = JSON.parse(typeof vendorJson === 'string' ? vendorJson : new TextDecoder('utf-8', { fatal: true }).decode(vendorJson))?.atomicauiRelease;
    return release && typeof release === 'object' ? release : null;
  } catch { return null; }
}

export function lockedVendorPaths(paths) {
  return paths.filter(path => typeof path === 'string' &&
    `${path.replace(/^(\.\/)+/, '').toLowerCase()}/`.startsWith(`${LOCKED_VENDOR_ROOT}/`));
}

// Make side: refuse a direct write, create, replace or delete under the folder
// when Make's own VENDOR.json there records a release. Nothing is written.
export async function requireMakeVendorWritable(client, paths) {
  const locked = lockedVendorPaths(paths);
  if (!locked.length) return;
  let vendor;
  try { vendor = await client.readDurable(`${LOCKED_VENDOR_ROOT}/VENDOR.json`); }
  catch (error) {
    throw lockError(`Could not check whether ${LOCKED_VENDOR_ROOT} holds an AtomicAUI release (${error.message}); nothing was written.`,
      'MAKE_VENDOR_LOCKED');
  }
  const release = vendor?.exists ? installedRelease(vendor.content) : null;
  if (!release) return;
  throw lockError(`${locked.join(', ')} ${locked.length === 1 ? 'is' : 'are'} part of AtomicAUI ${release.version || ''}`.replace(/ $/, '') +
    `, installed from a release into ${LOCKED_VENDOR_ROOT}. Every AtomicAUI upgrade replaces that folder, so a direct change there would be lost; ` +
    `nothing was written. Change the app outside ${LOCKED_VENDOR_ROOT}, or update the library with ${UPGRADE}.`, 'MAKE_VENDOR_LOCKED');
}

// path -> bytes of every regular file below root; symlinks and other entries are refused.
export function localFiles(root) {
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

// Local edits of a vendor inventory ({ sha256, bytes } by path) against VENDOR.json's file records.
export function vendorEdits(inventory, vendorFiles) {
  const edits = [];
  for (const [path, item] of vendorFiles) {
    const actual = inventory.get(path);
    if (!actual) edits.push(`missing ${path}`);
    else if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) edits.push(`changed ${path}`);
  }
  for (const path of inventory.keys()) if (path !== 'VENDOR.json' && !vendorFiles.has(path)) edits.push(`added ${path}`);
  return edits.sort();
}

// Local clone side (team commits, deploy): the installed folder must equal the
// release files VENDOR.json records. `code` names the caller's error family.
export function requireLocalVendorUnedited(projectRoot, code, action) {
  const folder = join(projectRoot, ...LOCKED_VENDOR_ROOT.split('/'));
  const vendorPath = join(folder, 'VENDOR.json');
  if (!existsSync(vendorPath) || !lstatSync(vendorPath).isFile()) return;
  const vendorBytes = readFileSync(vendorPath);
  const release = installedRelease(vendorBytes);
  if (!release) return;
  const files = localFiles(folder);
  const inventory = new Map([...files].map(([path, bytes]) => [path, { sha256: sha(bytes), bytes: bytes.length }]));
  const edits = vendorEdits(inventory, vendorManifest(vendorBytes, LOCKED_VENDOR_ROOT).files);
  if (!edits.length) return;
  const error = lockError(`AtomicAUI ${release.version || ''}`.replace(/ $/, '') + ` in ${LOCKED_VENDOR_ROOT} was edited directly ` +
    `(${edits.join(', ')}), so ${action} was refused. Every AtomicAUI upgrade replaces that folder and would lose these edits. ` +
    `Put those files back as the release installed them, keep app changes outside ${LOCKED_VENDOR_ROOT}, ` +
    `and update the library with ${UPGRADE}.`, code);
  error.files = edits;
  throw error;
}
