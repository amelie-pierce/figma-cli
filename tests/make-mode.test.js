import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { program } from '../src/lib/cli-core.js';
import { MakeClient } from '../src/make-client.js';
import { markerContent, planModeChange, receiptDir, requireModeTogglePaths, runModeChange } from '../src/make-mode.js';
import { linkedRepo, PROJECT_MARKER, recordLinkedRepo, refuseMarkerPaths } from '../src/make-project.js';
import '../src/commands/make.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const saved = 'a'.repeat(40);
const head = 'b'.repeat(40);
const next = 'c'.repeat(40);
const repo = 'owner/proto';
const marker = Buffer.from(markerContent('ExactKey', repo));
const blob = n => String(n).repeat(40);
const flat = paths => new Map(Object.entries(paths).map(([path, b]) => [path, { mode: '100644', blob: b }]));
const base = flat({ 'src/App.tsx': blob(1), 'package.json': blob(2) });
const withMarker = new Map([...base, [PROJECT_MARKER, { mode: '100644', blob: blob(3) }]]);
const clean = (sha = saved) => ({ mode: 'git', hasBaseline: true, savedVersion: sha, pendingCount: 0, pendingPaths: [], isLoading: false, error: false });
const blank = () => ({ mode: 'git', hasBaseline: false, savedVersion: null, pendingCount: 0, pendingPaths: [], isLoading: false, error: false });
const status = ({ persistence = clean(), makeFlat = base, workingFlat = makeFlat, markerBytes = null, treeSource = 'saved-version',
  makeTree = 'd'.repeat(40), workingTree = makeTree } = {}) =>
  ({ persistence, head, treeSource, makeFlat, workingFlat, markerBytes, makeTree, workingTree });

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'figma-cli-make-mode-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A Make client fake: a queue of project statuses and client VFS markers, with
// every write, delete, save and reload recorded.
function fakeClient({ statuses, vfs, version = { versionId: 'v-id', versionNumber: 8, gitSha: next, previousGitSha: saved, tree: 'e'.repeat(40) } }) {
  const calls = [];
  const statusQueue = [...statuses];
  const vfsQueue = [...vfs];
  const client = {
    fileKey: 'ExactKey',
    projectStatus: async () => { calls.push(['status']); return statusQueue.length > 1 ? statusQueue.shift() : statusQueue[0]; },
    projectMarker: async () => (vfsQueue.length > 1 ? vfsQueue.shift() : vfsQueue[0]),
    writeDurable: async (path, content, options) => { calls.push(['write', path, content, options]); return { backupPath: null }; },
    deleteDurable: async (path, options) => { calls.push(['delete', path, options]); return { backupPath: '/backup/original.txt' }; },
    saveCheckedVersion: async (title, paths, options) => { calls.push(['save', title, paths, options]); return { ...version, ...(options.firstVersion ? { previousGitSha: null } : {}) }; },
    reloadPage: async () => { calls.push(['reload']); return { reloaded: true }; },
  };
  return { client, calls };
}

// gh with a fixed permission on the repo and a fixed login.
const gh = (permission = 'admin', { fail = false } = {}) => async args => {
  if (fail) throw new Error('gh api repos failed: HTTP 404');
  if (args[0] === 'user') return { login: 'octo' };
  assert.equal(args[0], `repos/${repo}`);
  return { permissions: { admin: permission === 'admin', push: ['admin', 'write'].includes(permission), pull: true } };
};
const writes = calls => calls.filter(([kind]) => ['write', 'delete', 'save', 'reload'].includes(kind));

test('team mode writes only the marker, saves it as its own version, verifies after reload and records a receipt', async t => {
  const home = temp(t);
  const after = status({ persistence: clean(next), makeFlat: withMarker, markerBytes: marker, makeTree: 'e'.repeat(40) });
  const { client, calls } = fakeClient({ statuses: [status(), after], vfs: [null, marker] });
  const result = await runModeChange(client, { action: 'team', repo }, { gh: gh('write'), home, warn: () => assert.fail('no warning'),
    now: () => new Date('2026-10-14T08:00:00.000Z') });
  assert.deepEqual(writes(calls).map(call => call.slice(0, 3)), [
    ['write', PROJECT_MARKER, marker.toString('utf8')],
    ['save', `figma-cli: team mode on (${repo})`, [PROJECT_MARKER]],
    ['reload'],
  ]);
  assert.deepEqual(JSON.parse(marker), { fileKey: 'ExactKey', repo, trunk: 'main' });
  assert.equal(result.verification, 'reloaded; clean-baseline; saved-tree-and-marker-matched');
  assert.equal(linkedRepo('ExactKey', { home }), repo);
  const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
  // Windows access control uses ACLs; POSIX permission bits are not equivalent.
  if (process.platform !== 'win32') assert.equal(statSync(result.receiptPath).mode & 0o777, 0o600);
  assert.equal(result.receiptPath.startsWith(receiptDir(home)), true);
  assert.deepEqual({ who: receipt.who, action: receipt.action, fileKey: receipt.fileKey, repo: receipt.repo, version: receipt.version,
    tree: receipt.tree, markerSha256: receipt.markerSha256, verification: receipt.verification }, {
    who: 'octo', action: 'team', fileKey: 'ExactKey', repo, version: { id: 'v-id', number: 8, gitSha: next, previousGitSha: saved },
    tree: 'e'.repeat(40), markerSha256: sha256(marker), verification: result.verification });
});

test('team mode on a never-saved file saves the marker as the first version since the sandbox head', async t => {
  const home = temp(t);
  const before = status({ persistence: blank(), treeSource: 'sandbox-head' });
  const after = status({ persistence: clean(next), makeFlat: withMarker, markerBytes: marker, makeTree: 'e'.repeat(40) });
  const { client, calls } = fakeClient({ statuses: [before, after], vfs: [null, marker] });
  const result = await runModeChange(client, { action: 'team', repo, firstVersion: true }, { gh: gh(), home });
  const [write, save] = writes(calls);
  assert.deepEqual(write[3], { firstVersion: true });
  assert.deepEqual(save[3], { firstVersion: true, since: head });
  assert.deepEqual({ first: result.firstVersion, since: result.since, previous: result.previousGitSha }, { first: true, since: head, previous: null });
  // Without --first-version a never-saved file is refused before any write.
  const refused = fakeClient({ statuses: [before], vfs: [null] });
  await assert.rejects(runModeChange(refused.client, { action: 'team', repo }, { gh: gh(), home }), /pass --first-version/);
  assert.deepEqual(writes(refused.calls), []);
});

test('a never-saved file with a marker pending from outside make mode needs --since, and saves from it', async t => {
  const home = temp(t);
  const pending = () => status({ persistence: blank(), treeSource: 'sandbox-head', markerBytes: marker });
  const refused = fakeClient({ statuses: [pending()], vfs: [marker] });
  const error = await runModeChange(refused.client, { action: 'team', repo, firstVersion: true }, { gh: gh(), home }).catch(cause => cause);
  assert.equal(error.code, 'MAKE_MODE_SINCE_REQUIRED');
  assert.match(error.message, /not written by make mode.*--since <sha>.*make status reported before the marker was written/);
  assert.deepEqual(writes(refused.calls), []);
  const after = status({ persistence: clean(next), makeFlat: withMarker, markerBytes: marker, makeTree: 'e'.repeat(40) });
  const { client, calls } = fakeClient({ statuses: [pending(), after], vfs: [marker] });
  const result = await runModeChange(client, { action: 'team', repo, firstVersion: true, since: saved }, { gh: gh(), home });
  assert.equal(result.change, 'save-existing');
  assert.deepEqual(writes(calls).map(call => [call[0], call[3]]), [['save', { firstVersion: true, since: saved }], ['reload', undefined]]);
});

test('team mode saves a marker that is already written but unsaved, without rewriting it', async t => {
  const home = temp(t);
  const before = status({ makeFlat: base, workingFlat: withMarker, markerBytes: marker });
  const after = status({ persistence: clean(next), makeFlat: withMarker, markerBytes: marker, makeTree: 'e'.repeat(40) });
  const { client, calls } = fakeClient({ statuses: [before, after], vfs: [marker] });
  const result = await runModeChange(client, { action: 'team', repo }, { gh: gh(), home });
  assert.equal(result.change, 'save-existing');
  assert.deepEqual(writes(calls).map(([kind]) => kind), ['save', 'reload']);
});

test('team mode refusals change nothing', async t => {
  const home = temp(t);
  const other = Buffer.from(markerContent('OtherKey', repo));
  const cases = [
    ['other pending files', status({ persistence: { ...clean(), pendingCount: 1, pendingPaths: ['src/App.tsx'] } }), [null], /other pending changes/, 'MAKE_MODE_OTHER_PENDING'],
    ['other unsaved, unlisted files', status({ workingFlat: new Map([...base, ['.figma/x', { mode: '100644', blob: blob(4) }]]) }), [null], /other unsaved path/, 'MAKE_MODE_OTHER_PENDING'],
    ['a marker for another file', status({ makeFlat: withMarker, markerBytes: other }), [other], /names file OtherKey, not the open file ExactKey/, 'MAKE_MODE_MISMATCH'],
    ['the same saved marker', status({ makeFlat: withMarker, markerBytes: marker }), [marker], /already on/, 'MAKE_MODE_UNCHANGED'],
    ['a marker for another repo', status({ makeFlat: withMarker, markerBytes: Buffer.from(markerContent('ExactKey', 'owner/else')) }),
      [Buffer.from(markerContent('ExactKey', 'owner/else'))], /already names owner\/else/, 'MAKE_MODE_MISMATCH'],
    ['an unreadable marker', status({ makeFlat: withMarker, markerBytes: Buffer.from('{') }), [Buffer.from('{')], /not valid UTF-8 JSON/, 'MAKE_MARKER_INVALID'],
    ['VFS and sandbox disagreeing', status({ markerBytes: null }), [marker], /disagree/, undefined],
  ];
  for (const [name, before, vfs, message, code] of cases) {
    const { client, calls } = fakeClient({ statuses: [before], vfs });
    const error = await runModeChange(client, { action: 'team', repo }, { gh: gh(), home }).catch(cause => cause);
    assert.match(error.message, message, name);
    assert.equal(error.code, code, name);
    assert.deepEqual(writes(calls), [], name);
  }
  const { client, calls } = fakeClient({ statuses: [status()], vfs: [null] });
  await assert.rejects(runModeChange(client, { action: 'team', repo }, { gh: gh('read', { fail: true }), home }), /Cannot read owner\/proto/);
  assert.deepEqual(writes(calls), []);
  assert.equal(existsSync(receiptDir(home)), false);
});

test('solo mode is for repo admins only, warns and needs the confirmation flag', async t => {
  const home = temp(t);
  const before = () => status({ makeFlat: withMarker, markerBytes: marker });
  const warnings = [];
  const warn = line => warnings.push(line);
  const nonAdmin = fakeClient({ statuses: [before()], vfs: [marker] });
  const error = await runModeChange(nonAdmin.client, { action: 'solo', confirm: true }, { gh: gh('write'), home, warn }).catch(cause => cause);
  assert.equal(error.code, 'MAKE_MODE_NOT_ADMIN');
  assert.match(error.message, /Only an admin of owner\/proto .* your permission is write/);
  assert.deepEqual(writes(nonAdmin.calls), []);
  assert.match(warnings[0], /Turning team mode off for a file linked to owner\/proto/);

  const unconfirmed = fakeClient({ statuses: [before()], vfs: [marker] });
  await assert.rejects(runModeChange(unconfirmed.client, { action: 'solo' }, { gh: gh(), home, warn }),
    error => error.code === 'MAKE_MODE_CONFIRM_REQUIRED' && /--yes-turn-off-team-mode/.test(error.message));
  assert.deepEqual(writes(unconfirmed.calls), []);

  const ghDown = fakeClient({ statuses: [before()], vfs: [marker] });
  await assert.rejects(runModeChange(ghDown.client, { action: 'solo', confirm: true }, { gh: gh('admin', { fail: true }), home, warn }),
    error => error.code === 'MAKE_MODE_NOT_ADMIN');
  assert.deepEqual(writes(ghDown.calls), []);

  const dry = fakeClient({ statuses: [before()], vfs: [marker] });
  const plan = await runModeChange(dry.client, { action: 'solo', dryRun: true }, { gh: gh(), home, warn });
  assert.deepEqual({ dryRun: plan.dryRun, change: plan.change, permission: plan.permission }, { dryRun: true, change: 'delete', permission: 'admin' });
  assert.deepEqual(writes(dry.calls), []);
});

test('solo mode deletes only the marker, saves, verifies after reload, records a receipt and drops the local link', async t => {
  const home = temp(t);
  recordLinkedRepo('ExactKey', repo, { home });
  const before = status({ makeFlat: withMarker, markerBytes: marker });
  const after = status({ persistence: clean(next), makeFlat: base, makeTree: 'e'.repeat(40) });
  const { client, calls } = fakeClient({ statuses: [before, after], vfs: [marker, null] });
  const result = await runModeChange(client, { action: 'solo', confirm: true }, { gh: gh(), home, warn: () => {},
    now: () => new Date('2026-10-14T08:00:00.000Z') });
  assert.deepEqual(writes(calls).map(call => call.slice(0, 3)), [
    ['delete', PROJECT_MARKER, { expectedSha256: sha256(marker), firstVersion: false }],
    ['save', 'figma-cli: team mode off', [PROJECT_MARKER]],
    ['reload'],
  ]);
  assert.equal(result.localLinkRemoved, true);
  assert.equal(linkedRepo('ExactKey', { home }), null);
  const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
  assert.deepEqual({ action: receipt.action, who: receipt.who, removed: receipt.removedMarkerSha256, backup: receipt.backupPath },
    { action: 'solo', who: 'octo', removed: sha256(marker), backup: '/backup/original.txt' });
  // A removal left unsaved is saved only after the admin check on the recorded link.
  const removed = () => status({ makeFlat: withMarker, workingFlat: base });
  const unlinked = fakeClient({ statuses: [removed()], vfs: [null] });
  await assert.rejects(runModeChange(unlinked.client, { action: 'solo', confirm: true }, { gh: gh(), home }), error => error.code === 'MAKE_MODE_NOT_ADMIN');
  assert.deepEqual(writes(unlinked.calls), []);
  recordLinkedRepo('ExactKey', repo, { home });
  const notAdmin = fakeClient({ statuses: [removed()], vfs: [null] });
  await assert.rejects(runModeChange(notAdmin.client, { action: 'solo', confirm: true }, { gh: gh('write'), home, warn: () => {} }),
    error => error.code === 'MAKE_MODE_NOT_ADMIN');
  assert.deepEqual(writes(notAdmin.calls), []);
  const finish = fakeClient({ statuses: [removed(), after], vfs: [null] });
  const finished = await runModeChange(finish.client, { action: 'solo', confirm: true }, { gh: gh(), home, warn: () => {},
    now: () => new Date('2026-10-14T08:01:00.000Z') });
  assert.equal(finished.change, 'save-removal');
  assert.deepEqual(writes(finish.calls).map(([kind]) => kind), ['save', 'reload']);
  // Already solo: nothing to do.
  const noop = fakeClient({ statuses: [status()], vfs: [null] });
  await assert.rejects(runModeChange(noop.client, { action: 'solo', confirm: true }, { gh: gh(), home }), error => error.code === 'MAKE_MODE_UNCHANGED');
  assert.deepEqual(writes(noop.calls), []);
});

test('a failed reload check writes a failed receipt and keeps the version for recovery', async t => {
  const home = temp(t);
  const stale = status({ persistence: clean(next), makeFlat: base, markerBytes: null, makeTree: 'e'.repeat(40) });
  const { client } = fakeClient({ statuses: [status(), stale], vfs: [null, null] });
  const error = await runModeChange(client, { action: 'team', repo }, { gh: gh(), home }).catch(cause => cause);
  assert.match(error.message, /saved as version 8 .* did not verify after reload: saved tree lacks .*sandbox .* absent/);
  assert.equal(error.version.gitSha, next);
  assert.equal(JSON.parse(readFileSync(error.receiptPath, 'utf8')).verification, 'failed');
  assert.equal(linkedRepo('ExactKey', { home }), null);
});

test('a failed save after the write says how to finish it', async t => {
  const home = temp(t);
  const { client } = fakeClient({ statuses: [status({ persistence: blank(), treeSource: 'sandbox-head' })], vfs: [null] });
  client.saveCheckedVersion = async () => { throw new Error('Make state changed before the first version.'); };
  await assert.rejects(runModeChange(client, { action: 'team', repo, firstVersion: true }, { gh: gh(), home }),
    new RegExp(`written but unsaved; run make mode team again with --first-version --since ${head}`));
});

test('solo without a readable repo in the marker checks admin rights on the local link', async t => {
  const home = temp(t);
  const broken = Buffer.from('{');
  const before = () => status({ makeFlat: withMarker, markerBytes: broken });
  const warnings = [];
  const unlinked = fakeClient({ statuses: [before()], vfs: [broken] });
  const plan = await runModeChange(unlinked.client, { action: 'solo', dryRun: true }, { gh: () => assert.fail('no repo to read'), home, warn: line => warnings.push(line) });
  assert.equal(plan.repo, null);
  assert.match(warnings[0], /names no readable repo/);
  recordLinkedRepo('ExactKey', repo, { home });
  const notAdmin = fakeClient({ statuses: [before()], vfs: [broken] });
  await assert.rejects(runModeChange(notAdmin.client, { action: 'solo', confirm: true }, { gh: gh('write'), home, warn: () => {} }),
    error => error.code === 'MAKE_MODE_NOT_ADMIN' && /Only an admin of owner\/proto/.test(error.message));
  assert.deepEqual(writes(notAdmin.calls), []);
});

test('a solo removal whose save failed can be finished on a machine with no prior link', async t => {
  const home = temp(t);
  const { client, calls } = fakeClient({ statuses: [status({ makeFlat: withMarker, markerBytes: marker })], vfs: [marker] });
  client.saveCheckedVersion = async () => { throw new Error('Make state changed before the version.'); };
  const error = await runModeChange(client, { action: 'solo', confirm: true }, { gh: gh(), home, warn: () => {} }).catch(cause => cause);
  assert.match(error.message, /removed but unsaved; run make mode solo again with --yes-turn-off-team-mode to save it/);
  assert.deepEqual(writes(calls).map(([kind]) => kind), ['delete']);
  assert.equal(linkedRepo('ExactKey', { home }), repo);
  const after = status({ persistence: clean(next), makeFlat: base, makeTree: 'e'.repeat(40) });
  const finish = fakeClient({ statuses: [status({ makeFlat: withMarker, workingFlat: base }), after], vfs: [null] });
  const finished = await runModeChange(finish.client, { action: 'solo', confirm: true }, { gh: gh(), home, warn: () => {} });
  assert.deepEqual({ change: finished.change, repo: finished.repo, permission: finished.permission }, { change: 'save-removal', repo, permission: 'admin' });
  assert.equal(linkedRepo('ExactKey', { home }), null);
});

test('the gate exemption covers exactly the marker path', () => {
  assert.deepEqual(requireModeTogglePaths([PROJECT_MARKER]), [PROJECT_MARKER]);
  for (const paths of [['src/App.tsx'], [PROJECT_MARKER, 'src/App.tsx'], [], ['.figma-cli/other.json']]) {
    assert.throws(() => requireModeTogglePaths(paths), error => error.code === 'MAKE_MARKER_RESERVED', JSON.stringify(paths));
  }
  for (const path of [PROJECT_MARKER, `./${PROJECT_MARKER}`, '.FIGMA-CLI/Project.json']) {
    assert.throws(() => refuseMarkerPaths(['src/App.tsx', path]), error => error.code === 'MAKE_MARKER_RESERVED', path);
  }
  refuseMarkerPaths(['src/App.tsx', '.figma-cli/notes.md']);
  assert.throws(() => planModeChange({ action: 'team', fileKey: 'ExactKey', repo, status: status(), vfsMarker: null, since: head }), /--since applies only/);
});

// The real make commands with Make stubbed: plain write commands refuse the
// marker path in every mode, and ordinary paths still refuse in team mode.
const commands = program.commands.find(command => command.name() === 'make').commands;
const allCommands = commands.flatMap(command => [command, ...command.commands]);
const defaults = new Map(allCommands.map(command => [command, { ...command.opts() }]));
async function cli(t, args, markerBytes) {
  const home = temp(t);
  const source = join(home, 'source.txt');
  writeFileSync(source, '{}\n');
  writeFileSync(join(home, 'manifest.json'), JSON.stringify({ files: [{ path: PROJECT_MARKER, content: '{}' }] }));
  const kept = { home: process.env.HOME, exitCode: process.exitCode, error: console.error, log: console.log };
  const proto = MakeClient.prototype;
  const names = ['connect', 'close', 'projectMarker', 'projectStatus', 'writeDurable', 'deleteDurable', 'saveVersion', 'saveCheckedVersion',
    'replace', 'importFiles', 'remove', 'reloadPage'];
  const original = Object.fromEntries(names.map(name => [name, proto[name]]));
  const touched = [];
  const stderr = [];
  process.env.HOME = home;
  console.error = line => stderr.push(String(line));
  console.log = () => {};
  proto.connect = async function () { this.fileKey = 'ExactKey'; };
  proto.close = () => {};
  proto.projectMarker = async () => markerBytes;
  for (const name of names.slice(3)) proto[name] = async () => { touched.push(name); return {}; };
  try {
    for (const [command, values] of defaults) for (const key of Object.keys(command.opts())) command.setOptionValue(key, values[key]);
    await program.parseAsync(['node', 'figma-cli', 'make', ...args.map(arg => arg === '<source>' ? source : arg === '<manifest>' ? join(home, 'manifest.json') : arg),
      '--file', 'ExactKey'], { from: 'node' });
    return { exitCode: process.exitCode, touched, code: stderr.length ? JSON.parse(stderr.at(-1)).code : null };
  } finally {
    Object.assign(proto, original);
    console.error = kept.error;
    console.log = kept.log;
    process.exitCode = kept.exitCode;
    if (kept.home === undefined) delete process.env.HOME; else process.env.HOME = kept.home;
  }
}

test('every plain write command refuses the marker path, even in solo mode', async t => {
  const hash = '0'.repeat(64);
  const attempts = {
    write: ['write', PROJECT_MARKER, '--from', '<source>'],
    delete: ['delete', PROJECT_MARKER, '--expected-sha256', hash],
    'save-version': ['save-version', '--title', 'T', '--expected-path', PROJECT_MARKER],
    replace: ['replace', PROJECT_MARKER, '--from', '<source>', '--expected-sha256', hash, '--session-only'],
    create: ['create', PROJECT_MARKER, '--from', '<source>', '--session-only'],
    remove: ['remove', PROJECT_MARKER, '--expected-sha256', hash, '--session-only'],
    import: ['import', '--manifest', '<manifest>', '--session-only'],
  };
  for (const [name, args] of Object.entries(attempts)) {
    const result = await cli(t, args, null);
    assert.equal(result.exitCode, 1, name);
    assert.equal(result.code, 'MAKE_MARKER_RESERVED', name);
    assert.deepEqual(result.touched, [], name);
  }
});

test('team mode still refuses every other write; only make mode reaches Make', async t => {
  const result = await cli(t, ['write', 'src/App.tsx', '--from', '<source>'], marker);
  assert.equal(result.code, 'MAKE_TEAM_MODE');
  assert.deepEqual(result.touched, []);
  const save = await cli(t, ['save-version', '--title', 'T', '--expected-path', 'src/App.tsx'], marker);
  assert.equal(save.code, 'MAKE_TEAM_MODE');
  assert.deepEqual(save.touched, []);
  // make mode passes the gate and reads Make (the stub status then fails it).
  const mode = await cli(t, ['mode', 'solo', '--yes-turn-off-team-mode', '--dry-run'], marker);
  assert.notEqual(mode.code, 'MAKE_TEAM_MODE');
  assert.deepEqual(mode.touched, ['projectStatus']);
});
