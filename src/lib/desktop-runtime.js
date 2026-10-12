// Desktop discovery and process control shared by macOS and Windows.
// OS utilities are invoked directly, never through a command shell.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseCdpPort } from './cdp-config.js';

export function locateDesktop({ platform = process.platform, env = process.env, home = homedir(),
  exists = existsSync, readdir = readdirSync } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const override = env.FIGMA_APP_PATH;
  if (platform === 'darwin') {
    const bundles = override ? [override] : ['/Applications/Figma.app', p.join(home, 'Applications/Figma.app')];
    for (const app of bundles) {
      const binary = p.join(app, 'Contents/MacOS/Figma');
      const asar = p.join(app, 'Contents/Resources/app.asar');
      if (exists(binary) && exists(asar)) return { app, binary, asar };
    }
  } else if (platform === 'win32') {
    const root = override || (env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Figma'));
    if (!root) return null;
    let versions = [];
    try {
      versions = readdir(root).filter(name => /^app-\d+(?:\.\d+)*$/.test(name))
        .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    } catch {}
    for (const folder of [...versions.map(name => p.join(root, name)), root]) {
      const binary = p.join(folder, 'Figma.exe');
      const asar = p.join(folder, 'resources/app.asar');
      // Patch and launch the same version, rather than mixing an old asar with
      // a different root executable. Incomplete update folders are skipped.
      if (exists(binary) && exists(asar)) return { app: folder, binary, asar };
    }
  } else if (platform === 'linux') {
    const app = override || '/opt/figma';
    const binary = override ? p.join(app, 'figma') : '/usr/bin/figma';
    const asar = p.join(app, 'resources/app.asar');
    if (exists(binary) && exists(asar)) return { app, binary, asar };
  }
  return null;
}

export async function launchDesktop(binary, port, { platform = process.platform,
  exec = execFileSync, spawnProcess = spawn } = {}) {
  port = parseCdpPort(port);
  if (!binary) throw new Error('Figma installation not found. Install Desktop or set FIGMA_APP_PATH to its installation folder (.app on macOS).');
  if (platform === 'darwin') {
    const app = path.posix.resolve(binary, '../../..');
    exec('/usr/bin/open', ['-a', app, '--args', `--remote-debugging-port=${port}`],
      { shell: false, stdio: 'pipe', timeout: 10000 });
    return;
  }
  await new Promise((resolve, reject) => {
    const child = spawnProcess(binary, [`--remote-debugging-port=${port}`],
      { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export function stopDesktop({ platform = process.platform, env = process.env, exec = execFileSync } = {}) {
  const command = platform === 'win32'
    ? path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32/taskkill.exe')
    : '/usr/bin/pkill';
  const args = platform === 'win32' ? ['/IM', 'Figma.exe', '/F'] : ['-x', platform === 'darwin' ? 'Figma' : 'figma'];
  try {
    exec(command, args, { shell: false, stdio: 'pipe', timeout: 10000 });
  } catch (error) {
    // These exit codes mean no matching process. Permission/launch errors
    // must propagate rather than pretending the old app was stopped.
    if (error.status === (platform === 'win32' ? 128 : 1)) return;
    throw error;
  }
}

export function signDesktop(app, { exec = execFileSync } = {}) {
  exec('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app],
    { shell: false, stdio: 'pipe', timeout: 60000 });
}

export function writeDesktopArchive(installation, previous, content,
  { platform = process.platform, write = writeFileSync, sign = signDesktop } = {}) {
  write(installation.asar, content);
  if (platform !== 'darwin') return;
  try {
    sign(installation.app);
  } catch (error) {
    // A failed signing attempt must not leave the patched marker behind and
    // cause the next connect to skip the setup that failed.
    try { write(installation.asar, previous); } catch (rollbackError) {
      throw new Error(`Figma signing failed: ${error.message}. Restoring the archive also failed: ${rollbackError.message}. Repair the Figma installation before retrying.`, { cause: error });
    }
    throw new Error(`Figma signing failed: ${error.message}. The previous archive bytes were restored; app signature health is unverified.`, { cause: error });
  }
}
