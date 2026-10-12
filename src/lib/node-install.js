import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { manageSkills, skillTargets, skillsReady } from './agent-skills.js';
import { getCdpSettings, parseCdpPort, saveCdpPort } from './cdp-config.js';

const require = createRequire(import.meta.url);
const isFile = path => { try { return statSync(path).isFile(); } catch { return false; } };

export function findNpmCli({ npmCli, execPath = process.execPath, env = process.env } = {}) {
  if (npmCli) {
    const path = resolve(npmCli);
    if (!isFile(path) || !path.endsWith('.js')) throw new Error('--npm-cli must identify an existing npm JavaScript entry point, not a shell launcher.');
    return path;
  }
  const bin = dirname(realpathSync(execPath));
  const candidates = [
    env.npm_execpath?.endsWith('npm-cli.js') ? env.npm_execpath : null,
    join(bin, 'node_modules/npm/bin/npm-cli.js'), // Standard Windows Node install.
    join(bin, '../lib/node_modules/npm/bin/npm-cli.js'), // Node distributions, nvm.
    join(bin, '../share/nodejs/npm/bin/npm-cli.js'), // Linux system packages.
  ];
  try { candidates.push(join(dirname(require.resolve('npm/package.json')), 'bin/npm-cli.js')); } catch {}
  const found = candidates.find(path => path && isFile(path));
  if (!found) throw new Error('Cannot locate npm-cli.js. Install Node with npm, or pass --npm-cli with the npm JavaScript entry point supplied by your Node installation.');
  return resolve(found);
}

export function installFromNode({ root, agent = 'all', npmCli, port, home = homedir(), env = process.env } = {}) {
  root = resolve(root);
  skillTargets({ agent, home, env }); // Reject invalid agents before installing anything.
  if (port !== undefined) parseCdpPort(port);
  getCdpSettings({ home, env: {} }); // Validate existing settings before installing.
  getCdpSettings({ home, env }); // Reject malformed environment overrides before writes.
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (metadata.name !== '@amelie-pierce/figma-cli') throw new Error('Run the installer from an extracted amelie-pierce/figma-cli package.');
  const runtimeFile = join(home, '.figma-cli/node-runtime.json');
  try {
    const stat = lstatSync(runtimeFile);
    if (!stat.isFile() || JSON.parse(readFileSync(runtimeFile, 'utf8')).owner !== 'amelie-pierce/figma-cli') {
      throw new Error('Existing Node runtime record is not managed by this fork; preserve it and choose an installation profile without this conflict.');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const npm = findNpmCli({ npmCli, env });
  const command = existsSync(join(root, 'package-lock.json')) ? 'ci' : 'install';
  // Never execute npm.cmd/npm shell shims or package lifecycle scripts.
  // Respect the caller's registry, proxy and TLS settings.
  const result = spawnSync(process.execPath, [npm, command,
    '--ignore-scripts', '--no-audit', '--no-fund', '--no-bin-links',
  ], { cwd: root, env, shell: false, stdio: 'inherit', timeout: 300000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Dependency installation failed (${result.signal || result.status}); skills were not changed.`);
  if (port !== undefined) saveCdpPort(port, { home });
  mkdirSync(dirname(runtimeFile), { recursive: true, mode: 0o700 });
  writeFileSync(runtimeFile, JSON.stringify({ owner: 'amelie-pierce/figma-cli', schemaVersion: 1,
    nodeExecutable: process.execPath, cliEntry: join(root, 'src/index.js') }, null, 2) + '\n', { mode: 0o600 });
  const options = { agent, home, env, sourceRoot: join(root, 'skills') };
  const results = manageSkills({ ...options, install: true });
  const verified = manageSkills(options);
  return { ready: skillsReady(results) && skillsReady(verified), agent,
    cliEntry: join(root, 'src/index.js'), runtimeFile, results, verified,
    connection: { ...getCdpSettings({ home, env }), verified: false,
      ...(port !== undefined ? { savedPort: parseCdpPort(port) } : {}),
      note: 'Installation does not enable Desktop debugging. Run connection to test the endpoint. A running Figma window alone is not a CDP connection.' } };
}
