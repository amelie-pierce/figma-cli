import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

export const DEPLOY_LEASE_MS = 120000;
export const deployLockPath = (key, home = homedir()) => join(home, '.figma-cli', 'deploys', 'locks', createHash('sha256').update(key).digest('hex'));
const locked = (message, code = 'DEPLOY_WRITER_LOCKED') => Object.assign(new Error(message), { code });
const expired = state => state.leaseUntil <= Date.now();

export function readDeployLease(key, { home } = {}) {
  const dir = deployLockPath(key, home);
  while (true) {
    let names;
    try { names = readdirSync(dir).filter(name => /^(0|[1-9]\d*)\.json$/.test(name)); }
    catch (error) { if (error.code === 'ENOENT') return { sequence: 0, revision: 'root', token: null, runId: null, fileKey: key, leaseUntil: 0 }; throw error; }
    if (!names.length) return { sequence: 0, revision: 'root', token: null, runId: null, fileKey: key, leaseUntil: 0 };
    const latest = names.reduce((a, b) => Number(a.slice(0, -5)) > Number(b.slice(0, -5)) ? a : b);
    let state;
    try { state = JSON.parse(readFileSync(join(dir, latest), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw locked(`Unreadable deploy lease for ${key}: ${error.message}`); }
    if (state.fileKey !== key || state.sequence !== Number(latest.slice(0, -5)) + 1 ||
      !/^[a-f0-9-]{36}$/.test(state.revision) || !Number.isFinite(state.leaseUntil) ||
      (state.token !== null && (typeof state.token !== 'string' || typeof state.runId !== 'string'))) {
      throw locked(`Invalid deploy lease for ${key}; inspect local lock records.`);
    }
    return state;
  }
}

function compareAndSwap(key, home, observed, next) {
  const dir = deployLockPath(key, home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${randomUUID()}.tmp`);
  const candidate = { ...next, fileKey: key, sequence: observed.sequence + 1, revision: randomUUID() };
  try {
    writeFileSync(temp, JSON.stringify(candidate), { flag: 'wx', mode: 0o600 });
    try { linkSync(temp, join(dir, `${observed.sequence}.json`)); }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    if (readDeployLease(key, { home }).revision !== candidate.revision) return false;
    try {
      for (const name of readdirSync(dir)) {
        if (/^(0|[1-9]\d*)\.json$/.test(name) && Number(name.slice(0, -5)) < candidate.sequence - 1) rmSync(join(dir, name), { force: true });
      }
    } catch {}
    return true;
  } finally { rmSync(temp, { force: true }); }
}

export function acquireDeployLock(key, { home, clearStale = false, token = randomUUID(), runId = randomUUID(), leaseMs = DEPLOY_LEASE_MS } = {}) {
  if (!Number.isFinite(leaseMs) || leaseMs < 100) throw new Error('Deploy lease must be at least 100ms.');
  while (true) {
    const observed = readDeployLease(key, { home });
    if (observed.token && !expired(observed)) throw locked(`A deploy writer for ${key} holds a live lease. Check make deploy status --file ${key}.`);
    if (observed.token && !clearStale) throw locked(`Stale deploy lock for ${key}. Inspect make deploy status --file ${key}, then retry with --clear-stale-lock.`, 'DEPLOY_STALE_LOCK');
    if (compareAndSwap(key, home, observed, { token, runId, leaseUntil: Date.now() + leaseMs })) return { key, home, token, runId, leaseMs };
  }
}

export function assertDeployLock(owner) {
  const current = readDeployLease(owner.key, { home: owner.home });
  if (current.token !== owner.token || current.runId !== owner.runId || expired(current)) throw locked('Deploy lock lease expired or ownership changed.');
  return current;
}

export function renewDeployLock(owner) {
  while (true) {
    const observed = assertDeployLock(owner);
    if (compareAndSwap(owner.key, owner.home, observed, { token: owner.token, runId: owner.runId, leaseUntil: Date.now() + owner.leaseMs })) return;
  }
}

export function releaseDeployLock(owner) {
  while (true) {
    const observed = readDeployLease(owner.key, { home: owner.home });
    if (observed.token !== owner.token || observed.runId !== owner.runId) return;
    if (compareAndSwap(owner.key, owner.home, observed, { token: null, runId: null, leaseUntil: 0 })) return;
  }
}

// A separate thread survives synchronous install/build/git commands on the main
// thread and dies with its process. Wait for its first renewal before doing work.
export async function startDeployHeartbeat(owner) {
  const health = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL('./make-deploy-heartbeat.js', import.meta.url), { workerData: { owner, health } });
  let failure;
  worker.on('error', error => { failure = error; Atomics.store(health, 0, 1); });
  worker.on('exit', () => Atomics.store(health, 0, 1));
  try {
    await new Promise((resolve, reject) => {
      worker.once('message', message => message === 'ready' ? resolve() : reject(new Error(message.error)));
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error(`Deploy heartbeat exited during startup (${code}).`)));
    });
  } catch (error) { await worker.terminate(); throw error; }
  worker.unref();
  const stop = () => worker.terminate();
  stop.assert = () => {
    if (Atomics.load(health, 0)) throw locked(`Deploy heartbeat stopped${failure ? `: ${failure.message}` : ''}.`);
    assertDeployLock(owner);
  };
  return stop;
}

// Recheck after local blocking work and before every client operation. A lost
// owner cannot resume issuing calls after another process takes over its lease.
export function guardDeployClient(client, assertOwner) {
  return new Proxy(client, { get(target, property) {
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' && property !== 'close' ? (...args) => { assertOwner(); return value.apply(target, args); } : value;
  } });
}
