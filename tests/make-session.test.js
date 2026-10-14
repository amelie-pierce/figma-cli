import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { requireSessionOnly, sessionOnly } from '../src/make-session.js';

const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));
const hash = '0'.repeat(64);

// Port 1 is closed, so any attempt to reach Figma fails with CDP_DISCOVERY_FAILED.
function run(t, args) {
  const home = mkdtempSync(join(tmpdir(), 'make-session-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = join(home, 'source.txt');
  writeFileSync(source, 'export const x = 1;\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, FIGMA_CLI_NO_UPDATE_CHECK: '1' };
  const result = spawnSync(process.execPath, [cli, '--port', '1', 'make',
    ...args.map(arg => arg === '<source>' ? source : arg), '--file', 'ExactKey', '--timeout', '1000'], { env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, error: JSON.parse(result.stderr.trim().split('\n').at(-1)) };
}

const writes = {
  replace: ['replace', 'src/App.tsx', '--from', '<source>', '--expected-sha256', hash],
  create: ['create', 'src/New.tsx', '--from', '<source>'],
  import: ['import', '--manifest', '<source>'],
  remove: ['remove', 'src/App.tsx', '--expected-sha256', hash],
};

test('every Make write refuses without --session-only before connecting', t => {
  for (const [name, args] of Object.entries(writes)) {
    const { status, stdout, error } = run(t, args);
    assert.equal(status, 1, name);
    assert.equal(stdout, '');
    assert.equal(error.code, 'MAKE_SESSION_ONLY_REQUIRED', name);
    assert.match(error.error, new RegExp(`^make ${name} refused before any write: .*session-only.*--session-only`));
    assert.equal(error.port, undefined, 'no connection was attempted');
  }
});

test('--session-only passes the gate and reaches the connection guards', t => {
  for (const [name, args] of Object.entries(writes)) {
    const { status, error } = run(t, [...args, '--session-only']);
    assert.equal(status, 1, name);
    assert.equal(error.code, 'CDP_DISCOVERY_FAILED', name);
  }
});

test('session-only writes take the mode gate flags and reach the connection guards', t => {
  for (const [name, args] of Object.entries(writes)) {
    const { status, error } = run(t, [...args, '--session-only', '--solo', '--repo', 'owner/proto']);
    assert.equal(status, 1, name);
    assert.equal(error.code, 'CDP_DISCOVERY_FAILED', name);
  }
});

test('reads need no opt-in flag', t => {
  const { error } = run(t, ['read', 'src/App.tsx']);
  assert.equal(error.code, 'CDP_DISCOVERY_FAILED');
});

test('the session-only gate and label never claim the project was saved', () => {
  assert.throws(() => requireSessionOnly('import', {}), error => error.code === 'MAKE_SESSION_ONLY_REQUIRED');
  assert.throws(() => requireSessionOnly('import', { sessionOnly: 'yes' }), /--session-only/);
  assert.doesNotThrow(() => requireSessionOnly('import', { sessionOnly: true }));
  assert.equal(sessionOnly.persistence, 'session-only');
  assert.match(sessionOnly.note, /lost when the file is reopened unless it is saved in Make/);
  assert.equal(Object.isFrozen(sessionOnly), true);
});
