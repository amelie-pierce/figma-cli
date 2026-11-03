import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedRelease, lockedVendorPaths, requireLocalVendorUnedited, requireMakeVendorWritable } from '../src/make-vendor-lock.js';
import { DEPLOY_CODES, deployApply, deployPlan } from '../src/make-deploy.js';

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
  return { dir, put };
}

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
  requireLocalVendorUnedited(clone(t).dir, 'TEST_CODE', 'saving');
  for (const [change, expected] of [
    [c => c.put(`${ROOT}/index.ts`, 'export const edited = 1\n'), 'changed index.ts'],
    [c => c.put(`${ROOT}/extra.ts`, 'x\n'), 'added extra.ts'],
    [c => rmSync(join(c.dir, ROOT, 'index.ts')), 'missing index.ts'],
  ]) {
    const c = clone(t);
    change(c);
    const error = (() => { try { requireLocalVendorUnedited(c.dir, 'TEST_CODE', 'saving'); } catch (cause) { return cause; } })();
    assert.equal(error?.code, 'TEST_CODE');
    assert.deepEqual(error.files, [expected]);
    assert.match(error.message, /AtomicAUI 7\.0\.2 in src\/vendor\/atomic-aui was edited directly .*so saving was refused.*figma-cli make atomicaui upgrade/);
  }
  const kit = clone(t, { vendor: vendorJson({ release: null }) });
  kit.put(`${ROOT}/index.ts`, 'kit authoring edit\n');
  requireLocalVendorUnedited(kit.dir, 'TEST_CODE', 'saving');
  requireLocalVendorUnedited(clone(t, { vendor: null }).dir, 'TEST_CODE', 'saving');
});

test('deploy plan and apply refuse edited release files before reading Make', async t => {
  assert.ok(DEPLOY_CODES.includes('DEPLOY_VENDOR_EDITED'));
  const c = clone(t);
  c.put(`${ROOT}/index.ts`, 'export const edited = 1\n');
  // Any Make access would throw: the refusal comes first.
  const client = new Proxy({}, { get: () => { throw new Error('Make was read'); } });
  for (const run of [() => deployPlan(client, { dir: c.dir }), () => deployApply(client, { dir: c.dir, planPath: join(c.dir, 'plan.json') })]) {
    const error = await run().catch(cause => cause);
    assert.equal(error.code, 'DEPLOY_VENDOR_EDITED', error.message);
    assert.match(error.message, /so the deploy was refused/);
  }
});
