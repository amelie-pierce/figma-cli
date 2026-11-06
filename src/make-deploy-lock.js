import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

export const DEPLOY_LEASE_MS = 120000;
export const deployLockPath = (key, home = homedir()) => join(home, '.figma-cli', 'deploys', 'locks', createHash('sha256').update(key).digest('hex'));
const locked = (message, code = 'DEPLOY_WRITER_LOCKED') => Object.assign(new Error(message), { code });
const expired = state => state.leaseUntil <= Date.now();

// Each revision has exactly one successor. Publishing a complete temporary file
// with link(2) is an exclusive CAS on that revision, including on Windows NTFS.
// Never rename/delete a live lock path: a delayed stale clearer cannot touch a
// replacement. Unpublished temporary files left by a crash are inert.
export function readDeployLease(key, { home } = {}) {
  const dir = deployLockPath(key, home);
  let state = { revision: 'root', token: null, runId: null, fileKey: key, leaseUntil: 0 };
  while (true) {
    let next;
    try { next = JSON.parse(readFileSync(join(dir, `${state.revision}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return state; throw locked(`Unreadable deploy lease for ${key}: ${error.message}`); }
    if (next.fileKey !== key || !/^[a-f0-9-]{36}$/.test(next.revision) || next.revision === state.revision ||
      !Number.isFinite(next.leaseUntil) || (next.token !== null && (typeof next.token !== 'string' || typeof next.runId !== 'string'))) {
      throw locked(`Invalid deploy lease for ${key}; inspect local lock records.`);
    }
    state = next;
  }
}

function compareAndSwap(key, home, observed, next) {
  const dir = deployLockPath(key, home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify({ ...next, fileKey: key, revision: randomUUID() }), { flag: 'wx', mode: 0o600 });
    try { linkSync(temp, join(dir, `${observed.revision}.json`)); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
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
