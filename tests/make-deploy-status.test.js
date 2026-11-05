import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployDir, planDigest, RECEIPT_SCHEMA } from '../src/make-deploy.js';
import { deployStatus, formatDeployStatus } from '../src/make-deploy-status.js';

const cliEntry = fileURLToPath(new URL('../src/index.js', import.meta.url));

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
    const status = deployStatus({ receiptPath, home });
    assert.equal(status.completedWrites, 2);
    assert.equal(status.totalWrites, 3);
    assert.equal(status.averageSecondsPerFile, 30);
    assert.equal(status.eta, '2026-10-15T01:01:30.000Z');
    assert.match(formatDeployStatus(status), /2\/3 writing \(uncertain\)/);
    assert.deepEqual(deployStatus({ fileKey: 'key', home }), status);
    const cli = spawnSync(process.execPath, [cliEntry, 'make', 'deploy', 'status', '--receipt', receiptPath, '--json'],
      { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).completedWrites, 2);
  });

  it('uses the current write segment and keeps the estimate fixed between writes', t => {
    const home = mkdtempSync(join(tmpdir(), 'deploy-status-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const dir = deployDir(home);
    mkdirSync(dir, { recursive: true });
    const plan = { files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/c.ts' }] };
    const receiptPath = join(dir, 'resumed.json');
    writeFileSync(receiptPath, JSON.stringify({ schema: RECEIPT_SCHEMA, plan, planDigest: planDigest(plan), fileKey: 'key',
      at: '2026-10-15T00:00:00.000Z', writeRun: { startedAt: '2026-10-15T01:00:00.000Z', completedWrites: 1 },
      lastWriteAt: '2026-10-15T01:01:00.000Z', stage: 'writing', outcome: 'uncertain',
      completedWrites: [{ path: 'src/a.ts', confirmedOnResume: true }, { path: 'src/b.ts' }] }));
    const first = deployStatus({ receiptPath, home });
    const later = deployStatus({ receiptPath, home });
    assert.equal(first.averageSecondsPerFile, 60);
    assert.equal(first.eta, '2026-10-15T01:02:00.000Z');
    assert.equal(later.eta, first.eta);
  });

  it('requires receipt selection and picks the newest receipt for an exact file key', t => {
    const home = mkdtempSync(join(tmpdir(), 'deploy-status-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const dir = deployDir(home);
    mkdirSync(dir, { recursive: true });
    const plan = { files: [{ path: 'src/a.ts' }] };
    for (const [name, key, at] of [['older', 'key', '2026-10-15T01:00:00.000Z'],
      ['selected', 'key', '2026-10-15T01:02:00.000Z'], ['other', 'other', '2026-10-15T01:03:00.000Z']]) {
      writeFileSync(join(dir, `${name}.json`), JSON.stringify({ schema: RECEIPT_SCHEMA, plan, planDigest: planDigest(plan),
        fileKey: key, at, stage: 'deployed', outcome: 'ok', completedWrites: [{ path: 'src/a.ts' }] }));
    }
    assert.throws(() => deployStatus({ home }), /requires --receipt/);
    assert.equal(deployStatus({ fileKey: 'key', home }).receiptPath, join(dir, 'selected.json'));
    const byFile = spawnSync(process.execPath, [cliEntry, 'make', 'deploy', 'status', '--file', 'key', '--json'],
      { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
    assert.equal(byFile.status, 0, byFile.stderr);
    assert.equal(JSON.parse(byFile.stdout).receiptPath, join(dir, 'selected.json'));
    const cli = spawnSync(process.execPath, [cliEntry, 'make', 'deploy', 'status'],
      { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /requires --receipt/);
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
