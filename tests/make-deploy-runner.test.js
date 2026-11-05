import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireDeployLock, finishDeployRunner, readDeployRunner, releaseDeployLock, startDetachedDeploy, updateDeployLock } from '../src/make-deploy-runner.js';
import { deployStatus } from '../src/make-deploy-status.js';

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
  const fixture = join(home, 'child.mjs');
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/make-deploy-runner.js')).href;
  writeFileSync(fixture, `import { finishDeployRunner, releaseDeployLock } from ${JSON.stringify(moduleUrl)};\n` +
    `process.once('message', () => { process.stdout.write('fake deploy done\\n');` +
    `finishDeployRunner('key', process.env.FIGMA_CLI_DEPLOY_RUNNER_TOKEN, 0, { home: ${JSON.stringify(home)} });` +
    `releaseDeployLock({ key: 'key', token: process.env.FIGMA_CLI_DEPLOY_RUNNER_TOKEN, home: ${JSON.stringify(home)} }); process.disconnect(); });\n`);
  const launched = await startDetachedDeploy('key', [], { home, cliEntry: fixture });
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
