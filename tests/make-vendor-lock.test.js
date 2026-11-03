import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedRelease, lockedVendorPaths, requireLocalVendorUnedited, requireMakeVendorWritable } from '../src/make-vendor-lock.js';
import { DEPLOY_CODES, deployApply, deployPlan } from '../src/make-deploy.js';
import { defaultRun, teamContext } from '../src/make-team.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const ROOT = 'src/vendor/atomic-aui';
const RELEASE = { version: '7.0.2', manifestSha256: 'f'.repeat(64), site: 'https://example.test' };
const vendorJson = ({ release = RELEASE, files = { 'index.ts': 'export {}\n' } } = {}) => JSON.stringify({
  files: Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: hash(text) })),
  ...(release ? { atomicauiRelease: release } : {}) });

// A Make client whose only capability is the client-VFS read the lock needs.
function makeClient(vendor) {
  const reads = [];
  return { reads, readDurable: async path => {
    reads.push(path);
    if (vendor instanceof Error) throw vendor;
    return vendor == null ? { exists: false, content: null } : { exists: true, content: vendor };
  } };
}

function clone(t, { vendor = vendorJson(), files = { 'index.ts': 'export {}\n' } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'figma-cli-vendor-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (path, text) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); };
  put('src/App.tsx', 'app\n');
  if (vendor !== null) put(`${ROOT}/VENDOR.json`, vendor);
  for (const [path, text] of Object.entries(files)) put(`${ROOT}/${path}`, text);
  const git = (...args) => assert.equal(defaultRun('git', args, { cwd: dir }).status, 0, `git ${args.join(' ')}`);
  git('init', '-q');
  return { dir, put, git };
}

const unedited = (dir, code = 'TEST_CODE') => requireLocalVendorUnedited(teamContext({ dir }), code, 'saving');
const refusal = dir => { try { unedited(dir); } catch (cause) { return cause; } };

test('only paths inside the vendored AtomicAUI folder are locked', () => {
  assert.deepEqual(lockedVendorPaths(['src/App.tsx', 'src/vendor/atomic-aui/lib/x.tsx', './src/vendor/atomic-aui/VENDOR.json',
    'src/vendor/atomic-aui-extra/x.ts', 'src/vendor/other/x.ts', 'SRC/Vendor/Atomic-AUI/y.ts']),
  ['src/vendor/atomic-aui/lib/x.tsx', './src/vendor/atomic-aui/VENDOR.json', 'SRC/Vendor/Atomic-AUI/y.ts']);
  assert.deepEqual(installedRelease(vendorJson()), RELEASE);
  assert.equal(installedRelease(vendorJson({ release: null })), null);
  assert.equal(installedRelease('not json'), null);
});

test('a direct Make write into a release-installed vendor folder is refused before anything is written', async () => {
  const client = makeClient(vendorJson());
  const error = await requireMakeVendorWritable(client, [`${ROOT}/lib/table/table.tsx`]).catch(cause => cause);
  assert.equal(error.code, 'MAKE_VENDOR_LOCKED');
  assert.match(error.message, /part of AtomicAUI 7\.0\.2.*replaces that folder.*nothing was written.*figma-cli make atomicaui upgrade/);
  assert.deepEqual(client.reads, [`${ROOT}/VENDOR.json`]);
  await assert.rejects(requireMakeVendorWritable(makeClient(vendorJson()), [`${ROOT}/VENDOR.json`]), /VENDOR\.json is part of AtomicAUI/);
  const unreadable = await requireMakeVendorWritable(makeClient(new Error('Make React state is unavailable.')), [`${ROOT}/x.ts`]).catch(cause => cause);
  assert.equal(unreadable.code, 'MAKE_VENDOR_LOCKED');
  assert.match(unreadable.message, /Could not check .*nothing was written/);
});

test('app paths, a kit vendor without a release record and a project without VENDOR.json stay writable', async () => {
  const app = makeClient(vendorJson());
  await requireMakeVendorWritable(app, ['src/App.tsx', 'src/vendor/other/x.ts']);
  assert.deepEqual(app.reads, [], 'no VENDOR.json read for paths outside the folder');
  await requireMakeVendorWritable(makeClient(vendorJson({ release: null })), [`${ROOT}/lib/table/table.tsx`]);
  await requireMakeVendorWritable(makeClient(null), [`${ROOT}/lib/table/table.tsx`]);
});

test('a local clone with edited release files is refused; an untouched one, a kit vendor or no VENDOR.json is not', t => {
  unedited(clone(t).dir);
  for (const [change, expected] of [
    [c => c.put(`${ROOT}/index.ts`, 'export const edited = 1\n'), 'changed index.ts'],
    [c => c.put(`${ROOT}/extra.ts`, 'x\n'), 'added extra.ts'],
    [c => rmSync(join(c.dir, ROOT, 'index.ts')), 'missing index.ts'],
  ]) {
    const c = clone(t);
    change(c);
    const error = refusal(c.dir);
    assert.equal(error?.code, 'TEST_CODE');
    assert.deepEqual(error.files, [expected]);
    assert.match(error.message, /AtomicAUI 7\.0\.2 in src\/vendor\/atomic-aui was edited directly .*so saving was refused.*figma-cli make atomicaui upgrade/);
  }
  const kit = clone(t, { vendor: vendorJson({ release: null }) });
  kit.put(`${ROOT}/index.ts`, 'kit authoring edit\n');
  unedited(kit.dir);
  unedited(clone(t, { vendor: null }).dir);
});

test('git-ignored files and untracked .DS_Store are not vendor edits; tracked changes and untracked additions are', t => {
  const c = clone(t);
  c.put('.gitignore', '*.log\n');
  c.put(`${ROOT}/.DS_Store`, 'finder');
  c.put(`${ROOT}/lib/.DS_Store`, 'finder');
  c.put(`${ROOT}/debug.log`, 'log');
  unedited(c.dir);
  c.git('add', '-A');
  c.git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'install');
  unedited(c.dir);
  c.put(`${ROOT}/index.ts`, 'export const edited = 1\n');
  c.put(`${ROOT}/lib/extra.ts`, 'x\n');
  assert.deepEqual(refusal(c.dir).files, ['added lib/extra.ts', 'changed index.ts']);
  rmSync(join(c.dir, ROOT, 'index.ts'));
  assert.deepEqual(refusal(c.dir).files, ['added lib/extra.ts', 'missing index.ts']);
});

test('deploy plan and apply refuse edited release files before reading Make', async t => {
  assert.ok(DEPLOY_CODES.includes('DEPLOY_VENDOR_EDITED'));
  const c = clone(t);
  c.put(`${ROOT}/index.ts`, 'export const edited = 1\n');
  // Any Make access would throw: the refusal comes first.
  const client = new Proxy({}, { get: () => { throw new Error('Make was read'); } });
  const sub = join(c.dir, 'src');
  for (const run of [() => deployPlan(client, { dir: c.dir }), () => deployApply(client, { dir: c.dir, planPath: join(c.dir, 'plan.json') }),
    () => deployPlan(client, { dir: sub }), () => deployApply(client, { dir: sub, planPath: join(c.dir, 'plan.json') })]) {
    const error = await run().catch(cause => cause);
    assert.equal(error.code, 'DEPLOY_VENDOR_EDITED', error.message);
    assert.match(error.message, /so the deploy was refused/);
  }
});
