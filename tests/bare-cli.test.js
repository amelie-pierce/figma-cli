import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A bare `figma-cli` only reports; it never patches, quits or starts Figma
// Desktop. The stop/start helpers call absolute paths (/usr/bin/pkill,
// /usr/bin/open, taskkill.exe), so PATH stubs cannot catch them: a preload
// replaces child_process instead, refuses those launches and records them.
const GUARD = `
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const cp = createRequire(import.meta.url)('node:child_process');
const desktop = /(^|[\\\\/])(pkill|taskkill(\\.exe)?|open|codesign)$|figma/i;
for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
  const real = cp[name];
  cp[name] = function (command, ...rest) {
    const line = [command, ...(Array.isArray(rest[0]) ? rest[0] : [])].join(' ');
    if (desktop.test(String(command)) || /figma/i.test(line)) {
      appendFileSync(process.env.FIGMA_CLI_TEST_LAUNCHES, line + '\\n');
      throw new Error('blocked desktop launch: ' + line);
    }
    return real.call(this, command, ...rest);
  };
}
syncBuiltinESMExports();
`;

async function bare(t, { patched }) {
  const home = mkdtempSync(join(tmpdir(), 'figma-cli-bare-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (patched != null) {
    mkdirSync(join(home, '.figma-ds-cli'), { recursive: true });
    writeFileSync(join(home, '.figma-ds-cli', 'config.json'), JSON.stringify({ patched }));
  }
  const guard = join(home, 'guard.mjs');
  writeFileSync(guard, GUARD);
  const launches = join(home, 'launches.log');
  // Port 1 never answers, so this never reads a running Figma.
  const env = { ...process.env, HOME: home, USERPROFILE: home, FIGMA_PORT: '1', FIGMA_CLI_NO_UPDATE_CHECK: '1', FIGMA_CLI_SKIP_SKILLS: '1',
    FIGMA_CLI_TEST_LAUNCHES: launches };
  const child = spawn(process.execPath, ['--import', pathToFileURL(guard).href, fileURLToPath(new URL('../src/index.js', import.meta.url))], { env, shell: false });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill(), 15000);
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  return { code, stdout, stderr, launches: existsSync(launches) ? readFileSync(launches, 'utf8') : '' };
}

test('a bare figma-cli prints the status and how to connect, and never stops, starts or patches Figma', async t => {
  for (const patched of [undefined, false, true]) {
    const result = await bare(t, { patched });
    assert.equal(result.launches, '', `bare figma-cli tried to control Figma Desktop:\n${result.launches}`);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Figma is not connected\. Nothing was started or restarted\./);
    assert.match(result.stdout, patched ? /run: figma-cli connect/ : /run: figma-cli init/);
    assert.match(result.stdout, /figma-cli --help/);
    assert.doesNotMatch(result.stdout, /Patching|Starting Figma|Step 1\/3/);
  }
});
