import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRelease, DEFAULT_PART_BASE64_BYTES, downloadRelease, getBytes, installRelease, installedStatus, nextPatch,
  planBreakingFixes } from '../src/make-atomicaui.js';
import { installSoloRelease, prepareTeamBranch, releaseAtomicaui, teamChangeReport, verifyAtomicauiRelease } from '../src/commands/make-atomicaui.js';
import { defaultRun, teamContext } from '../src/make-team.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(version = '7.0.0', layout = 'direct-and-archive') {
  const source = new Map([
    ['src/index.ts', Buffer.from('export const Button = 1\n')],
    ['tokens/index.scss', Buffer.from(':root { --theme-surface: white; }\n')],
  ]);
  const vendor = Buffer.from(JSON.stringify({ schema: 1, name: 'atomic-aui', files: [...source].map(([path, bytes]) =>
    ({ path, bytes: bytes.length, sha256: hash(bytes) })) }));
  const contents = new Map([...source, ['VENDOR.json', vendor]]);
  const inventory = new Map([...contents].map(([path, bytes]) => [path, { path, bytes: bytes.length, sha256: hash(bytes) }]));
  return { source, contents, inventory, release: buildRelease({ contents, inventory, version, layout }) };
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

test('compact release serves only archive parts, manifest, sidecar and latest pointer', async () => {
  const { contents, release } = fixture('7.0.1', 'archive-only');
  const paths = [...release.output.keys()].sort();
  assert.equal(release.manifest.layout, 'archive-only');
  assert.equal(paths.length, release.manifest.archive.parts.length + 3);
  assert.equal(paths.some(path => path.includes('/files/') || path.includes('/file-parts/')), false);
  await served(release.output, async site => {
    const fetched = await downloadRelease({ site, allowHttp: true });
    for (const [path, bytes] of fetched.files) assert.ok(bytes.equals(contents.get(path)));
    assert.equal(fetched.manifest.version, '7.0.1');
    assert.equal(fetched.files.size, release.manifest.files.length);
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
  const release = buildRelease({ contents, inventory, version: '7.0.0', layout: 'direct-and-archive' });
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
  const smaller = buildRelease({ contents, inventory, version: '7.0.0', partBase64Bytes: 256 * 1024,
    layout: 'direct-and-archive' });
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

test('an older release keeps its folder but leaves latest.json at the newest release', async () => {
  const { inventory, contents } = fixture();
  const files = new Map();
  const state = { mode: 'git', hasBaseline: true, savedVersion: 'a'.repeat(40), pendingPaths: [], isLoading: false, error: false, pendingCount: 0 };
  const written = [];
  const client = {
    fileKey: 'atomicaui-latest-fixture', projectMarker: async () => null,
    _driftState: async () => ({ state }),
    files: async () => [...files.keys()].map(path => ({ kind: 'file', path })),
    read: async path => ({ content: files.get(path).toString(), sha256: hash(files.get(path)) }),
    inventoryVendor: async () => ({ inventory, contents, state }),
    writeDurable: async (path, content, { expectedSha256 } = {}) => {
      assert.equal(expectedSha256 || null, files.has(path) ? hash(files.get(path)) : null);
      written.push(path); files.set(path, Buffer.from(content)); return { changed: true };
    },
    saveVersion: async () => ({ versionNumber: 1, gitSha: 'a'.repeat(40) }),
    verifyFiles: async entries => ({ verification: 'remote-content-matched', files: entries }),
  };
  const latest = () => JSON.parse(files.get('public/atomicaui/latest.json')).version;
  await releaseAtomicaui(client, { requestedVersion: '7.1.0' });
  assert.equal(latest(), '7.1.0');
  written.length = 0;
  const backport = await releaseAtomicaui(client, { requestedVersion: '7.0.6' });
  assert.equal(latest(), '7.1.0');
  assert.equal(written.includes('public/atomicaui/latest.json'), false);
  assert.ok(written.includes('public/atomicaui/7.0.6/manifest.json'));
  assert.equal(backport.latest, '7.1.0');
  assert.match(backport.latestNote, /latest\.json still points at 7\.1\.0/);
  const next = await releaseAtomicaui(client, {});
  assert.equal(next.version, '7.1.1');
  assert.equal(latest(), '7.1.1');
});

test('saved release verifier checks an older release against its own manifest and every saved path', async () => {
  const older = fixture('7.0.0').release;
  const newer = fixture('7.0.1', 'archive-only').release;
  const state = { mode: 'git', hasBaseline: true, savedVersion: 'a'.repeat(40),
    pendingPaths: [], isLoading: false, error: false, pendingCount: 0 };
  const actualContents = new Map([...older.output, ...newer.output].map(([path, bytes]) =>
    [path.slice('public/atomicaui/'.length), bytes]));
  const inventoryOf = () => new Map([...actualContents].map(([path, bytes]) => [path, { path, bytes: bytes.length, sha256: hash(bytes) }]));
  let actualInventory = inventoryOf();
  const client = {
    _driftState: async () => ({ state }),
    inventoryVendor: async root => {
      assert.equal(root, 'public/atomicaui');
      return { inventory: actualInventory, contents: actualContents, state };
    },
  };
  const old = await verifyAtomicauiRelease(client, '7.0.0');
  assert.equal(old.releasePaths, older.output.size - 1);
  assert.equal(old.latest, false);
  const current = await verifyAtomicauiRelease(client, '7.0.1');
  assert.equal(current.latest, true);
  actualContents.set('7.0.0/extra.txt', Buffer.from('extra'));
  actualInventory = inventoryOf();
  await assert.rejects(verifyAtomicauiRelease(client, '7.0.0'), /path set differs/);
  actualContents.delete('7.0.0/extra.txt');
  actualContents.set('7.0.0/manifest.json', Buffer.from('tampered'));
  actualInventory = inventoryOf();
  await assert.rejects(verifyAtomicauiRelease(client, '7.0.0'), /release differs/);
  actualContents.set('7.0.0/manifest.json', older.output.get('public/atomicaui/7.0.0/manifest.json'));
  actualContents.set('latest.json', Buffer.from(JSON.stringify({ ...newer.latest, manifestSha256: '0'.repeat(64) })));
  actualInventory = inventoryOf();
  await assert.rejects(verifyAtomicauiRelease(client, '7.0.1'), /latest\.json/);
});

test('interrupted release keeps a matching part, rewrites a mismatched part and saves exact paths once', async () => {
  const { inventory, contents, release } = fixture('7.0.0', 'archive-only');
  const firstPath = [...release.output.keys()][0];
  const manifestPath = 'public/atomicaui/7.0.0/manifest.json';
  const files = new Map([[firstPath, release.output.get(firstPath)], [manifestPath, Buffer.from('corrupted')]]);
  const state = { mode: 'git', hasBaseline: true, savedVersion: 'a'.repeat(40),
    pendingPaths: [firstPath, manifestPath], isLoading: false, error: false, pendingCount: 2 };
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
  assert.ok(writes.includes(manifestPath));
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
    writeDurable: async (path, content, { expectedSha256, vendorTreeFallback } = {}) => {
      assert.equal(expectedSha256 || null, files.has(path) ? hash(files.get(path)) : null);
      assert.equal(vendorTreeFallback, path.startsWith('src/vendor/atomic-aui/'));
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

test('solo add resumes only exact pending release files and saves them once', async () => {
  const { release } = fixture();
  const payload = { manifest: release.manifest, manifestSha256: hash(release.output.get('public/atomicaui/7.0.0/manifest.json')),
    files: new Map(release.manifest.files.map(item => [item.path, release.output.get(`public/atomicaui/7.0.0/files/${item.path}`)])),
    site: 'https://example.test' };
  const first = 'src/vendor/atomic-aui/src/index.ts';
  const files = new Map([
    [first, payload.files.get('src/index.ts')],
    ['src/main.tsx', Buffer.from("import App from './App'\n<App />\n")],
    ['package.json', Buffer.from(JSON.stringify({ dependencies: { react: '^19' }, devDependencies: {} }))],
  ]);
  const state = { mode: 'git', hasBaseline: true, savedVersion: 'a'.repeat(40), pendingPaths: [first],
    isLoading: false, error: false, pendingCount: 1 };
  const saves = [], writes = [];
  const client = {
    fileKey: 'atomicaui-resume-solo-fixture', projectMarker: async () => null,
    _driftState: async () => ({ state }),
    files: async () => [...files.keys()].map(path => ({ kind: 'file', path })),
    read: async path => ({ content: files.get(path).toString(), sha256: hash(files.get(path)) }),
    readSaved: async paths => new Map(paths.map(path => [path, path === first || !files.has(path) ? null : files.get(path).toString()])),
    inventoryVendor: async () => {
      const contents = new Map([...files].filter(([path]) => path.startsWith('src/vendor/atomic-aui/'))
        .map(([path, bytes]) => [path.slice('src/vendor/atomic-aui/'.length), bytes]));
      return { contents, inventory: new Map([...contents].map(([path, bytes]) =>
        [path, { bytes: bytes.length, sha256: hash(bytes) }])), state };
    },
    writeDurable: async (path, content, { expectedSha256, vendorTreeFallback } = {}) => {
      assert.equal(expectedSha256 || null, files.has(path) ? hash(files.get(path)) : null);
      assert.equal(vendorTreeFallback, path.startsWith('src/vendor/atomic-aui/'));
      writes.push(path); files.set(path, Buffer.from(content));
      if (!state.pendingPaths.includes(path)) state.pendingPaths.push(path);
      state.pendingCount = state.pendingPaths.length;
      return { changed: true };
    },
    saveVersion: async (_title, paths) => {
      assert.deepEqual(paths, [...state.pendingPaths].sort());
      saves.push(paths); state.pendingPaths = []; state.pendingCount = 0;
      return { versionNumber: 4, gitSha: 'b'.repeat(40) };
    },
  };
  files.set(first, Buffer.from('local edit'));
  await assert.rejects(installSoloRelease(client, payload, { mode: 'add', resume: true }), /differs from the verified release/);
  assert.deepEqual(writes, []);
  files.set(first, payload.files.get('src/index.ts'));
  const result = await installSoloRelease(client, payload, { mode: 'add', resume: true });
  assert.equal(result.savedVersion, 4);
  assert.equal(saves.length, 1);
  assert.ok(!writes.includes(first));
  assert.ok(files.has('src/vendor/atomic-aui/VENDOR.json'));
});

function soloPayload(version = '7.0.0', source = { 'src/index.ts': 'export const Button = 1\n', 'tokens/index.scss': ':root {}\n' },
  breakingChanges = []) {
  const bytes = new Map(Object.entries(source).map(([path, text]) => [path, Buffer.from(text)]));
  const vendor = Buffer.from(JSON.stringify({ schema: 1, name: 'atomic-aui', files: [...bytes].map(([path, value]) =>
    ({ path, bytes: value.length, sha256: hash(value) })) }));
  const contents = new Map([...bytes, ['VENDOR.json', vendor]]);
  const inventory = new Map([...contents].map(([path, value]) => [path, { path, bytes: value.length, sha256: hash(value) }]));
  const release = buildRelease({ contents, inventory, version, breakingChanges, layout: 'direct-and-archive' });
  return { manifest: release.manifest, manifestSha256: hash(release.output.get(`public/atomicaui/${version}/manifest.json`)),
    files: new Map(release.manifest.files.map(item => [item.path, release.output.get(`public/atomicaui/${version}/files/${item.path}`)])),
    site: 'https://example.test' };
}
function soloMake(files, pendingPaths = [], saved = new Map(files)) {
  const state = { mode: 'git', hasBaseline: true, savedVersion: 'a'.repeat(40), pendingPaths: [...pendingPaths],
    isLoading: false, error: false, pendingCount: pendingPaths.length };
  const writes = [], saves = [], titles = [];
  const touch = path => { if (!state.pendingPaths.includes(path)) state.pendingPaths.push(path); state.pendingCount = state.pendingPaths.length; };
  const vendorScan = () => {
    const contents = new Map([...files].filter(([path]) => path.startsWith('src/vendor/atomic-aui/'))
      .map(([path, value]) => [path.slice('src/vendor/atomic-aui/'.length), value]));
    return { contents, inventory: new Map([...contents].map(([path, value]) => [path, { bytes: value.length, sha256: hash(value) }])), state };
  };
  const client = {
    fileKey: 'atomicaui-solo-resume', projectMarker: async () => null,
    _driftState: async () => ({ state }),
    files: async () => [...files.keys()].map(path => ({ kind: 'file', path })),
    read: async path => ({ content: files.get(path).toString(), sha256: hash(files.get(path)) }),
    inventoryVendor: async () => vendorScan(),
    readSaved: async paths => new Map(paths.map(path => [path, saved.has(path) ? saved.get(path).toString() : null])),
    writeDurable: async (path, content, { expectedSha256 } = {}) => {
      assert.equal(expectedSha256 || null, files.has(path) ? hash(files.get(path)) : null);
      writes.push(path); files.set(path, Buffer.from(content)); touch(path);
      return { changed: true };
    },
    deleteDurable: async (path, { expectedSha256 } = {}) => {
      assert.equal(expectedSha256, hash(files.get(path)));
      writes.push(path); files.delete(path); touch(path);
    },
    saveVersion: async (title, paths) => {
      assert.deepEqual([...paths].sort(), [...state.pendingPaths].sort());
      saves.push(paths); titles.push(title); state.pendingPaths = []; state.pendingCount = 0;
      return { versionNumber: 9, gitSha: 'b'.repeat(40) };
    },
  };
  return { client, files, writes, saves, titles, state };
}
const plainApp = () => new Map([
  ['src/main.tsx', Buffer.from("import App from './App'\n<App />\n")],
  ['src/App.tsx', Buffer.from('render(oldButton)\n')],
  ['package.json', Buffer.from(JSON.stringify({ dependencies: { react: '^19' }, devDependencies: {} }))],
]);

test('interrupted solo add resumes after wiring or VENDOR.json was written, and refuses foreign pending content', async () => {
  const breakingChanges = [{ note: 'Button renamed', fixes: [{ path: 'src/App.tsx', find: 'oldButton', replace: 'Button' }] }];
  const payload = soloPayload('7.0.0', undefined, breakingChanges);
  const complete = soloMake(plainApp());
  await installSoloRelease(complete.client, payload, { mode: 'add' });
  const finished = new Map(complete.files);
  assert.equal(finished.get('src/App.tsx').toString(), 'render(Button)\n');
  const vendorPath = 'src/vendor/atomic-aui/VENDOR.json';
  const changedPaths = [...finished.keys()].filter(path => !plainApp().has(path) || !plainApp().get(path).equals(finished.get(path)));
  for (const written of [changedPaths.filter(path => path !== vendorPath), changedPaths]) {
    const files = plainApp();
    for (const path of written) files.set(path, finished.get(path));
    const make = soloMake(files, written, plainApp());
    const result = await installSoloRelease(make.client, payload, { mode: 'add', resume: true });
    assert.deepEqual(make.writes, changedPaths.filter(path => !written.includes(path)));
    assert.deepEqual([...make.saves[0]].sort(), [...changedPaths].sort());
    assert.deepEqual(result.report.added, ['src/index.ts', 'tokens/index.scss']);
    for (const [path, value] of finished) assert.ok(make.files.get(path).equals(value), path);
  }
  const foreign = plainApp();
  foreign.set('src/main.tsx', Buffer.from("import App from './App'\n<App />\n// my own edit\n"));
  const refused = soloMake(foreign, ['src/main.tsx'], plainApp());
  await assert.rejects(installSoloRelease(refused.client, payload, { mode: 'add', resume: true }), /differs from the verified release: src\/main.tsx/);
  const fixed = plainApp();
  fixed.set('src/App.tsx', Buffer.from('render(somethingElse)\n'));
  const wrongFix = soloMake(fixed, ['src/App.tsx'], plainApp());
  await assert.rejects(installSoloRelease(wrongFix.client, payload, { mode: 'add', resume: true }), /src\/App.tsx/);
  assert.deepEqual([...refused.writes, ...wrongFix.writes], []);
});

test('interrupted solo upgrade resumes from the saved version and refuses foreign pending app edits', async () => {
  const older = soloPayload('7.0.0', { 'src/index.ts': 'one\n', 'src/old.ts': 'old\n' });
  const newer = soloPayload('7.0.1', { 'src/index.ts': 'two\n', 'src/new.ts': 'new\n' });
  const installed = soloMake(plainApp());
  await installSoloRelease(installed.client, older, { mode: 'add' });
  const savedFiles = new Map(installed.files);
  const complete = soloMake(new Map(savedFiles));
  await installSoloRelease(complete.client, newer, { mode: 'upgrade' });
  const vendorPath = 'src/vendor/atomic-aui/VENDOR.json';
  const steps = ['src/vendor/atomic-aui/src/index.ts', 'src/vendor/atomic-aui/src/old.ts', 'src/vendor/atomic-aui/src/new.ts', vendorPath];
  for (const done of [steps.slice(0, 2), steps]) {
    const files = new Map(savedFiles);
    for (const path of done) if (complete.files.has(path)) files.set(path, complete.files.get(path)); else files.delete(path);
    const make = soloMake(files, done, savedFiles);
    const result = await installSoloRelease(make.client, newer, { mode: 'upgrade', resume: true });
    assert.deepEqual([result.report.from, result.report.added, result.report.changed, result.report.removed],
      ['7.0.0', ['src/new.ts'], ['src/index.ts'], ['src/old.ts']]);
    assert.deepEqual(make.writes, steps.filter(path => !done.includes(path)));
    for (const [path, value] of complete.files) assert.ok(make.files.get(path).equals(value), path);
  }
  const wired = new Map(savedFiles);
  wired.set('src/main.tsx', Buffer.from(`${savedFiles.get('src/main.tsx')}// my own edit\n`));
  const foreign = soloMake(wired, ['src/main.tsx'], savedFiles);
  await assert.rejects(installSoloRelease(foreign.client, newer, { mode: 'upgrade', resume: true }), /differs from the verified release: src\/main.tsx/);
  const stale = new Map(savedFiles);
  stale.set('src/vendor/atomic-aui/src/index.ts', Buffer.from('half written'));
  const refused = soloMake(stale, ['src/vendor/atomic-aui/src/index.ts'], savedFiles);
  await assert.rejects(installSoloRelease(refused.client, newer, { mode: 'upgrade', resume: true }), /differs from the verified release/);
  assert.deepEqual([...foreign.writes, ...refused.writes], []);
});

test('unpinned solo upgrade never moves backward; a pinned lower version is a labelled downgrade', async () => {
  const older = soloPayload('7.0.0', { 'src/index.ts': 'one\n' });
  const newer = soloPayload('7.0.1', { 'src/index.ts': 'two\n' });
  const installed = soloMake(plainApp());
  await installSoloRelease(installed.client, newer, { mode: 'add' });
  for (const target of [older, newer]) {
    const make = soloMake(new Map(installed.files));
    const result = await installSoloRelease(make.client, target, { mode: 'upgrade' });
    assert.deepEqual([result.upToDate, result.installedVersion, make.writes, make.saves], [true, '7.0.1', [], []]);
    assert.match(result.summary, /already the newest/);
  }
  const make = soloMake(new Map(installed.files));
  const result = await installSoloRelease(make.client, older, { mode: 'upgrade', pinned: true });
  assert.equal(result.report.downgrade, true);
  assert.deepEqual([result.report.from, result.report.to, result.report.changed], ['7.0.1', '7.0.0', ['src/index.ts']]);
  assert.deepEqual(make.titles, ['AtomicAUI 7.0.0 downgrade']);
  assert.match(result.summary, /^Downgrade: AtomicAUI 7\.0\.1 to 7\.0\.0/);
  const forward = soloMake(new Map(installed.files));
  const pinnedNewer = await installSoloRelease(forward.client, soloPayload('7.0.2', { 'src/index.ts': 'three\n' }), { mode: 'upgrade', pinned: true });
  assert.equal(pinnedNewer.report.downgrade, undefined);
  assert.deepEqual(forward.titles, ['AtomicAUI 7.0.2 upgrade']);
});

test('team pull request report labels a downgrade', t => {
  const team = teamClone(t);
  const body = teamChangeReport(team.ctx(), { from: '7.0.1', to: '7.0.0', downgrade: true, added: [], changed: ['index.ts'], removed: [],
    breakingChanges: [] });
  assert.equal(body.split('\n')[0], 'Downgrade: AtomicAUI 7.0.1 to 7.0.0.');
});

test('team pull request report lists the files actually changed and the breaking notes', t => {
  const team = teamClone(t);
  prepareTeamBranch(team.ctx(), { mode: 'add', manifest: teamManifest });
  team.commitAs({ 'src/vendor/atomic-aui/VENDOR.json': '{}\n', 'src/vendor/atomic-aui/index.ts': 'x\n', 'src/App.tsx': 'fixed\n', 'package-lock.json': '{}\n' });
  const body = teamChangeReport(team.ctx(), { from: null, to: '7.0.0', added: ['index.ts'], changed: [], removed: [],
    breakingChanges: [{ note: 'Button renamed', fixes: [] }] });
  assert.deepEqual(body.split('\n'), ['AtomicAUI not installed to 7.0.0.', '',
    '- src/vendor/atomic-aui/: 1 added, 0 changed, 0 removed', '- package-lock.json', '- src/App.tsx', '',
    'Breaking changes fixed in this pull request:', '- Button renamed']);
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

function teamClone(t, pulls = []) {
  const root = mkdtempSync(join(tmpdir(), 'atomicaui-team-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'gitconfig'), '[user]\n\tname = Alice\n\temail = alice@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const env = { GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const git = (dir, ...args) => {
    const result = defaultRun('git', args, { cwd: dir });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const origin = join(root, 'origin.git'), clone = join(root, 'clone');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, clone);
  const put = files => { for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(clone, path, '..'), { recursive: true });
    writeFileSync(join(clone, path), content);
  } };
  put({ '.figma-cli/project.json': JSON.stringify({ fileKey: 'K', repo: 'owner/proto', trunk: 'main' }), 'src/App.tsx': 'app\n',
    'src/main.tsx': 'main\n', 'package.json': '{}\n' });
  git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'initial'); git(clone, 'push', '-q', 'origin', 'main');
  const warnings = [];
  const run = (command, args, options) => {
    if (command === 'git') return defaultRun(command, args, options);
    if (command === 'gh' && args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: 'alice\n', stderr: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(pulls), stderr: '' };
    return { status: 1, stdout: '', stderr: `unexpected ${command} ${args.join(' ')}` };
  };
  const ctx = () => teamContext({ dir: clone, run, warn: message => warnings.push(message) });
  const commitAs = (files, author = 'Alice <alice@example.invalid>') => {
    put(files); git(clone, 'add', '-A'); git(clone, 'commit', '-q', '--author', author, '-m', 'work');
  };
  return { clone, git, put, ctx, commitAs, warnings };
}
const teamManifest = { version: '7.0.0', breakingChanges: [] };
const BRANCH = 'alice/atomicaui-add-7-0-0';

test('team add continues only its own unfinished branch, with unsaved vendor files', t => {
  const team = teamClone(t);
  assert.deepEqual(prepareTeamBranch(team.ctx(), { mode: 'add', manifest: teamManifest }), { branch: BRANCH, continued: false });
  team.commitAs({ 'src/vendor/atomic-aui/VENDOR.json': '{}\n', 'src/main.tsx': 'wired\n' });
  team.git(team.clone, 'switch', '-q', 'main');
  assert.deepEqual(prepareTeamBranch(team.ctx(), { mode: 'add', manifest: teamManifest }), { branch: BRANCH, continued: true });
  assert.equal(team.git(team.clone, 'branch', '--show-current'), BRANCH);
  team.put({ 'src/vendor/atomic-aui/index.ts': 'partial\n' });
  assert.equal(prepareTeamBranch(team.ctx(), { mode: 'add', manifest: teamManifest }).continued, true);
  assert.deepEqual(team.warnings, ['Continuing your earlier AtomicAUI update.', 'Continuing your earlier AtomicAUI update.']);
});

test('team add refuses its branch once its pull request is merged or closed', t => {
  for (const state of ['MERGED', 'CLOSED']) {
    const team = teamClone(t, [{ url: 'https://github.com/owner/proto/pull/1', state, headRefName: BRANCH, isCrossRepository: false }]);
    prepareTeamBranch(team.ctx(), { mode: 'add', manifest: teamManifest });
    team.git(team.clone, 'switch', '-q', 'main');
    assert.throws(() => prepareTeamBranch(team.ctx(), { mode: 'add', manifest: teamManifest }),
      error => error.code === 'TEAM_BRANCH_EXISTS' && error.message.includes(state.toLowerCase()));
    assert.equal(team.git(team.clone, 'branch', '--show-current'), 'main');
  }
});

test('team add refuses to continue a branch with foreign saves, paths or unsaved files', t => {
  const cases = [
    team => team.commitAs({ 'src/vendor/atomic-aui/VENDOR.json': '{}\n' }, 'Bob <bob@example.invalid>'),
    team => team.commitAs({ 'src/App.tsx': 'other task\n' }),
    team => team.put({ 'src/App.tsx': 'unsaved\n' }),
  ];
  for (const change of cases) {
    const team = teamClone(t);
    prepareTeamBranch(team.ctx(), { mode: 'add', manifest: teamManifest });
    change(team);
    assert.throws(() => prepareTeamBranch(team.ctx(), { mode: 'add', manifest: teamManifest }),
      error => ['TEAM_BRANCH_EXISTS', 'TEAM_UNSAVED'].includes(error.code) && /Nothing was changed/.test(error.message));
    assert.deepEqual(team.warnings, []);
  }
});
