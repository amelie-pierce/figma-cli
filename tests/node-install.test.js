import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFromNode, findNpmCli } from '../src/lib/node-install.js';
import { getCdpSettings } from '../src/lib/cdp-config.js';

function fixture(t, { failure = false, locked = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'figma Node install with spaces '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'profile');
  mkdirSync(home);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@amelie-pierce/figma-cli' }));
  if (locked) writeFileSync(join(root, 'package-lock.json'), '{}');
  for (const name of ['figma-cli', 'figma-make']) {
    mkdirSync(join(root, 'skills', name, 'references'), { recursive: true });
    writeFileSync(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill\n---\n`);
    writeFileSync(join(root, 'skills', name, 'references/guide.md'), 'guide');
  }
  const npmCli = join(root, 'npm-cli.js');
  writeFileSync(npmCli, `const fs = require('node:fs');
    fs.writeFileSync('invocation.json', JSON.stringify({args:process.argv.slice(2), cwd:process.cwd()}));
    process.exitCode = ${failure ? 9 : 0};`);
  return { root, home, npmCli, env: { ...process.env, PATH: '', HOME: home, USERPROFILE: home } };
}

test('Node installation uses direct JS with no PATH or shell and installs complete Copilot skills only', t => {
  const options = fixture(t);
  const result = installFromNode({ ...options, agent: 'copilot' });
  assert.equal(result.ready, true);
  assert.equal(result.results.length, 2);
  assert.ok(result.verified.every(x => x.agent === 'copilot' && x.status === 'up-to-date'));
  for (const name of ['figma-cli', 'figma-make']) {
    assert.equal(readFileSync(join(options.home, '.copilot/skills', name, 'references/guide.md'), 'utf8'), 'guide');
  }
  assert.equal(existsSync(join(options.home, '.claude')), false);
  assert.equal(existsSync(join(options.home, '.agents')), false);
  const runtime = JSON.parse(readFileSync(result.runtimeFile, 'utf8'));
  assert.equal(runtime.nodeExecutable, process.execPath);
  assert.equal(runtime.cliEntry, join(options.root, 'src/index.js'));
  assert.deepEqual(JSON.parse(readFileSync(join(options.root, 'invocation.json'))).args,
    ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--no-bin-links']);
});

test('archive without a lockfile uses install, and custom Copilot skills are preserved and reported', t => {
  const options = fixture(t, { locked: false });
  const dir = join(options.home, '.copilot/skills/figma-make');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), 'my custom skill');
  const result = installFromNode({ ...options, agent: 'copilot' });
  assert.equal(result.ready, false);
  assert.equal(result.results.find(x => x.name === 'figma-make').status, 'conflict');
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), 'my custom skill');
  assert.equal(JSON.parse(readFileSync(join(options.root, 'invocation.json'))).args[0], 'install');
});

test('dependency failure and invalid options do not register skills', t => {
  const options = fixture(t, { failure: true });
  assert.throws(() => installFromNode({ ...options, agent: 'copilot' }), /installation failed/);
  assert.equal(existsSync(join(options.home, '.copilot')), false);
  assert.equal(existsSync(join(options.home, '.figma-cli/node-runtime.json')), false);
  assert.throws(() => installFromNode({ ...options, agent: 'invalid' }), /Agent must/);
  assert.throws(() => findNpmCli({ npmCli: join(options.root, 'missing.js') }), /entry point/);
  const shim = join(options.root, 'npm.cmd'); writeFileSync(shim, '');
  assert.throws(() => findNpmCli({ npmCli: shim }), /not a shell launcher/);
});

test('an unrelated runtime record is preserved before any installation', t => {
  const options = fixture(t);
  mkdirSync(join(options.home, '.figma-cli'));
  const path = join(options.home, '.figma-cli/node-runtime.json');
  writeFileSync(path, JSON.stringify({ owner: 'custom setup' }));
  assert.throws(() => installFromNode({ ...options, agent: 'copilot' }), /not managed/);
  assert.equal(existsSync(join(options.root, 'invocation.json')), false);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).owner, 'custom setup');
});

test('npm discovery supports standard Node directory layouts without running npm', t => {
  const { root } = fixture(t);
  for (const relative of ['node_modules/npm/bin/npm-cli.js', '../lib/node_modules/npm/bin/npm-cli.js', '../share/nodejs/npm/bin/npm-cli.js']) {
    const bin = join(root, String(relative.length), 'bin'); mkdirSync(bin, { recursive: true });
    const execPath = join(bin, 'node'); writeFileSync(execPath, '');
    const npm = join(bin, relative); mkdirSync(join(npm, '..'), { recursive: true }); writeFileSync(npm, '');
    assert.equal(realpathSync(findNpmCli({ execPath, env: {} })), realpathSync(npm));
  }
});

test('installer persists an explicit port, reports overrides, and preserves settings on reinstall', t => {
  const options = fixture(t);
  const result = installFromNode({ ...options, port: '9333', env: { ...options.env, FIGMA_PORT: '9444' } });
  assert.equal(result.connection.savedPort, 9333);
  assert.equal(result.connection.port, 9444);
  assert.equal(result.connection.source, 'FIGMA_PORT');
  assert.equal(result.connection.verified, false);
  const env = { ...options.env }; delete env.FIGMA_PORT;
  const reinstalled = installFromNode({ ...options, env });
  assert.equal(reinstalled.connection.port, 9333);
  assert.equal(reinstalled.connection.source, 'saved');
  assert.equal(getCdpSettings({ home: options.home, env: {} }).port, 9333);
});

test('installer rejects an invalid port before installing dependencies', t => {
  const options = fixture(t);
  assert.throws(() => installFromNode({ ...options, port: '9333junk' }), /integer/);
  assert.equal(existsSync(join(options.root, 'invocation.json')), false);
});
