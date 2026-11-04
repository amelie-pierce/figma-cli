#!/usr/bin/env node
// Offline helpers for an AtomicAUI kit update, used by the atomicaui-release
// skill. They read local folders only: no Figma, Make, network or git access.
//
// - transformGuide: workspace component-classes/<name>.md -> kit
//   guidelines/components/<name>.md (the transform VENDOR.json.guidance records).
// - checkGuides: replay existing kit guides from their workspace sources to
//   prove the transform before it is used.
// - candidateVendor: the next VENDOR.json, with the Core token gate and the
//   proof that the base workspace tree reproduces the trusted baseline.
//
// Run as a script: node src/make-atomicaui-kit.js <transform|check|vendor> ...
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, vendorManifest } from './make-drift.js';
import { GENERATED, GENERATION_MANIFEST, VENDOR_ROOT } from './make-sync.js';

export const GUIDE_TEMPLATE = '_template.md';
const COMMIT = /^[a-f0-9]{12,40}$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HEADER = [
  '> **AtomicAUI 7.0 Make kit copy.** Adapted from the AtomicAUI workspace consume-doc',
  '> `component-classes/{name}.md` at commit `{commit}`. Import from `@/vendor/atomic-aui` in this',
  '> project (or the kit\'s root export elsewhere). Source paths such as `src/lib/…`, `core/…` and',
  '> `tokens/…` are under `src/vendor/atomic-aui/`; `[[wiki links]]`, `apps/…` play pages and `yarn`',
  '> commands refer to the upstream workspace and are not part of this kit. Synced with the library —',
  '> do not edit.',
];
const HEADER_SOURCE = /^> `component-classes\/([^`]+)\.md` at commit `([a-f0-9]{12})`\. /;

function fail(message, code, extra = {}) {
  throw Object.assign(new Error(message), { code, ...extra });
}
const text = (bytes, label) => {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail(`${label} is not valid UTF-8.`, 'KIT_NOT_UTF8'); }
};
const shortCommit = commit => {
  if (!COMMIT.test(commit || '')) fail('Commit must be 12 to 40 lowercase hex characters.', 'KIT_BAD_COMMIT');
  return commit.slice(0, 12);
};
const byteOrder = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const same = (a, b) => a.bytes === b.bytes && a.sha256 === b.sha256;

// Exactly the replacements and header placement of the recorded transform.
export function transformGuide(source, { name, commit, packageName }) {
  if (!NAME.test(name || '')) fail(`Invalid guide name: ${name}`, 'KIT_BAD_NAME');
  if (!PACKAGE.test(packageName || '')) fail('The workspace package name is required (package.json "name").', 'KIT_BAD_PACKAGE');
  if (source.includes('\r')) fail(`Guide ${name} has CR line endings; the transform expects LF.`, 'KIT_CRLF');
  const header = HEADER.map(line => line.replace('{name}', name).replace('{commit}', shortCommit(commit)));
  const lines = source
    .replaceAll(`${packageName}/index.css`, 'src/vendor/atomic-aui/tokens/index.scss')
    .replaceAll(`'${packageName}'`, '\'@/vendor/atomic-aui\'')
    .replaceAll(`"${packageName}"`, '"@/vendor/atomic-aui"')
    .replaceAll('Core 6.0', 'Core 7.0')
    .replaceAll('AtomicAUI-Core-6.0', 'AtomicAUI-Core-7.0')
    .split('\n');
  let at;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end < 0) fail(`Guide ${name} has unterminated frontmatter.`, 'KIT_BAD_GUIDE');
    at = end + 1;
  } else {
    const h1 = lines.findIndex(line => line.startsWith('# '));
    if (h1 < 0) fail(`Guide ${name} has no frontmatter and no H1.`, 'KIT_BAD_GUIDE');
    at = h1 + 1;
  }
  if (at < lines.length && lines[at] === '') at += 1;
  lines.splice(at, 0, ...header, '');
  return lines.join('\n');
}

// The workspace doc name and 12-character commit a kit guide was made from.
export function guideSource(kitGuide) {
  for (const line of kitGuide.split('\n')) {
    const match = line.match(HEADER_SOURCE);
    if (match) return { name: match[1], commit: match[2] };
  }
  return null;
}

function regularFile(path, label) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (stat.isSymbolicLink()) fail(`${label} is a symbolic link: ${path}`, 'KIT_SYMLINK');
  if (!stat.isFile()) fail(`${label} is not a regular file: ${path}`, 'KIT_NOT_FILE');
  return true;
}

export function guideNames(directory) {
  return readdirSync(directory).filter(file => file.endsWith('.md') && file !== GUIDE_TEMPLATE)
    .map(file => file.slice(0, -3)).sort(byteOrder);
}

function readGuide(directory, name, label) {
  const path = join(directory, `${name}.md`);
  return regularFile(path, label) ? text(readFileSync(path), `${label} ${name}.md`) : null;
}

// Replays every kit guide whose header names this commit. Guides made from
// another commit C are listed under otherCommit; each entry's body compares the
// workspace doc at C (from originDirs[C]) with the doc at this commit:
// 'same' (unchanged: leave the kit copy alone, hand-written notes included),
// 'changed' (changed, and the kit copy replays from C: regenerate it),
// 'annotated' (changed, but the kit copy carries what the transform cannot
// reproduce: stop and report), 'noSource' (gone at this commit) or
// 'needsOrigin' (no folder for C was given).
// regenerate lists the 'changed' guides and workspace guides not yet in the
// kit; annotated lists the 'annotated' ones.
// With vendorBytes, each kit copy is also compared with the hash VENDOR.json
// records for it (recorded.differs or recorded.absent mean the kit copy is not
// the one the library recorded).
export function checkGuides({ sourceDir, kitDir, commit, packageName, vendorBytes, originDirs = {} }) {
  const want = shortCommit(commit);
  const origins = new Map(Object.entries(originDirs).map(([at, dir]) => [shortCommit(at), dir]));
  const result = { commit: want, matched: [], differs: [], noSource: [], otherCommit: [], noHeader: [], notInKit: [], regenerate: [], annotated: [] };
  const kitNames = guideNames(kitDir);
  let hashes = null;
  if (vendorBytes) {
    const guidance = JSON.parse(text(vendorBytes, 'VENDOR.json')).guidance;
    if (typeof guidance?.target !== 'string' || !Array.isArray(guidance.files)) fail('VENDOR.json has no guidance section.', 'KIT_FORMAT');
    hashes = { target: guidance.target, files: new Map(guidance.files.map(file => [file.path, file])) };
    result.recorded = { matched: [], differs: [], absent: [] };
  }
  for (const name of kitNames) {
    const kit = readGuide(kitDir, name, 'Kit guide');
    if (hashes) {
      const entry = hashes.files.get(`${hashes.target}/${name}.md`);
      const bytes = Buffer.from(kit, 'utf8');
      result.recorded[!entry ? 'absent' : same(entry, { bytes: bytes.length, sha256: digest(bytes) }) ? 'matched' : 'differs'].push(name);
    }
    const origin = guideSource(kit);
    if (!origin || origin.name !== name) { result.noHeader.push(name); continue; }
    const source = readGuide(sourceDir, name, 'Workspace guide');
    if (origin.commit !== want) {
      let body = source === null ? 'noSource' : origins.has(origin.commit) ? null : 'needsOrigin';
      if (!body) {
        const before = readGuide(origins.get(origin.commit), name, 'Workspace guide at its header commit');
        if (before === null) fail(`Workspace guide ${name}.md is missing at its header commit ${origin.commit}.`, 'KIT_NO_SOURCE');
        body = before === source ? 'same'
          : transformGuide(before, { name, commit: origin.commit, packageName }) === kit ? 'changed' : 'annotated';
      }
      result.otherCommit.push({ name, commit: origin.commit, body });
      continue;
    }
    if (source === null) { result.noSource.push(name); continue; }
    (transformGuide(source, { name, commit: want, packageName }) === kit ? result.matched : result.differs).push(name);
  }
  const kitSet = new Set(kitNames);
  result.notInKit = guideNames(sourceDir).filter(name => !kitSet.has(name));
  const withBody = body => result.otherCommit.filter(entry => entry.body === body).map(entry => entry.name);
  result.regenerate = [...withBody('changed'), ...result.notInKit].sort(byteOrder);
  result.annotated = withBody('annotated');
  return result;
}

export function buildGuides({ sourceDir, names, commit, packageName }) {
  const guides = new Map();
  for (const name of names) {
    const source = readGuide(sourceDir, name, 'Workspace guide');
    if (source === null) fail(`Workspace guide is missing: ${name}.md`, 'KIT_NO_SOURCE');
    guides.set(name, Buffer.from(transformGuide(source, { name, commit, packageName }), 'utf8'));
  }
  return guides;
}

// VENDOR.json exclusions are anchored at the library root; "**/" matches zero
// or more folders. The baseline proof below catches any other reading.
export function globRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export function libraryInventory(root, exclusions = []) {
  const rules = exclusions.map(globRegExp);
  const files = new Map();
  const walk = relative => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail(`Library tree has a symbolic link: ${path}`, 'KIT_SYMLINK');
      if (entry.isDirectory()) walk(path);
      else if (!entry.isFile()) fail(`Library tree has an unsupported entry: ${path}`, 'KIT_NOT_FILE');
      else if (!rules.some(rule => rule.test(path))) {
        const bytes = readFileSync(join(root, path));
        files.set(path, { path, sha256: digest(bytes), bytes: bytes.length });
      }
    }
  };
  if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) fail(`Library folder is missing: ${root}`, 'KIT_NO_LIBRARY');
  walk('');
  if (files.has('VENDOR.json')) fail('The workspace library already contains a VENDOR.json.', 'KIT_BAD_LIBRARY');
  return files;
}

// sha256 of the sorted "path\tbytes\tsha256\n" lines, the inventory digest used
// to compare a workspace commit with a kit.
export function inventoryDigest(files) {
  return digest([...files.values()].sort((a, b) => byteOrder(a.path, b.path))
    .map(file => `${file.path}\t${file.bytes}\t${file.sha256}\n`).join(''));
}

// Update an ordered entry list in place: keep existing order, replace changed
// entries, drop removed ones and insert new ones before the first greater path.
function mergeEntries(list, updates, removed = new Set()) {
  const keys = Object.keys(list[0] || { path: '', sha256: '', bytes: 0 });
  const out = list.filter(entry => !removed.has(entry.path));
  for (const update of [...updates.values()].sort((a, b) => byteOrder(a.path, b.path))) {
    const existing = out.find(entry => entry.path === update.path);
    if (existing) { existing.sha256 = update.sha256; existing.bytes = update.bytes; continue; }
    const at = out.findIndex(entry => entry.path > update.path);
    const entry = Object.fromEntries(keys.map(key => [key, update[key]]));
    out.splice(at < 0 ? out.length : at, 0, entry);
  }
  return out;
}

// The next VENDOR.json. With a library update it changes source.commit,
// source.commitDate and files; with guides it changes guidance.files. Nothing
// else, and the baseline must round-trip in the same 2-space JSON format.
export function candidateVendor({ baselineBytes, baseLibrary, library, commit, commitDate, guides = new Map() }) {
  const before = text(baselineBytes, 'Baseline VENDOR.json');
  vendorManifest(baselineBytes, VENDOR_ROOT);
  const vendor = JSON.parse(before);
  if (`${JSON.stringify(vendor, null, 2)}\n` !== before) {
    fail('Baseline VENDOR.json is not in 2-space JSON with a trailing newline; refusing to rewrite it.', 'KIT_FORMAT');
  }
  const summary = { added: [], changed: [], removed: [] };
  if (library !== undefined) {
    if (!baseLibrary || !COMMIT.test(commit || '') || commit.length !== 40 || typeof commitDate !== 'string' || !commitDate) {
      fail('A library update needs the base library, the full 40-character commit and its commit date.', 'KIT_BAD_SOURCE');
    }
    if (!Array.isArray(vendor.exclusions) || vendor.exclusions.some(rule => typeof rule !== 'string')) {
      fail('Baseline VENDOR.json has no exclusions list.', 'KIT_FORMAT');
    }
    const baseline = new Map(vendor.files.map(file => [file.path, file]));
    const base = libraryInventory(baseLibrary, vendor.exclusions);
    const differ = [...new Set([...baseline.keys(), ...base.keys()])].sort(byteOrder)
      .filter(path => !baseline.has(path) || !base.has(path) || !same(baseline.get(path), base.get(path)));
    if (differ.length) {
      fail(`The base workspace library does not reproduce the baseline VENDOR.json (${differ.length} paths, first: ${differ.slice(0, 5).join(', ')}).`,
        'KIT_BASE_DIFFERS', { paths: differ });
    }
    const next = libraryInventory(library, vendor.exclusions);
    const updates = new Map();
    for (const [path, file] of next) {
      if (!base.has(path)) { summary.added.push(path); updates.set(path, file); }
      else if (!same(base.get(path), file)) { summary.changed.push(path); updates.set(path, file); }
    }
    summary.removed = [...base.keys()].filter(path => !next.has(path)).sort(byteOrder);
    const tokens = [...summary.added, ...summary.changed, ...summary.removed]
      .filter(path => path.startsWith(GENERATED) || path === GENERATION_MANIFEST).sort(byteOrder);
    if (tokens.length) {
      fail(`Core token files changed (${tokens.join(', ')}). Tokens arrive only through a reviewed Core sync; the release stops here.`,
        'KIT_TOKEN_GATE', { paths: tokens });
    }
    vendor.source.commit = commit;
    vendor.source.commitDate = commitDate;
    vendor.files = mergeEntries(vendor.files, updates, new Set(summary.removed));
    summary.inventoryDigest = inventoryDigest(next);
    summary.fileCount = next.size;
    summary.inventory = next;
  }
  const guidance = { added: [], changed: [], unchanged: [] };
  if (guides.size) {
    if (!vendor.guidance || typeof vendor.guidance.target !== 'string' || !Array.isArray(vendor.guidance.files)) {
      fail('Baseline VENDOR.json has no guidance section.', 'KIT_FORMAT');
    }
    const recorded = new Map(vendor.guidance.files.map(file => [file.path, file]));
    const updates = new Map();
    for (const [name, bytes] of guides) {
      const entry = { path: `${vendor.guidance.target}/${name}.md`, sha256: digest(bytes), bytes: bytes.length };
      const old = recorded.get(entry.path);
      (!old ? guidance.added : same(old, entry) ? guidance.unchanged : guidance.changed).push(entry.path);
      updates.set(entry.path, entry);
    }
    vendor.guidance.files = mergeEntries(vendor.guidance.files, updates);
  }
  const bytes = Buffer.from(`${JSON.stringify(vendor, null, 2)}\n`, 'utf8');
  vendorManifest(bytes, VENDOR_ROOT);
  return { bytes, sha256: digest(bytes), ...summary, guidance };
}

function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { options._.push(arg); continue; }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`Option --${key} needs a value.`, 'KIT_USAGE');
    (options[key] ||= []).push(value);
    i += 1;
  }
  return options;
}
const one = (options, key, required = true) => {
  const values = options[key] || [];
  if (values.length > 1) fail(`Option --${key} was given more than once.`, 'KIT_USAGE');
  if (required && !values.length) fail(`Option --${key} is required.`, 'KIT_USAGE');
  return values[0];
};

function writeNew(path, bytes) { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }

const USAGE = `Usage:
  make-atomicaui-kit.js transform --source <component-classes dir> --commit <sha> --package <name> --out <new dir> [--name <guide>]...
  make-atomicaui-kit.js check --source <component-classes dir> --commit <sha> --package <name> --kit <kit guides dir> [--vendor <VENDOR.json>] [--origin <commit>=<guides dir at that commit>]...
  make-atomicaui-kit.js vendor --baseline <VENDOR.json> --out <new file>
      [--base-library <dir> --library <dir> --commit <40-hex sha> --commit-date <date> [--candidate-dir <new dir>]]
      [--guides <dir>]`;

export function run(argv) {
  const [command, ...rest] = argv;
  const options = parseArgs(rest);
  if (command === 'transform') {
    const sourceDir = resolve(one(options, 'source'));
    const out = resolve(one(options, 'out'));
    const names = options.name || guideNames(sourceDir);
    const guides = buildGuides({ sourceDir, names, commit: one(options, 'commit'), packageName: one(options, 'package') });
    mkdirSync(out, { recursive: true });
    if (readdirSync(out).length) fail(`Output folder is not empty: ${out}`, 'KIT_OUTPUT_EXISTS');
    const files = [];
    for (const [name, bytes] of guides) {
      writeNew(join(out, `${name}.md`), bytes);
      files.push({ name, sha256: digest(bytes), bytes: bytes.length });
    }
    return { out, files };
  }
  if (command === 'check') {
    const vendor = one(options, 'vendor', false);
    const originDirs = {};
    for (const value of options.origin || []) {
      const at = value.indexOf('=');
      if (at < 1) fail('Option --origin takes <commit>=<guides dir>.', 'KIT_USAGE');
      originDirs[shortCommit(value.slice(0, at))] = resolve(value.slice(at + 1));
    }
    return checkGuides({ sourceDir: resolve(one(options, 'source')), kitDir: resolve(one(options, 'kit')),
      commit: one(options, 'commit'), packageName: one(options, 'package'), originDirs,
      vendorBytes: vendor === undefined ? undefined : readFileSync(resolve(vendor)) });
  }
  if (command === 'vendor') {
    const out = resolve(one(options, 'out'));
    const library = one(options, 'library', false);
    const guidesDir = one(options, 'guides', false);
    if (library === undefined && guidesDir === undefined) fail('Give --library (with --base-library, --commit, --commit-date), --guides, or both.', 'KIT_USAGE');
    const guides = new Map();
    if (guidesDir !== undefined) {
      for (const name of guideNames(resolve(guidesDir))) guides.set(name, readFileSync(join(resolve(guidesDir), `${name}.md`)));
      if (!guides.size) fail(`No guides found in ${guidesDir}.`, 'KIT_USAGE');
    }
    const result = candidateVendor({ baselineBytes: readFileSync(resolve(one(options, 'baseline'))),
      baseLibrary: library === undefined ? undefined : resolve(one(options, 'base-library')),
      library: library === undefined ? undefined : resolve(library),
      commit: library === undefined ? undefined : one(options, 'commit'),
      commitDate: library === undefined ? undefined : one(options, 'commit-date'), guides });
    const candidateDir = one(options, 'candidate-dir', false);
    if (candidateDir !== undefined && library === undefined) fail('--candidate-dir needs --library.', 'KIT_USAGE');
    let candidate;
    if (candidateDir !== undefined) {
      candidate = resolve(candidateDir);
      mkdirSync(candidate, { recursive: true });
      if (readdirSync(candidate).length) fail(`Candidate folder is not empty: ${candidate}`, 'KIT_OUTPUT_EXISTS');
    }
    writeNew(out, result.bytes);
    // The workspace library at full Make paths, with the candidate VENDOR.json:
    // the --candidate-dir of make sync and make export-delta.
    if (candidate) {
      for (const path of [...result.inventory.keys(), 'VENDOR.json']) {
        const target = join(candidate, VENDOR_ROOT, path);
        mkdirSync(dirname(target), { recursive: true });
        writeNew(target, path === 'VENDOR.json' ? result.bytes : readFileSync(join(resolve(library), path)));
      }
    }
    const { bytes, inventory, ...report } = result;
    return { out, bytes: bytes.length, ...(candidate ? { candidateDir: candidate } : {}), ...report };
  }
  fail(USAGE, 'KIT_USAGE');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(run(process.argv.slice(2)), null, 2)); }
  catch (error) {
    console.error(JSON.stringify({ error: error.message, code: error.code || 'KIT_ERROR', ...(error.paths ? { paths: error.paths } : {}) }));
    process.exitCode = 1;
  }
}
