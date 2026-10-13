import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { applySync, exportDelta, parseRequest, planSync, validatePlanDigest } from '../src/make-sync.js';
import { digest, verifyGeneratedManifest } from '../src/make-drift.js';

const root = 'src/vendor/atomic-aui';
const path = `${root}/lib/Button.tsx`;
const commit = 'a'.repeat(40);
const saved = 'b'.repeat(40);
const info = bytes => bytes == null ? null : { bytes: bytes.length, sha256: digest(bytes) };
const text = value => Buffer.from(value);
const state = { mode: 'git', hasBaseline: true, savedVersion: saved, pendingCount: 0,
  pendingPaths: [], isLoading: false, error: false };

function generation(files) {
  const rows = [...files].map(([name, bytes]) => ({ path: name, ...info(bytes) }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const tree = { fileCount: rows.length, bytes: rows.reduce((n, f) => n + f.bytes, 0),
    digest: digest(rows.map(f => `${f.path}\t${f.bytes}\t${f.sha256}\n`).join('')) };
  return text(`${JSON.stringify({ schema: 'atomic-cli/generated-manifest@1', tree, files: rows })}\n`);
}

function fixture({ base = 'base', make = base, workspace = 'next', choice, direction = 'workspace-to-make' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'make-sync-'));
  const tokens = new Map([['.generated', text('sentinel\n')], ['splash-bootstrap.js', text('splash\n')]]);
  const generationBytes = generation(tokens);
  const baseline = new Map([
    ['lib/Button.tsx', base == null ? null : text(base)],
    ['tokens/generated/.generated', tokens.get('.generated')],
    ['tokens/generated/splash-bootstrap.js', tokens.get('splash-bootstrap.js')],
    ['tokens/generated.manifest.json', generationBytes],
  ].filter(([, bytes]) => bytes));
  const baselineBytes = text(JSON.stringify({ files: [...baseline].map(([name, bytes]) => ({ path: name, ...info(bytes) })) }));
  const contents = new Map([...baseline]);
  if (make == null) contents.delete('lib/Button.tsx'); else contents.set('lib/Button.tsx', text(make));
  contents.set('VENDOR.json', baselineBytes);
  const inventory = new Map([...contents].map(([name, bytes]) => [name, { path: name, ...info(bytes) }]));
  if (workspace != null) {
    const absolute = join(directory, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, workspace);
  }
  const packageData = { manifest: { source: { commit }, generationManifest: { sha256: digest(generationBytes) },
    tree: { digest: 'c'.repeat(64) } }, files: tokens, sha256: 'd'.repeat(64) };
  const request = { schema: 'figma-cli/make-sync-request@1', fileKey: 'Scratch', who: 'Engineer',
    requestId: 'request-1', requestedAt: '2026-10-13T00:00:00.000Z', direction, workspaceCommit: commit,
    files: [{ path, baselineSha256: info(baseline.get('lib/Button.tsx'))?.sha256 ?? null,
      workspaceSha256: workspace == null ? null : digest(workspace), dependencies: [] }],
    choices: choice ? { [path]: choice } : {} };
  const args = { request, requestSha256: digest(JSON.stringify(request)), packageData, baselineBytes,
    candidateDir: directory, generationManifestBytes: null, inventory, contents, state, fileKey: 'Scratch' };
  return { args, directory, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

test('source-only plan records hashes, diff, scope and digest', () => {
  const f = fixture();
  try {
    const { plan } = planSync(f.args);
    assert.equal(plan.actions[0].kind, 'source-only');
    assert.equal(plan.actions[0].operation, 'write');
    assert.equal(plan.actions[0].before.sha256, digest('base'));
    assert.equal(plan.actions[0].after.sha256, digest('next'));
    assert.deepEqual(plan.actions[0].diff.added, ['next']);
    assert.deepEqual(plan.unresolved, []);
    validatePlanDigest(plan);
    assert.throws(() => validatePlanDigest({ ...plan, makeVersion: '0'.repeat(40) }), /digest mismatch/);
  } finally { f.dispose(); }
});

test('destination-only, two-sided, delete/edit and same-path additions stay unresolved without choice', () => {
  for (const scenario of [
    { make: 'changed', workspace: 'base' },
    { make: 'changed', workspace: 'other' },
    { make: null, workspace: 'other' },
    { base: null, make: 'make-added', workspace: 'workspace-added' },
  ]) {
    const f = fixture(scenario);
    try {
      const { plan } = planSync(f.args);
      assert.deepEqual(plan.unresolved, [path]);
      assert.equal(plan.actions[0].operation, 'keep');
    } finally { f.dispose(); }
  }
});

test('explicit conflict choices select Make, workspace, merged bytes or stop', () => {
  for (const [choice, expected] of [
    [{ action: 'override-make' }, digest('other')],
    [{ action: 'override-workspace' }, digest('changed')],
    [{ action: 'stop' }, digest('changed')],
  ]) {
    const f = fixture({ make: 'changed', workspace: 'other', choice });
    try {
      const { plan } = planSync(f.args);
      assert.equal(plan.actions[0].after.sha256, expected);
      assert.equal(plan.unresolved.length, choice.action === 'stop' ? 1 : 0);
    } finally { f.dispose(); }
  }
  const f = fixture({ make: 'changed', workspace: 'other', choice: { action: 'merged', file: 'merged.tsx', expectedSha256: digest('merged') } });
  try {
    writeFileSync(join(f.directory, 'merged.tsx'), 'merged');
    assert.equal(planSync(f.args).plan.actions[0].after.sha256, digest('merged'));
    f.args.request.choices[path].expectedSha256 = digest('wrong');
    assert.throws(() => planSync(f.args), /Merged result hash differs/);
  } finally { f.dispose(); }
});

test('request rejects undeclared dependencies, invalid direction and token candidate drift', () => {
  const f = fixture();
  try {
    assert.deepEqual(parseRequest(text(JSON.stringify(f.args.request)), 'Scratch'), f.args.request);
    f.args.request.files[0].dependencies = [`${root}/lib/Missing.tsx`];
    assert.throws(() => parseRequest(text(JSON.stringify(f.args.request)), 'Scratch'), /Dependency absent/);
    f.args.request.files[0].dependencies = [];
    f.args.inventory.get('tokens/generated/.generated').sha256 = digest('tampered');
    assert.throws(() => planSync(f.args), /Generated tokens differ/);
  } finally { f.dispose(); }
});

test('export emits intake-make-delta files shape and refuses unsaved or generated-token edits', () => {
  const f = fixture({ make: 'changed' });
  try {
    const delta = exportDelta({ ...f.args, who: 'Engineer' });
    assert.deepEqual(delta.files.map(file => file.path), [path]);
    assert.equal(delta.files[0].status, 'changed');
    assert.equal(Buffer.from(delta.files[0].contentBase64, 'base64').toString(), 'changed');
    assert.deepEqual(JSON.parse(JSON.stringify(delta)).files.map(file => ({ path: file.path })), [{ path }]);
    assert.throws(() => exportDelta({ ...f.args, state: { ...state, pendingCount: 1, pendingPaths: [path] }, who: 'Engineer' }), /Unsaved/);
    f.args.inventory.get('tokens/generated/.generated').sha256 = digest('tampered');
    assert.throws(() => exportDelta({ ...f.args, who: 'Engineer' }), /Generated token/);
  } finally { f.dispose(); }
});

test('export includes explicitly named unchanged dependencies and checks tokens outside selected scope', () => {
  const f = fixture({ make: 'changed' });
  try {
    const support = 'lib/button/support.ts';
    const bytes = text('support');
    const manifest = JSON.parse(f.args.baselineBytes.toString());
    manifest.files.push({ path: support, ...info(bytes) });
    f.args.baselineBytes = text(JSON.stringify(manifest));
    f.args.contents.set(support, bytes);
    f.args.inventory.set(support, { path: support, ...info(bytes) });
    f.args.contents.set('VENDOR.json', f.args.baselineBytes);
    f.args.inventory.set('VENDOR.json', { path: 'VENDOR.json', ...info(f.args.baselineBytes) });
    const delta = exportDelta({ ...f.args, who: 'Engineer', paths: [path],
      dependencyPaths: [`${root}/${support}`] });
    assert.deepEqual(delta.files.map(file => [file.path, file.status]), [
      [path, 'changed'], [`${root}/${support}`, 'dependency'],
    ]);
    f.args.inventory.get('tokens/generated/.generated').sha256 = digest('tampered');
    assert.throws(() => exportDelta({ ...f.args, who: 'Engineer', paths: [path] }), /Generated token/);
  } finally { f.dispose(); }
});

test('snapshot mode and pending edits refuse planning', () => {
  const f = fixture();
  try {
    assert.throws(() => planSync({ ...f.args, state: { ...state, mode: 'snapshot' } }), /Snapshot-mode/);
    assert.throws(() => planSync({ ...f.args, state: { ...state, pendingCount: 1, pendingPaths: [path] } }), /Unsaved/);
  } finally { f.dispose(); }
});

test('VENDOR metadata survives scoped updates and identical plans preserve baseline bytes', () => {
  const f = fixture();
  try {
    const original = JSON.parse(f.args.baselineBytes.toString());
    original.schema = 'existing-vendor-schema';
    original.source = { commit: 'historical-source', commitDate: 'historical-date' };
    f.args.baselineBytes = text(`${JSON.stringify(original)}\n`);
    f.args.contents.set('VENDOR.json', f.args.baselineBytes);
    f.args.inventory.set('VENDOR.json', { path: 'VENDOR.json', ...info(f.args.baselineBytes) });
    const updated = planSync(f.args).vendorBytes;
    assert.deepEqual(JSON.parse(updated).source, original.source);
    assert.equal(JSON.parse(updated).schema, original.schema);
    const source = text('base');
    writeFileSync(join(f.directory, path), source);
    f.args.request.files[0].workspaceSha256 = digest(source);
    assert.deepEqual(planSync(f.args).vendorBytes, f.args.baselineBytes);
  } finally { f.dispose(); }
});

test('generated manifest checks hidden file, splash and exact path set', () => {
  const files = new Map([['.generated', text('x')], ['splash-bootstrap.js', text('y')]]);
  const manifest = generation(files);
  const inventory = new Map([...files].map(([name, bytes]) => [`tokens/generated/${name}`, info(bytes)]));
  assert.equal(verifyGeneratedManifest(manifest, inventory).fileCount, 2);
  inventory.delete('tokens/generated/.generated');
  assert.throws(() => verifyGeneratedManifest(manifest, inventory), /missing or extra/);
});

test('apply uses durable paths, saves exact set and checks drift; unresolved refuses before writes', async () => {
  const f = fixture();
  try {
    const { plan, vendorBytes } = planSync(f.args);
    const calls = [];
    const client = { writeDurable: async (name, value, options) => {
      calls.push(['write', name, options.expectedSha256]);
      return { backupPath: '/private/backup' };
    }, deleteDurable: async () => { throw new Error('unexpected delete'); },
    saveVersion: async (_title, paths) => { calls.push(['save', paths]); return { versionNumber: 2, gitSha: 'e'.repeat(40) }; },
    drift: async bytes => { assert.deepEqual(bytes, vendorBytes); calls.push(['drift']); return { ok: true, counts: {} }; } };
    const result = await applySync(client, { plan, vendorBytes, packageData: f.args.packageData,
      candidateDir: f.directory, generationManifestBytes: null, title: 'Sync' });
    assert.equal(result.version.versionNumber, 2);
    assert.deepEqual(calls.map(call => call[0]), ['write', 'write', 'save', 'drift']);
    assert.deepEqual(calls[2][1], [path, `${root}/VENDOR.json`]);
    plan.unresolved.push(path);
    await assert.rejects(applySync(client, { plan, vendorBytes }), /Unresolved/);
  } finally { f.dispose(); }
});

test('scoped plan keeps out-of-scope baseline and refuses to bless unrelated Make edits', async () => {
  const f = fixture();
  try {
    const extra = text('unreviewed');
    f.args.contents.set('lib/other.ts', extra);
    f.args.inventory.set('lib/other.ts', { path: 'lib/other.ts', ...info(extra) });
    const { plan, vendorBytes } = planSync(f.args);
    assert.deepEqual(plan.outOfScopeDrift, ['lib/other.ts']);
    assert.equal(JSON.parse(vendorBytes).files.some(file => file.path === 'lib/other.ts'), false);
    const client = { writeDurable: () => { throw new Error('must not write'); } };
    await assert.rejects(applySync(client, { plan, vendorBytes }), /Out-of-scope/);
  } finally { f.dispose(); }
});

test('override-workspace is recorded for review but cannot advance the Make baseline', async () => {
  const f = fixture({ make: 'local', workspace: 'remote', choice: { action: 'override-workspace' } });
  try {
    const { plan, vendorBytes } = planSync(f.args);
    assert.equal(plan.actions[0].after.sha256, digest('local'));
    const client = { writeDurable: () => { throw new Error('must not write'); } };
    await assert.rejects(applySync(client, { plan, vendorBytes }), /requires workspace review/);
  } finally { f.dispose(); }
});
