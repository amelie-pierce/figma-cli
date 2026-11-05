import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireDeployLock, finishDeployRunner, readDeployRunner, releaseDeployLock, renewDeployLock, startDetachedDeploy } from '../src/make-deploy-runner.js';
import { deployStatus } from '../src/make-deploy-status.js';
import { deployDir, planDigest, RECEIPT_SCHEMA } from '../src/make-deploy.js';

const lockPath = home => join(deployDir(home), 'locks', createHash('sha256').update('key').digest('hex'));
const moduleUrl = pathToFileURL(resolve('src/make-deploy-runner.js')).href;
const waitFor = async read => {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (value) return value;
    await delay(20);
  }
  assert.fail('Timed out waiting for the offline child');
};
const expire = home => {
  const path = join(lockPath(home), 'owner.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), leaseUntil: Date.now() - 1 }));
};

it('refuses a second writer during a live lease and recovers after expiry', t => {
  const home = mkdtempSync(join(tmpdir(), 'deploy-lease-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = acquireDeployLock('key', { home });
  assert.throws(() => acquireDeployLock('key', { home, clearStale: true }), { code: 'DEPLOY_WRITER_LOCKED' });
  const cli = spawnSync(process.execPath, ['src/index.js', 'make', 'deploy', '--file', 'key', '--apply', 'unused-plan'],
    { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /DEPLOY_WRITER_LOCKED/);
  const before = JSON.parse(readFileSync(join(lockPath(home), 'owner.json'), 'utf8')).leaseUntil;
  renewDeployLock(first);
  assert.ok(JSON.parse(readFileSync(join(lockPath(home), 'owner.json'), 'utf8')).leaseUntil >= before);
  expire(home);
  assert.throws(() => acquireDeployLock('key', { home }), { code: 'DEPLOY_STALE_LOCK' });
  const recovered = acquireDeployLock('key', { home, clearStale: true });
  releaseDeployLock(first);
  assert.throws(() => acquireDeployLock('key', { home, clearStale: true }), { code: 'DEPLOY_WRITER_LOCKED' });
  releaseDeployLock(recovered);
});

it('recovers ownerless and partial locks only after the lease window', t => {
  const home = mkdtempSync(join(tmpdir(), 'deploy-ownerless-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lock = lockPath(home);
  mkdirSync(lock, { recursive: true });
  assert.throws(() => acquireDeployLock('key', { home, clearStale: true }), { code: 'DEPLOY_WRITER_LOCKED' });
  const old = new Date(Date.now() - 300000);
  utimesSync(lock, old, old);
  const first = acquireDeployLock('key', { home, clearStale: true });
  assert.ok(statSync(join(lock, 'owner.json')).isFile());
  releaseDeployLock(first);
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), '{"fileKey":');
  utimesSync(join(lock, 'owner.json'), old, old);
  utimesSync(lock, old, old);
  const second = acquireDeployLock('key', { home, clearStale: true });
  releaseDeployLock(second);
});

it('two stale clearers cannot remove the replacement lease', async t => {
  const home = mkdtempSync(join(tmpdir(), 'deploy-race-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  acquireDeployLock('key', { home });
  expire(home);
  const fixture = join(home, 'contender.mjs');
  writeFileSync(fixture, [
    `import { acquireDeployLock, releaseDeployLock } from ${JSON.stringify(moduleUrl)};`,
    `process.stdin.once('data', () => { try { const owner = acquireDeployLock('key', { home: ${JSON.stringify(home)}, clearStale: true });`,
    "process.stdout.write('acquired\\n'); setTimeout(() => { releaseDeployLock(owner); process.exit(0); }, 500); }",
    "catch (error) { process.stdout.write(error.code + '\\n'); process.exit(0); } });",
  ].join('\n'));
  const run = () => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [fixture], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.once('error', reject);
    child.once('close', () => resolveRun(output.trim()));
    child.stdin.write('go\n');
  });
  assert.deepEqual((await Promise.all([run(), run()])).sort(), ['DEPLOY_WRITER_LOCKED', 'acquired']);
});

it('uses leases without ps or PID identity', t => {
  const home = mkdtempSync(join(tmpdir(), 'deploy-no-ps-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fixture = join(home, 'no-ps.mjs');
  writeFileSync(fixture, `import { acquireDeployLock, releaseDeployLock } from ${JSON.stringify(moduleUrl)};\n` +
    `const owner = acquireDeployLock('key', { home: ${JSON.stringify(home)} }); releaseDeployLock(owner); process.stdout.write('ok');\n`);
  const child = spawnSync(process.execPath, [fixture], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'ok');
});

it('retains two detached runner records and selects by sequence despite clock rollback', async t => {
  const home = mkdtempSync(join(tmpdir(), 'deploy-history-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = deployDir(home);
  mkdirSync(dir, { recursive: true });
  const plan = { files: [{ path: 'src/a.ts' }] };
  const base = { schema: RECEIPT_SCHEMA, plan, planDigest: planDigest(plan), fileKey: 'key',
    stage: 'writing', outcome: 'uncertain', completedWrites: [{ path: 'src/a.ts' }] };
  const fixture = join(home, 'receipt child with spaces.mjs');
  writeFileSync(fixture, [
    "import { writeFileSync } from 'node:fs';",
    `import { join } from 'node:path'; import { finishDeployRunner, releaseDeployLock } from ${JSON.stringify(moduleUrl)};`,
    `process.once('message', () => { const runId = process.env.FIGMA_CLI_DEPLOY_RUNNER_ID;`,
    `const sequence = Number(process.env.FIGMA_CLI_DEPLOY_SEQUENCE); const receipt = { ...${JSON.stringify(base)},`,
    "runnerId: runId, sequence, at: sequence === 1 ? '2030-01-01T00:00:00.000Z' : '2000-01-01T00:00:00.000Z' };",
    `writeFileSync(join(${JSON.stringify(dir)}, runId + '.json'), JSON.stringify(receipt));`,
    `finishDeployRunner('key', process.env.FIGMA_CLI_DEPLOY_RUNNER_TOKEN, 0, { home: ${JSON.stringify(home)} });`,
    `releaseDeployLock({ key: 'key', token: process.env.FIGMA_CLI_DEPLOY_RUNNER_TOKEN, runId, home: ${JSON.stringify(home)} }); process.disconnect(); });`,
  ].join('\n'));
  const first = await startDetachedDeploy('key', [], { home, cliEntry: fixture });
  const firstRunner = readDeployRunner('key', { home });
  const firstReceipt = join(dir, firstRunner.id + '.json');
  await waitFor(() => existsSync(firstReceipt) && readDeployRunner('key', { home, runId: firstRunner.id })?.finishedAt && !existsSync(lockPath(home)));
  const second = await startDetachedDeploy('key', [], { home, cliEntry: fixture });
  const secondRunner = readDeployRunner('key', { home });
  const secondReceipt = join(dir, secondRunner.id + '.json');
  await waitFor(() => existsSync(secondReceipt) && readDeployRunner('key', { home, runId: secondRunner.id })?.finishedAt && !existsSync(lockPath(home)));
  assert.notEqual(firstRunner.id, secondRunner.id);
  assert.notEqual(first.logPath, second.logPath);
  assert.equal(deployStatus({ receiptPath: firstReceipt, home }).runner.id, firstRunner.id);
  assert.equal(deployStatus({ receiptPath: secondReceipt, home }).runner.id, secondRunner.id);
  assert.equal(deployStatus({ fileKey: 'key', home }).receiptPath, secondReceipt);
  assert.equal(readDeployRunner('key', { home, runId: firstRunner.id }).state, 'finished');
});

it('starts the public CLI child from a path containing spaces', async t => {
  const root = mkdtempSync(join(process.cwd(), 'tests', 'deploy cli with spaces-'));
  const home = mkdtempSync(join(tmpdir(), 'deploy-cli-space-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  symlinkSync(resolve('src'), join(root, 'src'), 'dir');
  symlinkSync(resolve('package.json'), join(root, 'package.json'));
  const entry = join(root, 'src', 'index.js');
  const cli = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', entry,
    'make', 'deploy', '--file', 'key', '--apply', 'missing-plan', '--detach', '--timeout', '500'],
  { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, FIGMA_PORT: '65534' } });
  assert.equal(cli.status, 0, cli.stderr);
  const runner = await waitFor(() => {
    const value = readDeployRunner('key', { home });
    return value?.finishedAt && value;
  });
  assert.equal(runner.state, 'failed');
  assert.equal(runner.exitCode, 1);
});
