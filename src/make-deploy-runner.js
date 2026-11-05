import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deployDir } from './make-deploy.js';

const LEASE_MS = 120000;
const keyHash = key => createHash('sha256').update(key).digest('hex');
const paths = (key, home) => {
  const dir = deployDir(home);
  const hash = keyHash(key);
  return { lock: join(dir, 'locks', hash), runners: join(dir, 'runners', hash), sequence: join(dir, 'runners', hash, 'sequence.json') };
};
const json = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const atomicJson = (path, value) => {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
};
const locked = (message, code = 'DEPLOY_WRITER_LOCKED') => Object.assign(new Error(message), { code });
const expired = record => !record || !Number.isFinite(record.leaseUntil) || record.leaseUntil <= Date.now();
const oldEnough = path => Date.now() - statSync(path).mtimeMs >= LEASE_MS;
const runnerPath = (key, runId, home) => join(paths(key, home).runners, `${runId}.json`);

export function nextDeploySequence(key, { home } = {}) {
  const { sequence } = paths(key, home);
  const next = (json(sequence)?.value || 0) + 1;
  atomicJson(sequence, { value: next });
  return next;
}

function claimOwner(lock, observed) {
  const ownerPath = join(lock, 'owner.json');
  const claimedPath = join(lock, `.claim-${randomUUID()}`);
  try { renameSync(ownerPath, claimedPath); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const claimed = json(claimedPath);
  if ((observed?.token && claimed?.token !== observed.token) || !expired(claimed)) {
    if (existsSync(ownerPath)) unlinkSync(claimedPath);
    else renameSync(claimedPath, ownerPath);
    return false;
  }
  unlinkSync(claimedPath);
  return true;
}

function removeEmptyLock(lock) {
  try { rmdirSync(lock); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
}

export function acquireDeployLock(key, { home, clearStale = false, token = randomUUID(), runId = randomUUID() } = {}) {
  const { lock } = paths(key, home);
  mkdirSync(join(lock, '..'), { recursive: true, mode: 0o700 });
  const staged = `${lock}.prepare-${randomUUID()}`;
  mkdirSync(staged, { mode: 0o700 });
  atomicJson(join(staged, 'owner.json'), { fileKey: key, token, runId, leaseUntil: Date.now() + LEASE_MS });
  try {
    if (existsSync(lock)) {
      const error = new Error('Deploy lock exists.');
      error.code = 'EEXIST';
      throw error;
    }
    renameSync(staged, lock);
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
    const ownerPath = join(lock, 'owner.json');
    const ownerExists = existsSync(ownerPath);
    const owner = json(ownerPath);
    if (owner?.fileKey && owner.fileKey !== key) throw locked(`Deploy lock ${lock} is invalid; inspect it before removing it.`);
    const complete = owner?.token && owner?.runId && Number.isFinite(owner.leaseUntil);
    if (complete && !expired(owner)) throw locked(`A deploy writer for ${key} holds a live lease. Check make deploy status --file ${key}.`);
    if (!complete) {
      let recent;
      try { recent = !oldEnough(lock) || (ownerExists && !oldEnough(ownerPath)); }
      catch (race) { if (race.code === 'ENOENT') return acquireDeployLock(key, { home, clearStale, token, runId }); throw race; }
      if (recent) throw locked(`Deploy lock for ${key} is being acquired.`);
    }
    if (!clearStale) throw locked(`Stale deploy lock for ${key}. Inspect make deploy status --file ${key}, then retry with --clear-stale-lock.`, 'DEPLOY_STALE_LOCK');
    if (ownerExists && !claimOwner(lock, owner)) return acquireDeployLock(key, { home, clearStale, token, runId });
    if (!ownerExists) {
      let names;
      try { names = readdirSync(lock); }
      catch (race) { if (race.code === 'ENOENT') return acquireDeployLock(key, { home, clearStale, token, runId }); throw race; }
      for (const name of names.filter(name => name.startsWith('.claim-') || name.endsWith('.tmp'))) {
        const claimed = join(lock, name);
        try { if (oldEnough(claimed)) unlinkSync(claimed); }
        catch (race) { if (race.code !== 'ENOENT') throw race; }
      }
    }
    removeEmptyLock(lock);
    return acquireDeployLock(key, { home, clearStale, token, runId });
  }
  return { key, token, runId, home };
}

export function renewDeployLock(owner) {
  const { lock } = paths(owner.key, owner.home);
  const ownerPath = join(lock, 'owner.json');
  const current = json(ownerPath);
  if (current?.token !== owner.token || current.runId !== owner.runId || expired(current)) throw locked('Deploy lock lease expired or ownership changed.');
  const temp = join(lock, `.lease-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify({ ...current, leaseUntil: Date.now() + LEASE_MS })}\n`, { mode: 0o600, flag: 'wx' });
    const latest = json(ownerPath);
    if (latest?.token !== owner.token || latest.runId !== owner.runId || expired(latest)) throw locked('Deploy lock lease expired or ownership changed.');
    renameSync(temp, ownerPath);
  } finally { rmSync(temp, { force: true }); }
}

export function startDeployHeartbeat(owner) {
  const timer = setInterval(() => renewDeployLock(owner), LEASE_MS / 4);
  timer.unref();
  return () => clearInterval(timer);
}

export function requireDetachedOwner(key, token, { home } = {}) {
  const runId = process.env.FIGMA_CLI_DEPLOY_RUNNER_ID;
  const owner = json(join(paths(key, home).lock, 'owner.json'));
  const runner = runId && json(runnerPath(key, runId, home));
  if (!token || !runId || owner?.token !== token || owner.runId !== runId || expired(owner) || runner?.token !== token || runner.id !== runId) {
    throw locked(`Detached deploy for ${key} does not own its writer lock.`);
  }
  return { key, token, runId, home };
}

export function releaseDeployLock(owner) {
  const { lock } = paths(owner.key, owner.home);
  const current = json(join(lock, 'owner.json'));
  if (current?.token !== owner.token || current.runId !== owner.runId) return;
  const ownerPath = join(lock, 'owner.json');
  const claimed = join(lock, `.claim-${randomUUID()}`);
  try { renameSync(ownerPath, claimed); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const moved = json(claimed);
  if (moved?.token !== owner.token || moved.runId !== owner.runId) {
    if (existsSync(ownerPath)) unlinkSync(claimed);
    else renameSync(claimed, ownerPath);
    return;
  }
  unlinkSync(claimed);
  removeEmptyLock(lock);
}

export function readDeployRunner(key, { home, runId } = {}) {
  if (!key) return null;
  const { runners, lock } = paths(key, home);
  const records = runId ? [runnerPath(key, runId, home)] : existsSync(runners)
    ? readdirSync(runners).filter(name => name.endsWith('.json') && name !== 'sequence.json').map(name => join(runners, name)) : [];
  const value = records.map(json).filter(item => item?.fileKey === key && item.id && (!runId || item.id === runId))
    .sort((a, b) => b.sequence - a.sequence)[0];
  if (!value) return null;
  const owner = json(join(lock, 'owner.json'));
  const alive = owner?.token === value.token && owner.runId === value.id && !expired(owner);
  const { token, ...publicValue } = value;
  return { ...publicValue, state: value.finishedAt ? value.state : alive ? 'running' : 'died', alive: !!alive };
}

export function finishDeployRunner(key, token, exitCode, { home, runId = process.env.FIGMA_CLI_DEPLOY_RUNNER_ID } = {}) {
  if (!runId) return;
  const record = runnerPath(key, runId, home);
  const value = json(record);
  if (value?.token !== token) return;
  atomicJson(record, { ...value, state: exitCode === 0 ? 'finished' : 'failed', exitCode,
    finishedAt: new Date().toISOString() });
}

export async function startDetachedDeploy(key, argv, { home, clearStale = false, cliEntry = resolve('src/index.js'), node = process.execPath } = {}) {
  const runId = randomUUID();
  const owner = acquireDeployLock(key, { home, clearStale, runId });
  const stopHeartbeat = startDeployHeartbeat(owner);
  const { runners } = paths(key, home);
  const record = runnerPath(key, runId, home);
  const logPath = join(runners, `${runId}.log`);
  let log;
  try {
    mkdirSync(runners, { recursive: true, mode: 0o700 });
    const sequence = nextDeploySequence(key, { home });
    log = openSync(logPath, 'a', 0o600);
    const child = spawn(node, [cliEntry, ...argv], { detached: true, stdio: ['ignore', log, log, 'ipc'],
      env: { ...process.env, FIGMA_CLI_DEPLOY_RUNNER_TOKEN: owner.token, FIGMA_CLI_DEPLOY_RUNNER_ID: runId, FIGMA_CLI_DEPLOY_SEQUENCE: String(sequence) } });
    await new Promise((resolveReady, reject) => {
      child.once('spawn', resolveReady);
      child.once('error', reject);
    });
    atomicJson(record, { fileKey: key, id: runId, sequence, token: owner.token, pid: child.pid, logPath,
      startedAt: new Date().toISOString(), state: 'running', exitCode: null, finishedAt: null });
    await new Promise((resolveSent, reject) => child.send('start', error => error ? reject(error) : resolveSent()));
    child.unref();
    return { fileKey: key, pid: child.pid, logPath, status: `figma-cli make deploy status --file ${key}` };
  } catch (error) { releaseDeployLock(owner); throw error; }
  finally { stopHeartbeat(); if (log !== undefined) closeSync(log); }
}

export async function awaitDetachedStart() {
  await new Promise((resolveReady, reject) => {
    process.once('message', resolveReady);
    process.once('disconnect', () => reject(new Error('Deploy launcher disconnected before startup.')));
  });
  process.disconnect();
}
