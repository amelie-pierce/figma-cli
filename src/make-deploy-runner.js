import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deployDir } from './make-deploy.js';

import { acquireDeployLock as acquireLease, DEPLOY_LEASE_MS, readDeployLease, releaseDeployLock, startDeployHeartbeat } from './make-deploy-lock.js';
export { releaseDeployLock, renewDeployLock, startDeployHeartbeat, guardDeployClient } from './make-deploy-lock.js';
const keyHash = key => createHash('sha256').update(key).digest('hex');
const paths = (key, home) => {
  const dir = deployDir(home);
  const hash = keyHash(key);
  return { runners: join(dir, 'runners', hash), sequence: join(dir, 'runners', hash, 'sequence.json') };
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
const runnerPath = (key, runId, home) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid deploy run ID.');
  return join(paths(key, home).runners, `${runId}.json`);
};
const finalPath = (key, runId, home) => join(paths(key, home).runners, `${runId}.final`);
const readFinal = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const publishFinal = (key, runId, home, result) => {
  const path = finalPath(key, runId, home);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
    try { linkSync(temp, path); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  } finally { rmSync(temp, { force: true }); }
};

export function acquireDeployLock(key, options = {}) {
  readDeployRunner(key, { home: options.home });
  return acquireLease(key, options);
}

export function nextDeploySequence(key, { home } = {}) {
  const { sequence } = paths(key, home);
  const next = (json(sequence)?.value || 0) + 1;
  atomicJson(sequence, { value: next });
  return next;
}

export function requireDetachedOwner(key, token, { home } = {}) {
  const runId = process.env.FIGMA_CLI_DEPLOY_RUNNER_ID;
  const owner = readDeployLease(key, { home });
  const runner = runId && json(runnerPath(key, runId, home));
  if (!token || !runId || owner?.token !== token || owner.runId !== runId || expired(owner) || runner?.token !== token || runner.id !== runId) {
    throw locked(`Detached deploy for ${key} does not own its writer lock.`);
  }
  return { key, token, runId, home, leaseMs: DEPLOY_LEASE_MS };
}

export function readDeployRunner(key, { home, runId } = {}) {
  if (!key) return null;
  const { runners } = paths(key, home);
  const records = runId ? [runnerPath(key, runId, home)] : existsSync(runners)
    ? readdirSync(runners).filter(name => name.endsWith('.json') && name !== 'sequence.json').map(name => join(runners, name)) : [];
  const value = records.map(json).filter(item => item?.fileKey === key && item.id && (!runId || item.id === runId))
    .sort((a, b) => b.sequence - a.sequence)[0];
  if (!value) return null;
  const owner = readDeployLease(key, { home });
  let final = readFinal(finalPath(key, value.id, home));
  const alive = !value.finishedAt && !final && owner?.token === value.token && owner.runId === value.id && !expired(owner);
  if (!value.finishedAt && !final && !alive) {
    const observedAt = new Date(Date.now()).toISOString();
    const result = { state: 'died', exitCode: null, reason: 'lease-expired', observedAt, finishedAt: observedAt };
    if (publishFinal(key, value.id, home, result)) atomicJson(runnerPath(key, value.id, home), { ...value, ...result });
    final = readFinal(finalPath(key, value.id, home));
  }
  const { token, ...publicValue } = value;
  return { ...publicValue, ...final, state: final?.state || (value.finishedAt ? value.state : 'running'), alive: !!alive };
}

export function finishDeployRunner(key, token, exitCode, { home, runId = process.env.FIGMA_CLI_DEPLOY_RUNNER_ID, signal = null, error = null } = {}) {
  if (!runId) return;
  const record = runnerPath(key, runId, home);
  const value = json(record);
  if (value?.token !== token || value.finishedAt) return;
  const result = { state: exitCode === 0 && !signal && !error ? 'finished' : 'failed', exitCode, signal, error,
    finishedAt: new Date().toISOString() };
  if (publishFinal(key, runId, home, result)) atomicJson(record, { ...value, ...result });
}

export async function startDetachedDeploy(key, argv, { home, clearStale = false, cliEntry = resolve('src/index.js'), node = process.execPath, startupMs = 30000 } = {}) {
  const runId = randomUUID();
  const owner = acquireDeployLock(key, { home, clearStale, runId });
  const { runners } = paths(key, home);
  const record = runnerPath(key, runId, home);
  const logPath = join(runners, `${runId}.log`);
  let log, child, stopHeartbeat;
  try {
    stopHeartbeat = await startDeployHeartbeat(owner);
    mkdirSync(runners, { recursive: true, mode: 0o700 });
    const sequence = nextDeploySequence(key, { home });
    atomicJson(record, { fileKey: key, id: runId, sequence, token: owner.token, pid: null, logPath,
      startedAt: new Date().toISOString(), state: 'starting', exitCode: null, finishedAt: null });
    log = openSync(logPath, 'a', 0o600);
    child = spawn(node, [cliEntry, ...argv], { detached: true, stdio: ['ignore', log, log, 'ipc'],
      env: { ...process.env, FIGMA_CLI_DEPLOY_RUNNER_TOKEN: owner.token, FIGMA_CLI_DEPLOY_RUNNER_ID: runId, FIGMA_CLI_DEPLOY_SEQUENCE: String(sequence) } });
    await new Promise((resolveStarted, reject) => {
      let sent = false;
      const timer = setTimeout(() => fail(new Error('Detached deploy startup timed out.')), startupMs);
      const cleanup = () => {
        clearTimeout(timer);
        child.off('spawn', onSpawn);
        child.off('message', onMessage);
        child.off('error', fail);
        child.off('exit', onExit);
        child.off('disconnect', onDisconnect);
      };
      const fail = error => { cleanup(); reject(error); };
      const onSpawn = () => {
        try { atomicJson(record, { ...json(record), pid: child.pid }); }
        catch (error) { fail(error); }
      };
      const onExit = (code, signal) => fail(new Error(`Detached deploy exited before startup (${signal || code}).`));
      const onDisconnect = () => fail(new Error('Detached deploy disconnected before startup.'));
      const onMessage = message => {
        if (message === 'ready' && !sent) {
          try {
            stopHeartbeat.assert();
            atomicJson(record, { ...json(record), pid: child.pid, state: 'running' });
            sent = true;
            child.send('start', error => { if (error) fail(error); });
          } catch (error) { fail(error); }
        } else if (message === 'started' && sent) { cleanup(); resolveStarted(); }
      };
      child.once('spawn', onSpawn);
      child.on('message', onMessage);
      child.once('error', fail);
      child.once('exit', onExit);
      child.once('disconnect', onDisconnect);
    });
    child.unref();
    return { fileKey: key, runId, pid: child.pid, logPath, status: `figma-cli make deploy status --file ${key}` };
  } catch (error) {
    // Never release the lease while an unacknowledged child could still write.
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolveExit, rejectExit) => {
        child.once('exit', resolveExit);
        child.once('error', rejectExit);
        if (!child.kill('SIGKILL')) rejectExit(new Error('Could not stop detached deploy; writer lease retained.'));
      });
    }
    finishDeployRunner(key, owner.token, child?.signalCode ? null : child?.exitCode ?? 1,
      { home, runId, signal: child?.signalCode || null, error: error.message });
    releaseDeployLock(owner);
    throw error;
  } finally { await stopHeartbeat?.(); if (log !== undefined) closeSync(log); }
}

export async function awaitDetachedStart() {
  if (!process.send) throw new Error('Detached deploy requires launcher IPC.');
  await new Promise((resolveStart, reject) => {
    const cleanup = () => { process.off('message', onMessage); process.off('disconnect', onDisconnect); };
    const onMessage = message => { if (message === 'start') { cleanup(); resolveStart(); } };
    const onDisconnect = () => { cleanup(); reject(new Error('Deploy launcher disconnected before startup.')); };
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    process.send('ready', error => { if (error) { cleanup(); reject(error); } });
  });
}

export async function acknowledgeDetachedStart() {
  await new Promise((resolveSent, reject) => process.send('started', error => error ? reject(error) : resolveSent()));
  process.disconnect();
}
