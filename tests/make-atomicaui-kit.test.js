import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateVendor, checkGuides, globRegExp, guideNames, guideSource, inventoryDigest, libraryInventory,
  transformGuide } from '../src/make-atomicaui-kit.js';
import { digest, vendorManifest } from '../src/make-drift.js';

const PKG = '@example/design-atomic-aui';
const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
const SCRIPT = fileURLToPath(new URL('../src/make-atomicaui-kit.js', import.meta.url));
const header = (name, commit = 'abcdef012345') => [
  '> **AtomicAUI 7.0 Make kit copy.** Adapted from the AtomicAUI workspace consume-doc',
  `> \`component-classes/${name}.md\` at commit \`${commit}\`. Import from \`@/vendor/atomic-aui\` in this`,
  '> project (or the kit\'s root export elsewhere). Source paths such as `src/lib/…`, `core/…` and',
  '> `tokens/…` are under `src/vendor/atomic-aui/`; `[[wiki links]]`, `apps/…` play pages and `yarn`',
  '> commands refer to the upstream workspace and are not part of this kit. Synced with the library —',
  '> do not edit.',
];

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'atomicaui-kit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
const entry = (path, content) => ({ path, sha256: digest(Buffer.from(content)), bytes: Buffer.byteLength(content) });
const vendorText = value => `${JSON.stringify(value, null, 2)}\n`;

test('transform replaces the package, stylesheet and Core name, then puts the header after frontmatter', () => {
  const source = ['---', 'title: Button', '---', '', '# Button', '',
    `import { Button } from '${PKG}'`, `import "${PKG}"`, `@import '${PKG}/index.css';`,
    'Figma file AtomicAUI Core 6.0 (AtomicAUI-Core-6.0); library AtomicAUI 6.0 stays.', ''].join('\n');
  assert.equal(transformGuide(source, { name: 'button', commit: COMMIT, packageName: PKG }), [
    '---', 'title: Button', '---', '', ...header('button'), '', '# Button', '',
    'import { Button } from \'@/vendor/atomic-aui\'', 'import "@/vendor/atomic-aui"',
    '@import \'src/vendor/atomic-aui/tokens/index.scss\';',
    'Figma file AtomicAUI Core 7.0 (AtomicAUI-Core-7.0); library AtomicAUI 6.0 stays.', ''].join('\n'));
});

test('without frontmatter the header goes after the H1 and its blank line, or straight after the H1', () => {
  assert.equal(transformGuide('# Card\n\nBody\n', { name: 'card', commit: COMMIT, packageName: PKG }),
    ['# Card', '', ...header('card'), '', 'Body', ''].join('\n'));
  assert.equal(transformGuide('intro\n# Card\nBody', { name: 'card', commit: COMMIT, packageName: PKG }),
    ['intro', '# Card', ...header('card'), '', 'Body'].join('\n'));
  // Frontmatter with no blank line after it keeps the next line directly below the header.
  assert.equal(transformGuide('---\na: 1\n---\n# T', { name: 't', commit: COMMIT, packageName: PKG }),
    ['---', 'a: 1', '---', ...header('t'), '', '# T'].join('\n'));
});

test('transform refuses input it cannot place or would rewrite unpredictably', () => {
  const opts = { name: 'x', commit: COMMIT, packageName: PKG };
  assert.throws(() => transformGuide('no heading here\n', opts), { code: 'KIT_BAD_GUIDE' });
  assert.throws(() => transformGuide('---\ntitle: x\n# X\n', opts), { code: 'KIT_BAD_GUIDE' });
  assert.throws(() => transformGuide('# X\r\n', opts), { code: 'KIT_CRLF' });
  assert.throws(() => transformGuide('# X\n', { ...opts, commit: 'abc' }), { code: 'KIT_BAD_COMMIT' });
  assert.throws(() => transformGuide('# X\n', { ...opts, commit: COMMIT.toUpperCase() }), { code: 'KIT_BAD_COMMIT' });
  assert.throws(() => transformGuide('# X\n', { ...opts, packageName: '' }), { code: 'KIT_BAD_PACKAGE' });
  assert.throws(() => transformGuide('# X\n', { ...opts, name: '../x' }), { code: 'KIT_BAD_NAME' });
});

test('guideSource reads back the doc name and commit the header records', () => {
  const kit = transformGuide('# List\n\nx\n', { name: 'list', commit: COMMIT, packageName: PKG });
  assert.deepEqual(guideSource(kit), { name: 'list', commit: 'abcdef012345' });
  assert.equal(guideSource('# List\n'), null);
});

test('check replays kit guides from their sources and sorts every other case out', t => {
  const root = temp(t);
  const src = join(root, 'src'), kit = join(root, 'kit');
  const other = '0123456789ab';
  for (const name of ['alpha', 'beta', 'gamma', 'delta', 'fresh']) put(src, `${name}.md`, `# ${name}\n\nv1\n`);
  put(src, '_template.md', '# template\n');
  put(kit, 'alpha.md', transformGuide('# alpha\n\nv1\n', { name: 'alpha', commit: COMMIT, packageName: PKG }));
  put(kit, 'beta.md', `${transformGuide('# beta\n\nv1\n', { name: 'beta', commit: COMMIT, packageName: PKG })}hand note\n`);
  put(kit, 'gamma.md', transformGuide('# gamma\n\nv0\n', { name: 'gamma', commit: other, packageName: PKG }));
  put(kit, 'delta.md', '# delta\n\nedited without a header\n');
  put(kit, 'gone.md', transformGuide('# gone\n', { name: 'gone', commit: COMMIT, packageName: PKG }));
  const alpha = readFileSync(join(kit, 'alpha.md'), 'utf8');
  const vendorBytes = Buffer.from(vendorText({ guidance: { target: 'guidelines/components', files: [
    entry('guidelines/components/alpha.md', alpha), entry('guidelines/components/beta.md', 'old') ] } }));
  const result = checkGuides({ sourceDir: src, kitDir: kit, commit: COMMIT, packageName: PKG, vendorBytes });
  assert.deepEqual(result, {
    commit: 'abcdef012345', matched: ['alpha'], differs: ['beta'], noSource: ['gone'],
    otherCommit: [{ name: 'gamma', commit: other }], noHeader: ['delta'], notInKit: ['fresh'],
    recorded: { matched: ['alpha'], differs: ['beta'], absent: ['delta', 'gamma', 'gone'] },
  });
  assert.deepEqual(guideNames(src), ['alpha', 'beta', 'delta', 'fresh', 'gamma']);
});

test('exclusions are anchored globs where **/ also matches the library root', () => {
  const spec = globRegExp('**/*.spec.*'), gates = globRegExp('__gates__/**');
  assert.ok(spec.test('a.spec.ts') && spec.test('lib/x/a.spec.tsx'));
  assert.ok(!spec.test('lib/spec.ts') && !spec.test('lib/a.specs'));
  assert.ok(gates.test('__gates__/drift.spec.ts') && gates.test('__gates__/a/b.ts'));
  assert.ok(!gates.test('lib/__gates__/x.ts'));
  assert.ok(globRegExp('lib/?.ts').test('lib/a.ts') && !globRegExp('lib/?.ts').test('lib/ab.ts'));
  assert.ok(globRegExp('a+b.ts').test('a+b.ts') && !globRegExp('a+b.ts').test('aab.ts'));
});

function library(t, files) {
  const root = temp(t);
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  return root;
}
function baselineFor(files, extra = {}) {
  return {
    schema: 1, name: 'atomic-aui',
    source: { repository: 'owner/workspace', path: 'lib/src', commit: '1'.repeat(40), commitDate: '2026-01-01T00:00:00Z' },
    exclusions: ['**/*.spec.*', '__gates__/**'],
    guidance: { source: 'docs', target: 'guidelines/components', transform: 'recorded',
      files: [entry('guidelines/components/a.md', 'A'), entry('guidelines/components/c.md', 'C')] },
    // Kept in the baseline's own order, which is not strictly sorted.
    files: Object.entries(files).map(([path, content]) => entry(path, content)),
    ...extra,
  };
}

test('candidate VENDOR.json changes only source, files and guidance, keeping order and format', t => {
  const baseFiles = { 'index.ts': 'x', 'lib/b.ts': 'b1', 'lib/d.ts': 'd', 'tokens/_state.scss': 's1',
    'tokens/generated/_index.scss': 'i', 'tokens/generated/.generated': 'g' };
  const base = library(t, { ...baseFiles, 'lib/b.spec.ts': 'test', '__gates__/gate.ts': 'gate' });
  const next = library(t, { 'tokens/generated/_index.scss': 'i', 'tokens/generated/.generated': 'g', 'lib/b.ts': 'b2',
    'lib/c.ts': 'c', 'index.ts': 'x', 'tokens/_state.scss': 's2', 'lib/b-extra/a.ts': 'e', 'lib/b.spec.ts': 'changed test' });
  const baseline = baselineFor(baseFiles);
  const guides = new Map([['b', Buffer.from('B')], ['c', Buffer.from('C2')], ['a', Buffer.from('A')]]);
  const result = candidateVendor({ baselineBytes: Buffer.from(vendorText(baseline)), baseLibrary: base, library: next,
    commit: '2'.repeat(40), commitDate: '2026-02-02T00:00:00+07:00', guides });
  assert.deepEqual([result.added, result.changed, result.removed], [['lib/b-extra/a.ts', 'lib/c.ts'], ['lib/b.ts', 'tokens/_state.scss'], ['lib/d.ts']]);
  assert.deepEqual(result.guidance, { added: ['guidelines/components/b.md'], changed: ['guidelines/components/c.md'],
    unchanged: ['guidelines/components/a.md'] });
  const out = JSON.parse(result.bytes.toString('utf8'));
  assert.equal(result.bytes.toString('utf8'), vendorText(out));
  assert.equal(result.sha256, digest(result.bytes));
  assert.deepEqual(out.files.map(file => file.path), ['index.ts', 'lib/b-extra/a.ts', 'lib/b.ts', 'lib/c.ts',
    'tokens/_state.scss', 'tokens/generated/_index.scss', 'tokens/generated/.generated']);
  assert.deepEqual(Object.keys(out.files[1]), ['path', 'sha256', 'bytes']);
  assert.deepEqual(out.files.find(file => file.path === 'lib/b.ts'), entry('lib/b.ts', 'b2'));
  assert.deepEqual(out.source, { ...baseline.source, commit: '2'.repeat(40), commitDate: '2026-02-02T00:00:00+07:00' });
  assert.deepEqual(out.guidance.files.map(file => file.path),
    ['guidelines/components/a.md', 'guidelines/components/b.md', 'guidelines/components/c.md']);
  assert.deepEqual({ ...out, files: null, source: null, guidance: null }, { ...baseline, files: null, source: null, guidance: null });
  assert.equal(result.fileCount, 7);
  assert.equal(result.inventoryDigest, inventoryDigest(libraryInventory(next, baseline.exclusions)));
  assert.equal(vendorManifest(result.bytes).files.size, 7);
});

test('the Core token gate stops on any generated token or generation manifest change', t => {
  const baseFiles = { 'tokens/generated/a.scss': 'a', 'lib/x.ts': 'x' };
  const base = library(t, baseFiles);
  const run = files => candidateVendor({ baselineBytes: Buffer.from(vendorText(baselineFor(baseFiles))), baseLibrary: base,
    library: library(t, files), commit: '2'.repeat(40), commitDate: 'd' });
  assert.throws(() => run({ 'tokens/generated/a.scss': 'changed', 'lib/x.ts': 'x' }),
    error => error.code === 'KIT_TOKEN_GATE' && error.paths.join() === 'tokens/generated/a.scss');
  assert.throws(() => run({ 'lib/x.ts': 'x' }), { code: 'KIT_TOKEN_GATE' });
  assert.throws(() => run({ ...baseFiles, 'tokens/generated.manifest.json': '{}' }),
    error => error.code === 'KIT_TOKEN_GATE' && error.paths.join() === 'tokens/generated.manifest.json');
  assert.equal(run({ ...baseFiles, 'tokens/_hand.scss': 'styling' }).added.join(), 'tokens/_hand.scss');
});

test('the base workspace tree must reproduce the baseline before a candidate is written', t => {
  const baseFiles = { 'lib/x.ts': 'x' };
  const base = library(t, { 'lib/x.ts': 'other' });
  const baselineBytes = Buffer.from(vendorText(baselineFor(baseFiles)));
  assert.throws(() => candidateVendor({ baselineBytes, baseLibrary: base, library: base, commit: '2'.repeat(40), commitDate: 'd' }),
    error => error.code === 'KIT_BASE_DIFFERS' && error.paths.join() === 'lib/x.ts');
  assert.throws(() => candidateVendor({ baselineBytes, library: base, commit: '2'.repeat(40), commitDate: 'd' }), { code: 'KIT_BAD_SOURCE' });
  assert.throws(() => candidateVendor({ baselineBytes, baseLibrary: base, library: base, commit: '2'.repeat(12), commitDate: 'd' }),
    { code: 'KIT_BAD_SOURCE' });
  const compact = Buffer.from(JSON.stringify(baselineFor(baseFiles)));
  assert.throws(() => candidateVendor({ baselineBytes: compact, guides: new Map([['a', Buffer.from('A')]]) }), { code: 'KIT_FORMAT' });
  const withVendor = library(t, { 'lib/x.ts': 'x', 'VENDOR.json': '{}' });
  assert.throws(() => libraryInventory(withVendor), { code: 'KIT_BAD_LIBRARY' });
  const linked = library(t, { 'lib/x.ts': 'x' });
  // Windows may refuse file symlinks without developer mode; the refusal is then untestable here.
  let linkedOk = true;
  try { symlinkSync(join(linked, 'lib/x.ts'), join(linked, 'lib/y.ts')); } catch { linkedOk = false; }
  if (linkedOk) assert.throws(() => libraryInventory(linked), { code: 'KIT_SYMLINK' });
});

test('a guides-only candidate leaves source and files untouched', t => {
  const baseline = baselineFor({ 'lib/x.ts': 'x' });
  const result = candidateVendor({ baselineBytes: Buffer.from(vendorText(baseline)), guides: new Map([['a', Buffer.from('A2')]]) });
  const out = JSON.parse(result.bytes.toString('utf8'));
  assert.deepEqual(out.files, baseline.files);
  assert.deepEqual(out.source, baseline.source);
  assert.deepEqual(out.guidance.files[0], entry('guidelines/components/a.md', 'A2'));
  assert.equal(result.inventoryDigest, undefined);
});

function cli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', shell: false });
}

test('the script writes guides and a candidate into new paths only and reports errors as JSON', t => {
  const root = temp(t);
  put(join(root, 'docs'), 'list.md', '# List\n\nx\n');
  put(join(root, 'docs'), '_template.md', '# T\n');
  let result = cli(['transform', '--source', join(root, 'docs'), '--commit', COMMIT, '--package', PKG, '--out', join(root, 'out')]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(join(root, 'out')), ['list.md']);
  assert.equal(JSON.parse(result.stdout).files[0].sha256, digest(readFileSync(join(root, 'out/list.md'))));
  result = cli(['transform', '--source', join(root, 'docs'), '--commit', COMMIT, '--package', PKG, '--out', join(root, 'out')]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, 'KIT_OUTPUT_EXISTS');
  result = cli(['check', '--source', join(root, 'docs'), '--commit', COMMIT, '--package', PKG, '--kit', join(root, 'out')]);
  assert.deepEqual(JSON.parse(result.stdout).matched, ['list']);
  put(root, 'VENDOR.json', vendorText(baselineFor({ 'lib/x.ts': 'x' })));
  const args = ['vendor', '--baseline', join(root, 'VENDOR.json'), '--guides', join(root, 'out'), '--out', join(root, 'next.json')];
  result = cli(args);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).guidance.added.join(), 'guidelines/components/list.md');
  result = cli(args);
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stderr).error, /EEXIST/);
  result = cli(['vendor', '--baseline', join(root, 'VENDOR.json'), '--out', join(root, 'other.json')]);
  assert.equal(JSON.parse(result.stderr).code, 'KIT_USAGE');
  assert.equal(JSON.parse(cli(['nope']).stderr).code, 'KIT_USAGE');
  assert.equal(JSON.parse(cli(['check', '--source']).stderr).code, 'KIT_USAGE');
});

test('vendor --candidate-dir writes the new library at full Make paths with the candidate VENDOR.json', t => {
  const root = temp(t);
  const baseFiles = { 'index.ts': 'x', 'lib/a.ts': 'a1' };
  for (const [path, content] of Object.entries(baseFiles)) put(join(root, 'base'), path, content);
  for (const [path, content] of Object.entries({ 'index.ts': 'x', 'lib/a.ts': 'a2', 'lib/a.spec.ts': 'excluded' })) {
    put(join(root, 'next'), path, content);
  }
  put(root, 'VENDOR.json', vendorText(baselineFor(baseFiles)));
  const args = ['vendor', '--baseline', join(root, 'VENDOR.json'), '--base-library', join(root, 'base'),
    '--library', join(root, 'next'), '--commit', '2'.repeat(40), '--commit-date', '2026-02-02T00:00:00Z'];
  let result = cli([...args, '--out', join(root, 'cand.json'), '--candidate-dir', join(root, 'cand')]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.changed, ['lib/a.ts']);
  assert.equal(report.inventory, undefined);
  const vendorDir = join(root, 'cand/src/vendor/atomic-aui');
  assert.deepEqual(readdirSync(vendorDir).sort(), ['VENDOR.json', 'index.ts', 'lib']);
  assert.deepEqual(readdirSync(join(vendorDir, 'lib')), ['a.ts']);
  assert.equal(readFileSync(join(vendorDir, 'lib/a.ts'), 'utf8'), 'a2');
  assert.ok(readFileSync(join(vendorDir, 'VENDOR.json')).equals(readFileSync(join(root, 'cand.json'))));
  result = cli([...args, '--out', join(root, 'again.json'), '--candidate-dir', join(root, 'cand')]);
  assert.equal(JSON.parse(result.stderr).code, 'KIT_OUTPUT_EXISTS');
  put(join(root, 'guides'), 'a.md', 'A');
  result = cli(['vendor', '--baseline', join(root, 'VENDOR.json'), '--guides', join(root, 'guides'),
    '--out', join(root, 'x.json'), '--candidate-dir', join(root, 'c2')]);
  assert.match(JSON.parse(result.stderr).error, /--candidate-dir needs --library/);
});

test('make sync adopts the candidate VENDOR.json for an unbound component-only plan', async t => {
  const { planSync } = await import('../src/make-sync.js');
  const root = temp(t);
  const baseFiles = { 'index.ts': 'x', 'lib/a.ts': 'a1', 'tokens/generated/.generated': 'g' };
  for (const [path, content] of Object.entries(baseFiles)) put(join(root, 'base'), path, content);
  for (const [path, content] of Object.entries({ ...baseFiles, 'lib/a.ts': 'a2', 'lib/b.ts': 'b' })) put(join(root, 'next'), path, content);
  const baselineBytes = Buffer.from(vendorText(baselineFor(baseFiles)));
  put(root, 'VENDOR.json', baselineBytes);
  const commit = '2'.repeat(40);
  const result = cli(['vendor', '--baseline', join(root, 'VENDOR.json'), '--base-library', join(root, 'base'),
    '--library', join(root, 'next'), '--commit', commit, '--commit-date', '2026-02-02T00:00:00Z',
    '--out', join(root, 'cand.json'), '--candidate-dir', join(root, 'cand')]);
  assert.equal(result.status, 0, result.stderr);
  const candidate = readFileSync(join(root, 'cand.json'));
  const baseline = new Map(baselineFor(baseFiles).files.map(file => [file.path, file]));
  const inventory = new Map([...baseline, ['VENDOR.json', { path: 'VENDOR.json', sha256: digest(baselineBytes), bytes: baselineBytes.length }]]);
  const contents = new Map([...Object.entries(baseFiles).map(([path, content]) => [path, Buffer.from(content)]), ['VENDOR.json', baselineBytes]]);
  const files = ['lib/a.ts', 'lib/b.ts'].map(path => ({ path: `src/vendor/atomic-aui/${path}`,
    baselineSha256: baseline.get(path)?.sha256 ?? null,
    workspaceSha256: digest(readFileSync(join(root, 'cand/src/vendor/atomic-aui', path))), dependencies: [] }));
  const request = { schema: 'figma-cli/make-sync-request@1', fileKey: 'Kit', who: 'Releaser', requestId: 'r1',
    requestedAt: '2026-02-02T00:00:00.000Z', direction: 'workspace-to-make', workspaceCommit: commit, files, choices: {} };
  const { plan, vendorBytes } = planSync({ request, requestSha256: digest(JSON.stringify(request)),
    packageData: { manifest: { source: { commit }, generationManifest: null, tree: { digest: 'c'.repeat(64) } },
      files: new Map([['.generated', Buffer.from('g')]]), sha256: 'd'.repeat(64) },
    baselineBytes, candidateDir: join(root, 'cand'), generationManifestBytes: null, inventory, contents,
    state: { mode: 'git', hasBaseline: true, savedVersion: 'b'.repeat(40), pendingCount: 0, pendingPaths: [], isLoading: false, error: false },
    fileKey: 'Kit' });
  assert.ok(vendorBytes.equals(candidate));
  assert.equal(plan.vendorAfter.sha256, digest(candidate));
  assert.equal(plan.generationManifest, null);
  assert.deepEqual(plan.actions.map(action => action.operation), ['write', 'write']);
});
