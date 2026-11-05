import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployDir, planDigest, RECEIPT_SCHEMA } from '../src/make-deploy.js';
import { deployStatus, formatDeployStatus } from '../src/make-deploy-status.js';

describe('make deploy status (receipt only)', () => {
  it('reports completed writes, timing and ETA from a fixture receipt', t => {
    const home = mkdtempSync(join(tmpdir(), 'deploy-status-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const dir = deployDir(home);
    mkdirSync(dir, { recursive: true });
    const plan = { files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/c.ts' }] };
    const receiptPath = join(dir, 'sample.json');
    writeFileSync(receiptPath, JSON.stringify({ schema: RECEIPT_SCHEMA, plan, planDigest: planDigest(plan), fileKey: 'key',
      at: '2026-10-15T01:00:00.000Z', lastWriteAt: '2026-10-15T01:01:00.000Z', stage: 'writing', outcome: 'uncertain',
      completedWrites: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/c.ts', backupOnly: true }, { path: 'src/a.ts', uncertain: true }] }));
    const status = deployStatus({ receiptPath, home, now: new Date('2026-10-15T01:02:00.000Z') });
    assert.equal(status.completedWrites, 2);
    assert.equal(status.totalWrites, 3);
    assert.equal(status.averageSecondsPerFile, 30);
    assert.equal(status.eta, '2026-10-15T01:02:30.000Z');
    assert.match(formatDeployStatus(status), /2\/3 writing \(uncertain\)/);
    assert.deepEqual(deployStatus({ fileKey: 'key', home, now: new Date('2026-10-15T01:02:00.000Z') }), status);
    const cli = spawnSync(process.execPath, ['src/index.js', 'make', 'deploy', 'status', '--receipt', receiptPath, '--json'],
      { encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).completedWrites, 2);
  });

  it('keeps old receipts without timing fields readable', t => {
    const home = mkdtempSync(join(tmpdir(), 'deploy-status-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const dir = deployDir(home);
    mkdirSync(dir, { recursive: true });
    const plan = { files: [{ path: 'src/a.ts' }] };
    const receiptPath = join(dir, 'old.json');
    writeFileSync(receiptPath, JSON.stringify({ schema: RECEIPT_SCHEMA, plan, planDigest: planDigest(plan), fileKey: 'old',
      at: '2026-10-15T01:00:00.000Z', stage: 'deployed', outcome: 'ok', completedWrites: [{ path: 'src/a.ts' }] }));
    const status = deployStatus({ receiptPath, home });
    assert.equal(status.lastWriteAt, null);
    assert.equal(status.averageSecondsPerFile, null);
    assert.equal(status.eta, null);
  });
});
