import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A bare `figma-cli` only reports; it never patches, quits or starts Figma
// Desktop. The source check runs first: running the CLI is only safe when the
// default action cannot reach the stop/start helpers, which use absolute
// paths (/usr/bin/pkill) a test cannot intercept.
const SETUP = fileURLToPath(new URL('../src/commands/setup.js', import.meta.url));

function defaultAction() {
  const source = readFileSync(SETUP, 'utf8');
  const start = source.indexOf('program.action(');
  assert.ok(start > 0, 'setup.js registers the default action');
  const end = source.indexOf('\n});\n', start);
  return source.slice(start, end);
}

test('the default action never stops, starts or patches Figma Desktop', () => {
  const action = defaultAction();
  for (const name of ['killFigma', 'startFigma', 'patchFigma', 'stopDesktop', 'launch']) assert.ok(!action.includes(name), `${name} in the bare action`);
});

async function bare(t, { patched }) {
  const home = mkdtempSync(join(tmpdir(), 'figma-cli-bare-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (patched != null) {
    mkdirSync(join(home, '.figma-ds-cli'), { recursive: true });
    writeFileSync(join(home, '.figma-ds-cli', 'config.json'), JSON.stringify({ patched }));
  }
  // Port 1 never answers, so this never reads a running Figma.
  const env = { ...process.env, HOME: home, USERPROFILE: home, FIGMA_PORT: '1', FIGMA_CLI_NO_UPDATE_CHECK: '1', FIGMA_CLI_SKIP_SKILLS: '1' };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url))], { env, shell: false });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill(), 15000);
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  return { code, stdout, stderr };
}

test('a bare figma-cli prints the status and how to connect, first time or not', async t => {
  assert.ok(!defaultAction().includes('killFigma'), 'refusing to run a bare CLI that could stop Figma');
  for (const patched of [undefined, false, true]) {
    const result = await bare(t, { patched });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Figma is not connected\. Nothing was started or restarted\./);
    assert.match(result.stdout, patched ? /run: figma-cli connect/ : /run: figma-cli init/);
    assert.match(result.stdout, /figma-cli --help/);
    assert.doesNotMatch(result.stdout, /Patching|Starting Figma|Step 1\/3/);
  }
});
