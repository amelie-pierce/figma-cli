import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireDeployLock, readDeployRunner, releaseDeployLock, renewDeployLock, startDetachedDeploy, startDeployHeartbeat, guardDeployClient } from '../src/make-deploy-runner.js';
import { assertDeployLock, deployLockPath, readDeployLease } from '../src/make-deploy-lock.js';
import { deployStatus } from '../src/make-deploy-status.js';
import { deployDir, planDigest, RECEIPT_SCHEMA } from '../src/make-deploy.js';

const moduleUrl = pathToFileURL(resolve('src/make-deploy-runner.js')).href;
const waitFor = async read => {
  for (let i = 0; i < 250; i++) {
    const value = read();
    if (value) return value;
    await delay(20);
  }
  assert.fail('Timed out waiting for the offline child');
};
const temporary = t => {
  const home = mkdtempSync(join(tmpdir(), 'deploy-runner-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
};
const childFixture = (home, body, name = 'child with spaces.mjs') => {
  const path = join(home, name);
  writeFileSync(path, body);
  return path;
};
const childRun = (t, path) => {
  const child = spawn(process.execPath, [path], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { errors += bytes; });
  const closed = new Promise(resolve => child.once('close', code => resolve({ code, output, errors })));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await closed; });
  return { child, closed, output: () => output };
};

it('refuses apply, verify, resume and abort before connecting when a live lease exists', t => {
  const home = temporary(t);
  const first = acquireDeployLock('key', { home });
  for (const action of ['apply', 'verify', 'resume', 'abort']) {
    const cli = spawnSync(process.execPath, ['src/index.js', 'make', 'deploy', '--file', 'key', `--${action}`, 'unused'],
      { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /DEPLOY_WRITER_LOCKED/);
  }
  assert.throws(() => acquireDeployLock('key', { home, clearStale: true }), { code: 'DEPLOY_WRITER_LOCKED' });
  const before = readDeployLease('key', { home });
  renewDeployLock(first);
  assert.notEqual(readDeployLease('key', { home }).revision, before.revision);
  releaseDeployLock(first);
});

it('recovers expired ownership explicitly and rejects old owner renew/release', async t => {
  const home = temporary(t);
  const first = acquireDeployLock('key', { home, leaseMs: 100 });
  await delay(150);
  assert.throws(() => acquireDeployLock('key', { home }), { code: 'DEPLOY_STALE_LOCK' });
  const replacement = acquireDeployLock('key', { home, clearStale: true });
  releaseDeployLock(first);
  assert.throws(() => renewDeployLock(first), { code: 'DEPLOY_WRITER_LOCKED' });
  assertDeployLock(replacement);
  releaseDeployLock(replacement);
});

it('a crash before publication leaves no blocking ownerless or partial lock', t => {
  const home = temporary(t);
  const dir = deployLockPath('key', home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.unpublished.tmp'), '{"token":');
  const owner = acquireDeployLock('key', { home });
  assertDeployLock(owner);
  releaseDeployLock(owner);
  // Corruption of published state must fail closed, unlike an ignored temp file.
  writeFileSync(join(dir, `${readDeployLease('key', { home }).sequence}.json`), '{');
  assert.throws(() => acquireDeployLock('key', { home, clearStale: true }), /Unreadable deploy lease/);
});

it('keeps the lease journal bounded through renewal and replacement', t => {
  const home = temporary(t);
  const dir = deployLockPath('key', home);
  const first = acquireDeployLock('key', { home });
  for (let i = 0; i < 100; i++) renewDeployLock(first);
  assert.ok(readdirSync(dir).filter(name => name.endsWith('.json')).length <= 2);
  assertDeployLock(first);
  releaseDeployLock(first);
  const second = acquireDeployLock('key', { home });
  assertDeployLock(second);
  assert.ok(readdirSync(dir).filter(name => name.endsWith('.json')).length <= 2);
  releaseDeployLock(second);
});

for (const stale of [false, true]) it(`${stale ? 'stale takeover' : 'initial acquire'} races publish only one owner`, async t => {
  const home = temporary(t);
  if (stale) { acquireDeployLock('key', { home, leaseMs: 100 }); await delay(150); }
  const path = childFixture(home, `
    import fs from 'node:fs';
    import { acquireDeployLock } from ${JSON.stringify(moduleUrl)};
    process.stdout.write('ready\\n');
    fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    try {
      acquireDeployLock('key', { home: ${JSON.stringify(home)}, clearStale: true });
      process.stdout.write('acquired\\n');
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    } catch (error) { process.stdout.write(error.code + '\\n'); }
  `);
  const runs = [childRun(t, path), childRun(t, path)];
  await waitFor(() => runs.every(run => run.output().includes('ready')));
  for (const run of runs) run.child.stdin.write('g');
  await waitFor(() => runs.every(run => /acquired|DEPLOY_WRITER_LOCKED/.test(run.output())));
  assert.equal(runs.filter(run => run.output().includes('acquired')).length, 1);
  assert.equal(runs.filter(run => run.output().includes('DEPLOY_WRITER_LOCKED')).length, 1);
  for (const run of runs) if (run.output().includes('acquired')) run.child.stdin.write('q');
  for (const run of runs) assert.equal((await run.closed).code, 0);
});

it('a stale clearer paused at CAS cannot replace the next live lease', async t => {
  const home = temporary(t);
  acquireDeployLock('key', { home, leaseMs: 100 });
  await delay(150);
  const path = childFixture(home, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const link = fs.linkSync;
    fs.linkSync = (...args) => {
      process.stdout.write('observed\\n');
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      return link(...args);
    };
    syncBuiltinESMExports();
    const { acquireDeployLock } = await import(${JSON.stringify(moduleUrl)});
    try { acquireDeployLock('key', { home: ${JSON.stringify(home)}, clearStale: true }); }
    catch (error) { process.stdout.write(error.code); }
  `);
  const run = childRun(t, path);
  await waitFor(() => run.output().includes('observed'));
  const replacement = acquireDeployLock('key', { home, clearStale: true });
  run.child.stdin.write('g');
  const result = await run.closed;
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /DEPLOY_WRITER_LOCKED/);
  assertDeployLock(replacement);
  releaseDeployLock(replacement);
});

it('does not persist death when a paused renewal wins the lease revision', async t => {
  const home = temporary(t);
  const owner = acquireDeployLock('key', { home, leaseMs: 3000 });
  const runners = join(deployDir(home), 'runners', createHash('sha256').update('key').digest('hex'));
  mkdirSync(runners, { recursive: true });
  writeFileSync(join(runners, `${owner.runId}.json`), JSON.stringify({ fileKey: 'key', id: owner.runId,
    sequence: 1, token: owner.token, state: 'running', exitCode: null, finishedAt: null }));
  const lockUrl = pathToFileURL(resolve('src/make-deploy-lock.js')).href;
  const renewal = childRun(t, childFixture(home, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const link = fs.linkSync;
    fs.linkSync = (...args) => {
      process.stdout.write('renew-observed\\n');
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      return link(...args);
    };
    syncBuiltinESMExports();
    const { renewDeployLock } = await import(${JSON.stringify(lockUrl)});
    renewDeployLock(${JSON.stringify({ ...owner, leaseMs: 10000 })});
    process.stdout.write('renewed\\n');
  `));
  await waitFor(() => renewal.output().includes('renew-observed'));
  await delay(Math.max(0, readDeployLease('key', { home }).leaseUntil - Date.now() + 20));
  const status = childRun(t, childFixture(home, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const link = fs.linkSync;
    fs.linkSync = (...args) => {
      process.stdout.write('status-observed\\n');
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      return link(...args);
    };
    syncBuiltinESMExports();
    const { readDeployRunner } = await import(${JSON.stringify(moduleUrl)});
    const runner = readDeployRunner('key', { home: ${JSON.stringify(home)} });
    process.stdout.write(JSON.stringify({ state: runner.state, alive: runner.alive }));
  `, 'status with spaces.mjs'));
  await waitFor(() => status.output().includes('status-observed'));
  renewal.child.stdin.write('g');
  assert.equal((await renewal.closed).code, 0);
  status.child.stdin.write('g');
  const result = await status.closed;
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /"state":"running","alive":true/);
  assert.equal(readdirSync(runners).some(name => name.endsWith('.final')), false);
  releaseDeployLock(owner);
});

it('renews during a synchronous command longer than the lease, without ps or PID identity', async t => {
  const home = temporary(t);
  const owner = acquireDeployLock('key', { home, leaseMs: 1000 });
  const stop = await startDeployHeartbeat(owner);
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { acquireDeployLock } from ${JSON.stringify(moduleUrl)};
      await new Promise(resolve => setTimeout(resolve, 2200));
      try { acquireDeployLock('key', { home: ${JSON.stringify(home)}, clearStale: true }); process.exitCode = 2; }
      catch (error) { process.stdout.write(error.code); }
    `], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'DEPLOY_WRITER_LOCKED');
    stop.assert();
  } finally { await stop(); releaseDeployLock(owner); }
});

it('lost ownership fences later client operations while still allowing close', async t => {
  const home = temporary(t);
  const owner = acquireDeployLock('key', { home, leaseMs: 100 });
  let writes = 0, closed = false;
  const client = guardDeployClient({ write() { writes++; }, close() { closed = true; } }, () => assertDeployLock(owner));
  client.write();
  await delay(150);
  const replacement = acquireDeployLock('key', { home, clearStale: true });
  assert.throws(() => client.write(), /ownership changed/);
  client.close();
  assert.equal(writes, 1);
  assert.equal(closed, true);
  releaseDeployLock(replacement);
});

const readyChild = (home, body = '', before = '') => childFixture(home, `
  import { awaitDetachedStart, acknowledgeDetachedStart, requireDetachedOwner, startDeployHeartbeat, finishDeployRunner, releaseDeployLock } from ${JSON.stringify(moduleUrl)};
  import { writeFileSync, existsSync } from 'node:fs';
  import { join } from 'node:path';
  ${before}
  await awaitDetachedStart();
  const owner = requireDetachedOwner('key', process.env.FIGMA_CLI_DEPLOY_RUNNER_TOKEN, { home: ${JSON.stringify(home)} });
  const stop = await startDeployHeartbeat(owner);
  await acknowledgeDetachedStart();
  ${body}
  await stop();
  finishDeployRunner('key', owner.token, 0, { home: owner.home, runId: owner.runId });
  releaseDeployLock(owner);
`);

it('retains per-run history and associates receipts by ID despite clock rollback', async t => {
  const home = temporary(t);
  const dir = deployDir(home);
  const plan = { files: [{ path: 'src/a.ts' }] };
  const base = { schema: RECEIPT_SCHEMA, plan, planDigest: planDigest(plan), fileKey: 'key',
    stage: 'writing', outcome: 'uncertain', completedWrites: [{ path: 'src/a.ts' }] };
  const path = readyChild(home, `
    const sequence = Number(process.env.FIGMA_CLI_DEPLOY_SEQUENCE);
    const receipt = { ...${JSON.stringify(base)}, runnerId: owner.runId, sequence,
      at: sequence === 1 ? '2030-01-01T00:00:00.000Z' : '2000-01-01T00:00:00.000Z' };
    while (!existsSync(join(${JSON.stringify(home)}, 'release-' + sequence))) await new Promise(resolve => setTimeout(resolve, 20));
    writeFileSync(join(${JSON.stringify(dir)}, owner.runId + '.json'), JSON.stringify(receipt));
  `);
  const first = await startDetachedDeploy('key', [], { home, cliEntry: path });
  const firstReceipt = join(dir, first.runId + '.json');
  writeFileSync(join(home, 'release-1'), 'go');
  await waitFor(() => readDeployRunner('key', { home, runId: first.runId })?.finishedAt && !readDeployLease('key', { home }).token);
  const firstRecord = readDeployRunner('key', { home, runId: first.runId });
  const second = await startDetachedDeploy('key', [], { home, cliEntry: path });
  const starting = deployStatus({ fileKey: 'key', home });
  assert.equal(starting.receiptPath, null);
  assert.equal(starting.runner.id, second.runId);
  const secondReceipt = join(dir, second.runId + '.json');
  writeFileSync(join(home, 'release-2'), 'go');
  await waitFor(() => readDeployRunner('key', { home, runId: second.runId })?.finishedAt && !readDeployLease('key', { home }).token);
  assert.notEqual(first.runId, second.runId);
  assert.notEqual(first.logPath, second.logPath);
  assert.equal(deployStatus({ receiptPath: firstReceipt, home }).runner.id, first.runId);
  assert.equal(deployStatus({ receiptPath: secondReceipt, home }).runner.id, second.runId);
  assert.equal(deployStatus({ fileKey: 'key', home }).receiptPath, secondReceipt);
  assert.deepEqual(readDeployRunner('key', { home, runId: first.runId }), firstRecord);
});

it('waits for child readiness across delayed initialization and paths with spaces', async t => {
  const home = temporary(t);
  const path = readyChild(home, '', 'await new Promise(resolve => setTimeout(resolve, 300));');
  const result = await startDetachedDeploy('key', [], { home, cliEntry: path });
  const record = await waitFor(() => { const value = readDeployRunner('key', { home }); return value?.finishedAt && value; });
  assert.equal(record.id, result.runId);
  assert.equal(record.state, 'finished');
  assert.equal(record.exitCode, 0);
  await waitFor(() => !readDeployLease('key', { home }).token);
});

for (const [name, body, pattern] of [
  ['early exit', 'process.exit(7);', /(?:exited|disconnected) before startup/],
  ['never ready', 'setInterval(() => {}, 1000);', /startup timed out/],
]) it(`records ${name} as failure and releases only after the child stops`, async t => {
  const home = temporary(t);
  await assert.rejects(startDetachedDeploy('key', [], { home, cliEntry: childFixture(home, body), startupMs: 500 }), pattern);
  assert.equal(readDeployRunner('key', { home }).state, 'failed');
  const record = readDeployRunner('key', { home });
  assert.match(record.error, pattern);
  assert.ok(Number.isInteger(record.pid));
  if (name === 'early exit') assert.equal(record.exitCode, 7);
  else { assert.equal(record.exitCode, null); assert.equal(record.signal, 'SIGKILL'); }
  assert.equal(readDeployLease('key', { home }).token, null);
});

it('a killed runner persists a terminal result after lease expiry', async t => {
  const home = temporary(t);
  const path = childFixture(home, `
    import { awaitDetachedStart, acknowledgeDetachedStart } from ${JSON.stringify(moduleUrl)};
    await awaitDetachedStart(); await acknowledgeDetachedStart(); setInterval(() => {}, 1000);
  `);
  const result = await startDetachedDeploy('key', [], { home, cliEntry: path });
  const dir = join(deployDir(home), 'runners');
  const recordPath = join(dir, readdirSync(dir)[0], result.runId + '.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  writeFileSync(recordPath, JSON.stringify({ ...record, pid: process.pid }));
  process.kill(result.pid, 'SIGKILL');
  const now = Date.now;
  t.mock.method(Date, 'now', () => now() + 180000);
  const died = readDeployRunner('key', { home });
  assert.equal(died.state, 'died');
  assert.equal(died.alive, false);
  assert.equal(died.exitCode, null);
  assert.equal(died.reason, 'lease-expired');
  assert.ok(died.observedAt);
  assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).state, 'died');
  assert.deepEqual(readDeployRunner('key', { home }), died);
});


it('public detached CLI starts from a path with spaces using an offline client', async t => {
  const home = temporary(t);
  const cliRoot = join(home, 'CLI with spaces');
  mkdirSync(cliRoot);
  cpSync(resolve('src'), join(cliRoot, 'src'), { recursive: true });
  cpSync(resolve('package.json'), join(cliRoot, 'package.json'));
  symlinkSync(resolve('node_modules'), join(cliRoot, 'node_modules'), 'dir');
  const preload = childFixture(cliRoot, `
    import { MakeClient } from './src/make-client.js';
    MakeClient.prototype.connect = async () => { throw new Error('offline fake client failure'); };
  `, 'offline-client.mjs');
  const cli = spawnSync(process.execPath, [join(cliRoot, 'src/index.js'), 'make', 'deploy', '--file', 'key', '--apply', 'unused', '--detach'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CI: '1', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
  });
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  const record = await waitFor(() => { const value = readDeployRunner('key', { home, runId: result.runId }); return value?.finishedAt && value; });
  assert.equal(record.pid, result.pid);
  assert.equal(record.state, 'failed');
  assert.equal(record.exitCode, 1);
  assert.match(readFileSync(result.logPath, 'utf8'), /offline fake client failure/);
  await waitFor(() => !readDeployLease('key', { home }).token);
});
