import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deployDir } from './make-deploy.js';

const keyHash = key => createHash('sha256').update(key).digest('hex');
const paths = (key, home) => {
  const dir = deployDir(home);
  const hash = keyHash(key);
  return { dir, lock: join(dir, 'locks', hash), record: join(dir, 'runners', `${hash}.json`) };
};
const atomicJson = (path, value) => {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
};
const json = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
export const pidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
};
const locked = (message, code = 'DEPLOY_WRITER_LOCKED') => Object.assign(new Error(message), { code });
const GRACE_MS = 2000;
const processStart = pid => {
  if (!pidAlive(pid)) return null;
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
  const ms = Date.parse(result.stdout?.trim() || '');
  return result.status === 0 && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const ownerAlive = owner => {
  if (!pidAlive(owner?.pid)) return false;
  const startedAt = processStart(owner.pid);
  return !owner.processStartedAt || !startedAt || owner.processStartedAt === startedAt;
};
const oldEnough = path => Date.now() - statSync(path).mtimeMs >= GRACE_MS;

function removeOwnedLock(lock, token) {
  const ownerPath = join(lock, 'owner.json');
  const claim = join(lock, `.reclaim-${randomUUID()}`);
  try { renameSync(ownerPath, claim); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const current = json(claim);
  if (current?.token !== token) {
    renameSync(claim, ownerPath);
    return false;
  }
  unlinkSync(claim);
  try { rmdirSync(lock); }
  catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error; }
  return true;
}

export function acquireDeployLock(key, { home, clearStale = false, token = randomUUID() } = {}) {
  const { lock } = paths(key, home);
  mkdirSync(join(lock, '..'), { recursive: true, mode: 0o700 });
  const staged = `${lock}.prepare-${randomUUID()}`;
  mkdirSync(staged, { mode: 0o700 });
  atomicJson(join(staged, 'owner.json'), { fileKey: key, pid: process.pid, token, startedAt: new Date().toISOString(), processStartedAt: processStart(process.pid) });
  try {
    if (statSync(lock, { throwIfNoEntry: false })) {
      const error = new Error('Deploy lock exists.');
      error.code = 'EEXIST';
      throw error;
    }
    renameSync(staged, lock);
  }
  catch (error) {
    rmSync(staged, { recursive: true, force: true });
    if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
    const ownerPath = join(lock, 'owner.json');
    const ownerFileExists = existsSync(ownerPath);
    const owner = json(ownerPath);
    if (owner?.fileKey && owner.fileKey !== key) throw locked(`Deploy lock ${lock} is invalid; inspect it before removing it.`);
    if (ownerAlive(owner)) throw locked(`A deploy writer for ${key} is running (PID ${owner.pid}). Check make deploy status --file ${key}.`);
    if (!owner && (!oldEnough(lock) || (ownerFileExists && !oldEnough(ownerPath)))) throw locked(`Deploy lock for ${key} is being acquired.`);
    if (!clearStale) throw locked(`Stale deploy lock for ${key} (PID ${owner?.pid ?? 'unknown'}). Inspect make deploy status --file ${key}, then retry with --clear-stale-lock.`, 'DEPLOY_STALE_LOCK');
    if (ownerFileExists) {
      const claim = join(lock, `.reclaim-${randomUUID()}`);
      try { renameSync(ownerPath, claim); }
      catch (claimError) { if (claimError.code === 'ENOENT') return acquireDeployLock(key, { home, clearStale, token }); throw claimError; }
      const claimed = json(claim);
      if ((owner && claimed?.token !== owner.token) || ownerAlive(claimed)) {
        renameSync(claim, ownerPath);
        return acquireDeployLock(key, { home, clearStale, token });
      }
      unlinkSync(claim);
    }
    if (!ownerFileExists) {
      for (const name of readdirSync(lock).filter(name => name.startsWith('.reclaim-'))) {
        const claimed = join(lock, name);
        if (oldEnough(claimed)) unlinkSync(claimed);
      }
    }
    try { rmdirSync(lock); }
    catch (removeError) { if (removeError.code !== 'ENOENT' && removeError.code !== 'ENOTEMPTY') throw removeError; }
    return acquireDeployLock(key, { home, clearStale, token });
  }
  return { key, token, home };
}

export function updateDeployLock(owner, pid) {
  const { lock } = paths(owner.key, owner.home);
  const current = json(join(lock, 'owner.json'));
  if (current?.token !== owner.token) throw locked('Deploy lock ownership changed.');
  atomicJson(join(lock, 'owner.json'), { ...current, pid, processStartedAt: processStart(pid) });
}

export function requireDetachedOwner(key, token, { home } = {}) {
  const { lock, record } = paths(key, home);
  const owner = json(join(lock, 'owner.json'));
  const runner = json(record);
  if (!token || owner?.token !== token || runner?.token !== token || owner.pid !== process.pid || runner.pid !== process.pid) {
    throw locked(`Detached deploy for ${key} does not own its writer lock.`);
  }
}

export function releaseDeployLock(owner) {
  const { lock } = paths(owner.key, owner.home);
  if (json(join(lock, 'owner.json'))?.token === owner.token) removeOwnedLock(lock, owner.token);
}

export function readDeployRunner(key, { home } = {}) {
  if (!key) return null;
  const { record, lock } = paths(key, home);
  const value = json(record);
  if (!value || value.fileKey !== key) return null;
  const owner = json(join(lock, 'owner.json'));
  const alive = owner?.token === value.token && ownerAlive(owner);
  const { token, ...publicValue } = value;
  return { ...publicValue, state: value.finishedAt ? value.state : alive ? 'running' : 'died', alive: !!alive };
}

export function finishDeployRunner(key, token, exitCode, { home } = {}) {
  const { record } = paths(key, home);
  const value = json(record);
  if (value?.token !== token) return;
  atomicJson(record, { ...value, state: exitCode === 0 ? 'finished' : 'failed', exitCode,
    finishedAt: new Date().toISOString() });
}

export async function startDetachedDeploy(key, argv, { home, clearStale = false, cliEntry = resolve('src/index.js'), node = process.execPath } = {}) {
  const owner = acquireDeployLock(key, { home, clearStale });
  const { dir, record } = paths(key, home);
  const logPath = join(dir, 'runners', `${keyHash(key)}-${Date.now()}.log`);
  const id = randomUUID();
  let log;
  try {
    mkdirSync(join(record, '..'), { recursive: true, mode: 0o700 });
    log = openSync(logPath, 'a', 0o600);
    const child = spawn(node, [cliEntry, ...argv], { detached: true, stdio: ['ignore', log, log, 'ipc'],
      env: { ...process.env, FIGMA_CLI_DEPLOY_RUNNER_TOKEN: owner.token, FIGMA_CLI_DEPLOY_RUNNER_ID: id } });
    await new Promise((resolveReady, reject) => {
      child.once('spawn', resolveReady);
      child.once('error', reject);
    });
    updateDeployLock(owner, child.pid);
    atomicJson(record, { fileKey: key, id, token: owner.token, pid: child.pid, logPath,
      startedAt: new Date().toISOString(), state: 'running', exitCode: null, finishedAt: null });
    await new Promise((resolveSent, reject) => child.send('start', error => error ? reject(error) : resolveSent()));
    child.unref();
    return { fileKey: key, pid: child.pid, logPath, status: `figma-cli make deploy status --file ${key}` };
  } catch (error) { releaseDeployLock(owner); throw error; }
  finally { if (log !== undefined) closeSync(log); }
}

export async function awaitDetachedStart() {
  await new Promise((resolveReady, reject) => {
    process.once('message', resolveReady);
    process.once('disconnect', () => reject(new Error('Deploy launcher disconnected before startup.')));
  });
  process.disconnect();
}
