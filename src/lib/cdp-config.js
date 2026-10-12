import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function parseCdpPort(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('CDP port must be an integer from 1 to 65535');
  }
  return Number(value);
}

export const connectionConfigPath = (home = homedir()) => join(home, '.figma-cli/connection.json');

function readConfig(home) {
  const path = connectionConfigPath(home);
  try {
    if (!lstatSync(path).isFile()) throw new Error('expected a regular file');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    if (config.owner !== 'amelie-pierce/figma-cli' || config.schemaVersion !== 1) throw new Error('unrecognized owner or schema');
    config.port = parseCdpPort(config.port);
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read connection settings at ${path}: ${error.message}. Preserve this file and repair its settings.`);
  }
}

export function getCdpSettings({ port, env = process.env, home = homedir() } = {}) {
  const configFile = connectionConfigPath(home);
  if (port !== undefined) return { port: parseCdpPort(port), source: '--port', configFile };
  if (env.FIGMA_PORT !== undefined) return { port: parseCdpPort(env.FIGMA_PORT), source: 'FIGMA_PORT', configFile };
  const config = readConfig(home);
  return { port: config?.port ?? 9222, source: config ? 'saved' : 'default', configFile };
}

export function saveCdpPort(port, { home = homedir() } = {}) {
  port = parseCdpPort(port);
  const config = readConfig(home);
  const path = connectionConfigPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ ...config, owner: 'amelie-pierce/figma-cli', schemaVersion: 1, port }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  return { port, configFile: path };
}
