// Networked package-install rehearsal, separate from the offline unit suite.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNpmCli } from '../src/lib/node-install.js';
import { copyTree } from '../src/lib/copy-tree.js';

const source = fileURLToPath(new URL('../', import.meta.url));
// Expand Windows 8.3 temp aliases before constructing ESM module paths.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'figma-node-rehearsal-')));
const root = join(sandbox, 'CLI package with spaces Ω');
const home = join(sandbox, 'profile');
mkdirSync(root); mkdirSync(home);
try {
  for (const item of ['install.mjs', 'package.json', 'package-lock.json', 'src', 'skills']) {
    copyTree(join(source, item), join(root, item));
  }
  assert.ok(existsSync(join(root, 'src/lib/node-install.js')), 'Installer implementation must be present in the copied package');
  const npmCli = findNpmCli();
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
    PATH: '', npm_config_script_shell: join(sandbox, 'shell-does-not-exist'),
    FIGMA_CLI_NO_UPDATE_CHECK: '1', FIGMA_CLI_SKIP_SKILLS: '1' };
  const run = args => {
    const result = spawnSync(process.execPath, args, { cwd: root, env, shell: false,
      encoding: 'utf8', timeout: 330000, maxBuffer: 8 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  delete env.FIGMA_PORT;
  run([join(root, 'install.mjs'), '--agent', 'copilot', '--npm-cli', npmCli, '--port', '9333']);
  assert.equal(JSON.parse(readFileSync(join(home, '.figma-cli/connection.json'))).port, 9333);
  const runtime = JSON.parse(readFileSync(join(home, '.figma-cli/node-runtime.json'), 'utf8'));
  assert.equal(runtime.nodeExecutable, process.execPath);
  const cli = runtime.cliEntry;
  assert.equal(realpathSync(cli), realpathSync(join(root, 'src/index.js')));
  const status = JSON.parse(run([cli, 'skills', 'status', '--agent', 'copilot']));
  assert.equal(status.ready, true);
  assert.deepEqual(status.results.map(x => x.name).sort(), ['figma-cli', 'figma-make', 'figma-make-team']);
  assert.ok(status.results.every(x => x.agent === 'copilot' && x.status === 'up-to-date'));
  assert.match(run([cli, 'make', '--help']), /replace/);
  assert.match(run([cli, 'connect', '--help']), /--make/);
  assert.match(run([cli, 'render', '--help']), /Render JSX/);
  const configured = JSON.parse(run([cli, 'connection', '--save-port', '9444']));
  assert.equal(configured.effective.port, 9444);
  assert.equal(configured.effective.source, 'saved');
  console.log('PASS: fresh Node installation, empty PATH, unavailable shell, Copilot skill registration, Design and Make entry points.');
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
