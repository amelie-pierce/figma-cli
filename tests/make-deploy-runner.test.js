import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireDeployLock, finishDeployRunner, readDeployRunner, releaseDeployLock, startDetachedDeploy, updateDeployLock } from '../src/make-deploy-runner.js';
import { deployStatus } from '../src/make-deploy-status.js';
import { deployDir, planDigest, RECEIPT_SCHEMA } from '../src/make-deploy.js';

const lockPath = home => join(deployDir(home), 'locks', createHash('sha256').update('key').digest('hex'));

it('refuses another writer and requires explicit stale-lock recovery', t => {
  const home = mkdtempSync(join(tmpdir(), 'deploy-lock-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = acquireDeployLock('exact-key', { home });
  assert.throws(() => acquireDeployLock('exact-key', { home }), { code: 'DEPLOY_WRITER_LOCKED' });
  const cli = spawnSync(process.execPath, ['src/index.js', 'make', 'deploy', '--file', 'exact-key', '--apply', 'unused-plan'],
    { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /DEPLOY_WRITER_LOCKED/);
  const other = acquireDeployLock('other-key', { home });
  releaseDeployLock(other);
  updateDeployLock(first, 2147483647);
  assert.throws(() => acquireDeployLock('exact-key', { home }), { code: 'DEPLOY_STALE_LOCK' });
  const recovered = acquireDeployLock('exact-key', { home, clearStale: true });
  releaseDeployLock(first);
  assert.throws(() => acquireDeployLock('exact-key', { home }), { code: 'DEPLOY_WRITER_LOCKED' });
  releaseDeployLock(recovered);
});

it('starts a detached process and reports its recorded final result without Make', async t => {
  const home = mkdtempSync(join(tmpdir(), 'deploy-runner-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fixture = join(home, 'child with spaces.mjs');
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/make-deploy-runner.js')).href;
  writeFileSync(fixture, `import { finishDeployRunner, releaseDeployLock } from ${JSON.stringify(moduleUrl)};\n` +
    `process.once('message', () => { process.stdout.write('fake deploy done\\n');` +
    `finishDeployRunner('key', process.env.FIGMA_CLI_DEPLOY_RUNNER_TOKEN, 0, { home: ${JSON.stringify(home)} });` +
    `releaseDeployLock({ key: 'key', token: process.env.FIGMA_CLI_DEPLOY_RUNNER_TOKEN, home: ${JSON.stringify(home)} }); process.disconnect(); });\n`);
  const launched = await startDetachedDeploy('key', [], { home, cliEntry: fileURLToPath(pathToFileURL(fixture)) });
  assert.ok(launched.pid > 0);
  let runner;
  for (let i = 0; i < 50; i++) {
    runner = readDeployRunner('key', { home });
    if (runner?.finishedAt) break;
    await delay(20);
  }
  assert.equal(runner.state, 'finished');
  assert.equal(runner.exitCode, 0);
  assert.match(readFileSync(launched.logPath, 'utf8'), /fake deploy done/);
  assert.equal(deployStatus({ fileKey: 'key', home }).runner.state, 'finished');
  assert.throws(() => deployStatus({ home }), /requires --receipt/);
});

it('recovers an old ownerless lock but protects a fresh partial acquisition', t => {
  const home = mkdtempSync(join(tmpdir(), 'deploy-ownerless-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lock = lockPath(home);
  mkdirSync(lock, { recursive: true });
  assert.throws(() => acquireDeployLock('key', { home, clearStale: true }), { code: 'DEPLOY_WRITER_LOCKED' });
  const old = new Date(Date.now() - 5000);
  utimesSync(lock, old, old);
  assert.throws(() => acquireDeployLock('key', { home }), { code: 'DEPLOY_STALE_LOCK' });
  const recovered = acquireDeployLock('key', { home, clearStale: true });
  assert.ok(statSync(join(lock, 'owner.json')).isFile());
  releaseDeployLock(recovered);
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), '{"fileKey":');
  utimesSync(join(lock, 'owner.json'), old, old);
  utimesSync(lock, old, old);
  const partial = acquireDeployLock('key', { home, clearStale: true });
  releaseDeployLock(partial);
});

it('rejects a reused PID and retains the replacement owner through stale clearing', t => {
  const home = mkdtempSync(join(tmpdir(), 'deploy-identity-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const owner = acquireDeployLock('key', { home });
  const lock = lockPath(home);
  const record = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ ...record, processStartedAt: '2000-01-01T00:00:00.000Z' }));
  assert.throws(() => acquireDeployLock('key', { home }), { code: 'DEPLOY_STALE_LOCK' });
  const replacement = acquireDeployLock('key', { home, clearStale: true });
  releaseDeployLock(owner);
  assert.throws(() => acquireDeployLock('key', { home, clearStale: true }), { code: 'DEPLOY_WRITER_LOCKED' });
  releaseDeployLock(replacement);
});

it('keeps exactly one writer when two processes clear a dead lock', async t => {
  const home = mkdtempSync(join(tmpdir(), 'deploy-race-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stale = acquireDeployLock('key', { home });
  updateDeployLock(stale, 2147483647);
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/make-deploy-runner.js')).href;
  const fixture = join(home, 'contender.mjs');
  writeFileSync(fixture, `import { acquireDeployLock, releaseDeployLock } from ${JSON.stringify(moduleUrl)};\n` +
    `process.stdin.once('data', () => { try { const owner = acquireDeployLock('key', { home: ${JSON.stringify(home)}, clearStale: true });` +
    `process.stdout.write('acquired\\n'); setTimeout(() => { releaseDeployLock(owner); process.exit(0); }, 500); }` +
    `catch (error) { process.stdout.write(error.code + '\\n'); process.exit(0); } });\n`);
  const run = () => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [fixture], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.once('error', reject);
    child.once('close', () => resolveRun(output.trim()));
    child.stdin.write('go\n');
  });
  const outcomes = await Promise.all([run(), run()]);
  assert.deepEqual(outcomes.sort(), ['DEPLOY_WRITER_LOCKED', 'acquired']);
});

it('associates a runner with its receipt for both status selectors', async t => {
  const home = mkdtempSync(join(tmpdir(), 'deploy-associated-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const plan = { files: [{ path: 'src/a.ts' }] };
  const dir = deployDir(home);
  mkdirSync(dir, { recursive: true });
  const older = join(dir, 'older.json');
  const receipt = join(dir, 'current.json');
  const base = { schema: RECEIPT_SCHEMA, plan, planDigest: planDigest(plan), fileKey: 'key',
    stage: 'writing', outcome: 'uncertain', completedWrites: [] };
  writeFileSync(older, JSON.stringify({ ...base, at: '2026-10-15T01:00:00.000Z' }));
  const fixture = join(home, 'receipt child.mjs');
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/make-deploy-runner.js')).href;
  writeFileSync(fixture, `import { writeFileSync } from 'node:fs'; import { finishDeployRunner, releaseDeployLock } from ${JSON.stringify(moduleUrl)};\n` +
    `process.once('message', () => { writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ ...${JSON.stringify(base)},` +
    ` runnerId: process.env.FIGMA_CLI_DEPLOY_RUNNER_ID, at: new Date().toISOString(), completedWrites: [{ path: 'src/a.ts' }] }));` +
    `setTimeout(() => { finishDeployRunner('key', process.env.FIGMA_CLI_DEPLOY_RUNNER_TOKEN, 0, { home: ${JSON.stringify(home)} });` +
    `releaseDeployLock({ key: 'key', token: process.env.FIGMA_CLI_DEPLOY_RUNNER_TOKEN, home: ${JSON.stringify(home)} }); process.disconnect(); }, 250); });\n`);
  await startDetachedDeploy('key', [], { home, cliEntry: fixture });
  let status;
  for (let i = 0; i < 50; i++) {
    if (existsSync(receipt)) status = deployStatus({ receiptPath: receipt, home });
    if (status?.runner?.state === 'running') break;
    await delay(10);
  }
  assert.equal(status.runner?.state, 'running');
  assert.equal(status.completedWrites, 1);
  assert.equal(deployStatus({ fileKey: 'key', home }).runner?.id, status.runner.id);
  assert.equal(deployStatus({ receiptPath: older, home }).runner, null);
  for (let i = 0; i < 50 && !readDeployRunner('key', { home })?.finishedAt; i++) await delay(10);
});
