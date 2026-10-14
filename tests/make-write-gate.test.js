import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { program } from '../src/lib/cli-core.js';
import { MakeClient } from '../src/make-client.js';
import '../src/commands/make.js';

const hash = '0'.repeat(64);
// Commander keeps parsed option values on the command; restore the defaults per run.
const commands = program.commands.find(command => command.name() === 'make').commands;
const defaults = new Map(commands.map(command => [command, { ...command.opts() }]));
const resetOptions = () => {
  for (const [command, values] of defaults) {
    for (const key of Object.keys(command.opts())) command.setOptionValue(key, values[key]);
  }
};

// Drives the real make commands with MakeClient's connection and Make
// operations replaced, so no Figma is reached and every write attempt is seen.
async function run(t, args, markerBytes) {
  const home = mkdtempSync(join(tmpdir(), 'figma-cli-make-gate-'));
  const source = join(home, 'source.txt');
  writeFileSync(source, 'export const x = 1;\n');
  const saved = { home: process.env.HOME, exitCode: process.exitCode, error: console.error, log: console.log };
  const proto = MakeClient.prototype;
  const original = Object.fromEntries(['connect', 'close', 'projectMarker', 'replace', 'importFiles', 'remove'].map(name => [name, proto[name]]));
  const writes = [];
  const stderr = [];
  process.env.HOME = home;
  console.error = line => stderr.push(String(line));
  console.log = () => {};
  proto.connect = async function () { this.fileKey = 'ExactKey'; };
  proto.close = () => {};
  proto.projectMarker = async () => markerBytes;
  for (const name of ['replace', 'importFiles', 'remove']) proto[name] = async () => { writes.push(name); return {}; };
  try {
    resetOptions();
    await program.parseAsync(['node', 'figma-cli', 'make', ...args.map(arg => arg === '<source>' ? source : arg),
      '--file', 'ExactKey', '--session-only'], { from: 'node' });
    return { exitCode: process.exitCode, writes, stderr };
  } finally {
    Object.assign(proto, original);
    console.error = saved.error;
    console.log = saved.log;
    process.exitCode = saved.exitCode;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    rmSync(home, { recursive: true, force: true });
    t.diagnostic(stderr.join('\n'));
  }
}

const writes = {
  replace: ['replace', 'src/App.tsx', '--from', '<source>', '--expected-sha256', hash],
  create: ['create', 'src/New.tsx', '--from', '<source>'],
  remove: ['remove', 'src/App.tsx', '--expected-sha256', hash],
};
const teamMarker = Buffer.from(JSON.stringify({ fileKey: 'ExactKey', repo: 'owner/proto' }));
const code = stderr => JSON.parse(stderr.at(-1)).code;

test('session-only writes refuse in team mode before any write', async t => {
  for (const [name, args] of Object.entries(writes)) {
    const result = await run(t, [...args, '--solo'], teamMarker);
    assert.equal(result.exitCode, 1, name);
    assert.equal(code(result.stderr), 'MAKE_TEAM_MODE', name);
    assert.deepEqual(result.writes, [], name);
  }
});

test('session-only writes refuse in ambiguous mode without --solo, and write with it', async t => {
  for (const [name, args] of Object.entries(writes)) {
    const refused = await run(t, [...args, '--repo', 'owner/proto'], null);
    assert.equal(code(refused.stderr), 'MAKE_MODE_AMBIGUOUS', name);
    assert.deepEqual(refused.writes, [], name);
    const forced = await run(t, [...args, '--repo', 'owner/proto', '--solo'], null);
    assert.equal(forced.writes.length, 1, name);
    assert.ok(forced.stderr.some(line => line.startsWith('warning: ') && /ambiguous/.test(line)), name);
  }
});

test('a solo session-only write proceeds with a note about team-mode detection', async t => {
  const result = await run(t, writes.create, null);
  assert.deepEqual(result.writes, ['importFiles']);
  assert.ok(result.stderr.some(line => /^note: team mode is detected only through/.test(line)));
});
