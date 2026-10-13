import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'src', 'index.js');

// Every call is bounded. Without a timeout this test HUNG for 15 minutes when
// the connected file was large (Primer Web: 67 pages), taking the whole suite
// with it — and its cleanup never ran, so a Button fixture was left behind in
// someone else's file. A bounded call fails loudly instead.
const TIMEOUT = 90_000;
function run(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8', timeout: TIMEOUT, ...opts });
}

// This test WRITES to whatever Figma file is live (adds and removes a page), so
// it is opt-in: it runs only when FIGMA_CLI_LIVE_TESTS=1. Without the opt-in the
// default `npm test` never probes Figma, connects to it, or starts a daemon.
const LIVE = process.env.FIGMA_CLI_LIVE_TESTS === '1';
const SKIP_REASON = 'writes to the live Figma file; set FIGMA_CLI_LIVE_TESTS=1 to run';

// With the opt-in, also gate on a LIVE Figma connection, not just a running
// daemon: probe with a trivial eval. When Figma is not connected the CLI exits
// 1 → execFileSync throws → we skip. Only a real round-trip (exit 0, 'ok') unlocks the test.
function figmaReady() {
  try { return /ok/.test(run(['eval', `(async () => 'ok')()`], { timeout: 20_000 })); } catch { return false; }
}

// The fixture gets its OWN page. Two reasons: extract can then be scoped to it
// (walking 67 pages of a real design system is what made this test hang), and
// cleanup is a single page.remove() that cannot leave stragglers behind.
const PAGE = 'figma-cli test fixture';
const BUILD = `(async () => {
  const page = figma.createPage();
  page.name = ${JSON.stringify(PAGE)};
  await figma.setCurrentPageAsync(page);
  const mk = (name) => { const c = figma.createComponent(); c.name = name; c.resize(80, 40); return c; };
  const a = mk('Size=Small'); const b = mk('Size=Large');
  const set = figma.combineAsVariants([a, b], page);
  set.name = 'Button';
  return JSON.stringify({ pageId: page.id, setId: set.id });
})()`;

const teardown = (pageId) => `(async () => {
  await figma.loadAllPagesAsync();
  const p = await figma.getNodeByIdAsync(${JSON.stringify(pageId)});
  if (!p) return 'gone';
  // Figma refuses to remove the page it is currently showing.
  if (figma.currentPage === p) {
    const other = figma.root.children.find(x => x !== p);
    if (other) await figma.setCurrentPageAsync(other);
  }
  p.remove();
  return 'ok';
})()`;

test('extract → instantiate roundtrip (opt-in, gated on a connected Figma)', { skip: !LIVE ? SKIP_REASON : !figmaReady() }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'inst-'));
  const md = join(dir, 'DESIGN.md');
  let pageId;
  try {
    const built = JSON.parse(run(['eval', BUILD]).trim().split('\n').pop());
    pageId = built.pageId;

    run(['extract', md, '--pages', PAGE]);
    const text = readFileSync(md, 'utf8');
    assert.match(text, /### Button/);
    assert.match(text, /Reuse: import existing/);

    const out = run(['instantiate', 'Button', '--file', md]);
    assert.match(out, /Instanced "Button" via (key|id)/);
  } finally {
    // Removing the fixture page takes the component set AND the instance
    // `instantiate` dropped on it — nothing survives this test.
    if (pageId) { try { run(['eval', teardown(pageId)]); } catch {} }
  }
});
