import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRelease, DEFAULT_PART_BASE64_BYTES, downloadRelease, getBytes, installRelease, installedStatus, nextPatch,
  planBreakingFixes } from '../src/make-atomicaui.js';
import { installSoloRelease, releaseAtomicaui, verifyAtomicauiRelease } from '../src/commands/make-atomicaui.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(version = '7.0.0') {
  const source = new Map([
    ['src/index.ts', Buffer.from('export const Button = 1\n')],
    ['tokens/index.scss', Buffer.from(':root { --theme-surface: white; }\n')],
  ]);
  const vendor = Buffer.from(JSON.stringify({ schema: 1, name: 'atomic-aui', files: [...source].map(([path, bytes]) =>
    ({ path, bytes: bytes.length, sha256: hash(bytes) })) }));
  const contents = new Map([...source, ['VENDOR.json', vendor]]);
  const inventory = new Map([...contents].map(([path, bytes]) => [path, { path, bytes: bytes.length, sha256: hash(bytes) }]));
  return { source, contents, inventory, release: buildRelease({ contents, inventory, version }) };
}
async function served(files, fn) {
  const server = createServer((request, response) => {
    const key = `public${decodeURI(request.url)}`;
    const item = files.get(key);
    if (!item) { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html>Figma app fallback</html>'); return; }
    response.writeHead(200, { 'content-type': key.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    response.end(item);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('release archive and HTTPS client verify the complete chain through a local HTTP fixture', async () => {
  const { release } = fixture();
  assert.equal(release.manifest.files.length, 3);
  assert.equal(release.manifest.archive.parts.length, 1);
  assert.equal(nextPatch('7.0.0'), '7.0.1');
  await served(release.output, async site => {
    const fetched = await downloadRelease({ site, allowHttp: true });
    assert.equal(fetched.manifest.version, '7.0.0');
    assert.deepEqual([...fetched.files], [...new Map([...fetched.files].sort(([a], [b]) => a.localeCompare(b)))]);
    for (const [path, bytes] of fetched.files) {
      const expected = path === 'VENDOR.json' ? release.output.get('public/atomicaui/7.0.0/files/VENDOR.json')
        : release.output.get(`public/atomicaui/7.0.0/files/${path}`);
      assert.ok(bytes.equals(expected));
    }
  });
});

test('large archive and source use configurable bounded base64 parts', async () => {
  const { source } = fixture();
  let seed = 0x7a00b00b;
  const large = Buffer.alloc(700000);
  for (let index = 0; index < large.length; index++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    large[index] = 33 + (seed >>> 0) % 90;
  }
  source.set('src/large.ts', large);
  const vendor = Buffer.from(JSON.stringify({ schema: 1, name: 'atomic-aui', files: [...source].map(([path, bytes]) =>
    ({ path, bytes: bytes.length, sha256: hash(bytes) })) }));
  const contents = new Map([...source, ['VENDOR.json', vendor]]);
  const inventory = new Map([...contents].map(([path, bytes]) => [path, { path, bytes: bytes.length, sha256: hash(bytes) }]));
  const release = buildRelease({ contents, inventory, version: '7.0.0' });
  assert.equal(release.manifest.partBase64Bytes, DEFAULT_PART_BASE64_BYTES);
  assert.ok(release.manifest.archive.parts.length > 1);
  assert.ok(release.manifest.files.find(item => item.path === 'src/large.ts').parts.length > 1);
  for (const [path, bytes] of release.output) if (!path.endsWith('manifest.json')) {
    assert.ok(bytes.length <= DEFAULT_PART_BASE64_BYTES, path);
  }
  await served(release.output, async site => {
    const fetched = await downloadRelease({ site, allowHttp: true });
    assert.ok(fetched.files.get('src/large.ts').equals(large));
  });
  const smaller = buildRelease({ contents, inventory, version: '7.0.0', partBase64Bytes: 256 * 1024 });
  assert.ok(smaller.manifest.archive.parts.length >= release.manifest.archive.parts.length);
  assert.throws(() => buildRelease({ contents, inventory, version: '7.0.0', partBase64Bytes: 3 }), /part size/);
});

test('client rejects Figma HTML 200, a wrong manifest hash, and a corrupted archive part', async () => {
  const { release } = fixture();
  await served(new Map(), async site => {
    await assert.rejects(downloadRelease({ site, allowHttp: true }), /text\/html/);
    await assert.rejects(getBytes(`${site}/atomicaui/latest.json`), /requires HTTPS/);
  });
  const badLatest = new Map(release.output);
  const latest = JSON.parse(badLatest.get('public/atomicaui/latest.json'));
  latest.manifestSha256 = 'a'.repeat(64);
  badLatest.set('public/atomicaui/latest.json', Buffer.from(JSON.stringify(latest)));
  await served(badLatest, site => assert.rejects(downloadRelease({ site, allowHttp: true }), /manifest SHA-256 differs/));
  const badPart = new Map(release.output);
  const partPath = [...badPart.keys()].find(path => path.endsWith('.b64.000'));
  badPart.set(partPath, Buffer.from('corrupted'));
  await served(badPart, site => assert.rejects(downloadRelease({ site, allowHttp: true }), /archive part differs/));
});

test('client rejects non-200 responses and verifies a pinned version via its sidecar hash', async () => {
  const { release } = fixture();
  await served(release.output, async site => {
    const pinned = await downloadRelease({ site, version: '7.0.0', allowHttp: true });
    assert.equal(pinned.manifest.version, '7.0.0');
    const response = await fetch(`${site}/atomicaui/latest.json`);
    assert.equal(response.status, 200);
  });
  await assert.rejects(getBytes('https://example.test/atomicaui/latest.json', {
    fetchImpl: async () => ({ status: 404, headers: new Headers({ 'content-type': 'application/json' }) }),
  }), /HTTP 404/);
});

test('local install stages files and refuses edited vendor files', async () => {
  const { release } = fixture();
  const root = mkdtempSync(join(tmpdir(), 'figma-atomicaui-'));
  try {
    const payload = { manifest: release.manifest, manifestSha256: hash(release.output.get('public/atomicaui/7.0.0/manifest.json')),
      files: new Map([...release.manifest.files].map(item => [item.path, release.output.get(`public/atomicaui/7.0.0/files/${item.path}`)])),
      site: 'https://example.test' };
    const report = installRelease(root, payload);
    assert.equal(report.added.length, 2);
    const vendorDir = join(root, 'src/vendor/atomic-aui');
    assert.equal(installedStatus(vendorDir).version, '7.0.0');
    writeFileSync(join(vendorDir, 'src/index.ts'), 'local edit');
    assert.match(installedStatus(vendorDir).localEdits[0], /changed src\/index.ts/);
    assert.throws(() => installRelease(root, payload), /Local AtomicAUI edits/);
    assert.equal(readFileSync(join(vendorDir, 'src/index.ts'), 'utf8'), 'local edit');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fake Make client receives an immutable release folder and one exact save', async () => {
  const { inventory, contents } = fixture();
  const files = new Map([['public/favicon.svg', Buffer.from('<svg/>')]]);
  const saved = [];
  const state = { mode: 'git', hasBaseline: true, savedVersion: 'a'.repeat(40), pendingPaths: [], isLoading: false, error: false, pendingCount: 0 };
  const client = {
    fileKey: 'atomicaui-test-fixture',
    projectMarker: async () => null,
    _driftState: async () => ({ state }),
    files: async () => [...files.keys()].map(path => ({ kind: 'file', path })),
    read: async path => ({ content: files.get(path).toString(), sha256: hash(files.get(path)) }),
    inventoryVendor: async () => ({ inventory, contents, state }),
    writeDurable: async (path, content, { expectedSha256 } = {}) => {
      assert.ok(expectedSha256 == null);
      assert.ok(path.startsWith('public/atomicaui/'), path);
      assert.equal(path.startsWith('src/vendor/atomic-aui/'), false);
      files.set(path, Buffer.from(content)); return { changed: true };
    },
    saveVersion: async (_title, paths) => { saved.push(paths); return { versionNumber: 18, gitSha: 'a'.repeat(40) }; },
    verifyFiles: async entries => {
      for (const entry of entries) assert.equal(files.get(entry.path).toString(), entry.content);
      return { verification: 'remote-content-matched', files: entries };
    },
  };
  const result = await releaseAtomicaui(client, { requestedVersion: '7.0.0' });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], [...files.keys()].filter(path => path !== 'public/favicon.svg').sort());
  assert.equal(result.savedVersion, 18);
  assert.ok(result.publishSteps.some(line => line.includes('Anyone on the web')));
  assert.ok(result.publishSteps.some(line => line.includes('Unpublish')));
  await assert.rejects(releaseAtomicaui(client, { requestedVersion: '7.0.0' }), /immutable/);
});

test('saved release verifier compares the exact release path set and every hash', async () => {
  const { inventory, contents, release } = fixture();
  const state = { mode: 'git', hasBaseline: true, savedVersion: 'a'.repeat(40),
    pendingPaths: [], isLoading: false, error: false, pendingCount: 0 };
  const actualContents = new Map([...release.output].map(([path, bytes]) =>
    [path.slice('public/atomicaui/'.length), bytes]));
  const actualInventory = new Map([...actualContents].map(([path, bytes]) =>
    [path, { path, bytes: bytes.length, sha256: hash(bytes) }]));
  const client = {
    _driftState: async () => ({ state }),
    inventoryVendor: async root => root === 'src/vendor/atomic-aui'
      ? { inventory, contents, state }
      : { inventory: actualInventory, contents: actualContents, state },
  };
  const result = await verifyAtomicauiRelease(client, '7.0.0');
  assert.equal(result.releasePaths, release.output.size);
  actualInventory.get('7.0.0/manifest.json').sha256 = hash('tampered');
  await assert.rejects(verifyAtomicauiRelease(client, '7.0.0'), /release differs/);
});

test('interrupted release keeps a matching part, rewrites a mismatched part and saves exact paths once', async () => {
  const { inventory, contents, release } = fixture();
  const firstPath = [...release.output.keys()][0];
  const vendorPath = 'public/atomicaui/7.0.0/files/VENDOR.json';
  const files = new Map([[firstPath, release.output.get(firstPath)], [vendorPath, Buffer.from('corrupted')]]);
  const state = { mode: 'git', hasBaseline: true, savedVersion: 'a'.repeat(40),
    pendingPaths: [firstPath, vendorPath], isLoading: false, error: false, pendingCount: 2 };
  const writes = [], saves = [];
  const client = {
    fileKey: 'atomicaui-resume-fixture',
    projectMarker: async () => null,
    _driftState: async () => ({ state }),
    files: async () => [...files.keys()].map(path => ({ kind: 'file', path })),
    read: async path => ({ content: files.get(path).toString(), sha256: hash(files.get(path)) }),
    inventoryVendor: async () => ({ inventory, contents, state }),
    writeDurable: async (path, content, { expectedSha256 } = {}) => {
      assert.equal(expectedSha256 || null, files.has(path) ? hash(files.get(path)) : null);
      writes.push(path); files.set(path, Buffer.from(content));
      if (!state.pendingPaths.includes(path)) state.pendingPaths.push(path);
      state.pendingCount = state.pendingPaths.length;
      return { changed: true };
    },
    saveVersion: async (_title, paths) => {
      saves.push(paths); state.pendingPaths = []; state.pendingCount = 0;
      return { versionNumber: 18, gitSha: 'b'.repeat(40) };
    },
    verifyFiles: async entries => ({ verification: 'remote-content-matched', files: entries }),
  };
  const expected = [...release.output.keys()].sort();
  const result = await releaseAtomicaui(client, { requestedVersion: '7.0.0', resume: true });
  assert.equal(result.releasePaths, expected.length);
  assert.ok(!writes.includes(firstPath));
  assert.ok(writes.includes(vendorPath));
  assert.deepEqual(saves, [expected]);
  state.pendingPaths = [firstPath]; state.pendingCount = 1;
  await assert.rejects(releaseAtomicaui(client, { requestedVersion: '7.0.0', resume: true }), /immutable release/);
});

test('fake solo Make client writes provider, stylesheet, sass and vendor in one saved version', async () => {
  const { release } = fixture();
  const payload = { manifest: release.manifest, manifestSha256: hash(release.output.get('public/atomicaui/7.0.0/manifest.json')),
    files: new Map(release.manifest.files.map(item => [item.path, release.output.get(`public/atomicaui/7.0.0/files/${item.path}`)])),
    site: 'https://example.test' };
  const files = new Map([
    ['src/main.tsx', Buffer.from("import App from './App'\n<App />\n")],
    ['package.json', Buffer.from(JSON.stringify({ dependencies: { react: '^19' }, devDependencies: {} }))],
  ]);
  const saves = [];
  const state = { mode: 'git', hasBaseline: true, savedVersion: 'a'.repeat(40), pendingPaths: [], isLoading: false, error: false, pendingCount: 0 };
  const client = {
    fileKey: 'atomicaui-solo-fixture',
    projectMarker: async () => null,
    _driftState: async () => ({ state }),
    files: async () => [...files.keys()].map(path => ({ kind: 'file', path })),
    read: async path => ({ content: files.get(path).toString(), sha256: hash(files.get(path)) }),
    writeDurable: async (path, content, { expectedSha256 } = {}) => {
      assert.equal(expectedSha256 || null, files.has(path) ? hash(files.get(path)) : null);
      files.set(path, Buffer.from(content)); return { changed: true };
    },
    saveVersion: async (_title, paths) => { saves.push(paths); return { versionNumber: 4, gitSha: 'b'.repeat(40) }; },
    inventoryVendor: async () => {
      const contents = new Map([...files].filter(([path]) => path.startsWith('src/vendor/atomic-aui/'))
        .map(([path, bytes]) => [path.slice('src/vendor/atomic-aui/'.length), bytes]));
      return { contents, inventory: new Map([...contents].map(([path, bytes]) => [path, { bytes: bytes.length, sha256: hash(bytes) }])), state };
    },
  };
  const result = await installSoloRelease(client, payload, { mode: 'add' });
  assert.equal(result.savedVersion, 4);
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0], [...files.keys()].filter(path => path.startsWith('src/vendor/atomic-aui/') || path === 'src/main.tsx' || path === 'package.json').sort());
  assert.match(files.get('src/main.tsx').toString(), /AuiIdentityProvider/);
  assert.match(files.get('src/main.tsx').toString(), /tokens\/index.scss/);
  assert.equal(JSON.parse(files.get('package.json')).devDependencies.sass, '^1.89.0');
});

test('breaking notes require an exact app fix before the installation writes', async () => {
  const { inventory, contents } = fixture();
  assert.throws(() => buildRelease({ inventory, contents, version: '7.0.1', breakingChanges: [{ note: 'Button changed' }] }), /needs one or more app fixes/);
  const breakingChanges = [{ note: 'Button changed', fixes: [{ path: 'src/App.tsx', find: 'oldButton', replace: 'Button' }] }];
  const { manifest } = buildRelease({ inventory, contents, version: '7.0.1', breakingChanges });
  const fixes = await planBreakingFixes(manifest, async () => 'render(oldButton)');
  assert.equal(fixes.get('src/App.tsx').content, 'render(Button)');
  await assert.rejects(planBreakingFixes(manifest, async () => 'oldButton + oldButton'), /exactly one match/);
});
