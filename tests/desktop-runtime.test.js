import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { locateDesktop, launchDesktop, stopDesktop, signDesktop, writeDesktopArchive } from '../src/lib/desktop-runtime.js';

const macFiles = app => [`${app}/Contents/MacOS/Figma`, `${app}/Contents/Resources/app.asar`];
const winFiles = app => [`${app}\\Figma.exe`, `${app}\\resources\\app.asar`];
function fixture(files, folders = []) {
  return { exists: file => files.includes(file), readdir: () => folders };
}

test('macOS discovers system and user Applications bundles and respects explicit custom locations', () => {
  const userApp = '/Users/test user/Applications/Figma.app';
  for (const app of ['/Applications/Figma.app', userApp]) {
    const result = locateDesktop({ platform: 'darwin', env: {}, home: '/Users/test user', ...fixture(macFiles(app)) });
    assert.equal(result.app, app);
    assert.equal(result.binary, macFiles(app)[0]);
    assert.equal(result.asar, macFiles(app)[1]);
  }
  const custom = '/Volumes/Managed Apps/Figma Beta.app';
  assert.equal(locateDesktop({ platform: 'darwin', env: { FIGMA_APP_PATH: custom }, ...fixture(macFiles(custom)) }).app, custom);
  assert.equal(locateDesktop({ platform: 'darwin', env: { FIGMA_APP_PATH: '/missing' }, ...fixture(macFiles('/Applications/Figma.app')) }), null);
});

test('Windows patches and launches the same complete newest numeric version', () => {
  const root = 'C:\\Users\\test user\\AppData\\Local\\Figma';
  const old = `${root}\\app-99.9.9`, latest = `${root}\\app-100.10.0`;
  const incomplete = `${root}\\app-101.0.0`;
  const result = locateDesktop({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\test user\\AppData\\Local' },
    ...fixture([...winFiles(old), ...winFiles(latest), `${incomplete}\\resources\\app.asar`, `${root}\\Figma.exe`],
      ['app-99.9.9', 'app-100.10.0', 'app-101.0.0', 'app-invalid']) });
  assert.equal(result.app, latest);
  assert.equal(result.binary, winFiles(latest)[0]);
  assert.equal(result.asar, winFiles(latest)[1]);
});

test('Windows supports a flat custom install and fails clearly without LOCALAPPDATA', () => {
  const root = 'D:\\Managed Apps\\Figma';
  assert.equal(locateDesktop({ platform: 'win32', env: { FIGMA_APP_PATH: root }, ...fixture(winFiles(root)) }).app, root);
  assert.equal(locateDesktop({ platform: 'win32', env: {}, ...fixture([]) }), null);
});

test('macOS launch and signing pass paths with spaces as literal arguments without a shell', async () => {
  const calls = [];
  const exec = (...args) => calls.push(args);
  const app = '/Users/test user/Applications/Figma.app';
  await launchDesktop(`${app}/Contents/MacOS/Figma`, 9333, { platform: 'darwin', exec });
  signDesktop(app, { exec });
  assert.deepEqual(calls[0].slice(0, 2), ['/usr/bin/open', ['-a', app, '--args', '--remote-debugging-port=9333']]);
  assert.deepEqual(calls[1].slice(0, 2), ['/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]]);
  assert.ok(calls.every(call => call[2].shell === false && call[2].timeout > 0));
});

test('Windows launches directly, waits for spawn, and propagates missing executables', async () => {
  const binary = 'C:\\Managed Apps\\Figma\\Figma.exe';
  let invocation, unreferenced = false;
  await launchDesktop(binary, 9333, { platform: 'win32', spawnProcess: (...args) => {
    invocation = args;
    const child = new EventEmitter();
    child.unref = () => { unreferenced = true; };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  } });
  assert.deepEqual(invocation.slice(0, 2), [binary, ['--remote-debugging-port=9333']]);
  assert.equal(invocation[2].shell, false);
  assert.equal(unreferenced, true);
  await assert.rejects(launchDesktop(binary, 9333, { platform: 'win32', spawnProcess: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('ENOENT')));
    return child;
  } }), /ENOENT/);
  await assert.rejects(launchDesktop(null, 9333), /installation not found/);
  await assert.rejects(launchDesktop(binary, '9333;invalid'), /integer/);
});

test('stopping uses direct OS utilities and does not swallow permission errors', () => {
  const calls = [];
  const exec = (...args) => calls.push(args);
  stopDesktop({ platform: 'win32', env: { SystemRoot: 'D:\\Windows' }, exec });
  stopDesktop({ platform: 'darwin', exec });
  assert.deepEqual(calls[0].slice(0, 2), ['D:\\Windows\\System32\\taskkill.exe', ['/IM', 'Figma.exe', '/F']]);
  assert.deepEqual(calls[1].slice(0, 2), ['/usr/bin/pkill', ['-x', 'Figma']]);
  assert.ok(calls.every(call => call[2].shell === false));
  for (const [platform, status] of [['darwin', 1], ['win32', 128]]) {
    assert.doesNotThrow(() => stopDesktop({ platform, exec: () => { throw { status }; } }));
    assert.throws(() => stopDesktop({ platform, exec: () => { throw new Error('EACCES'); } }), /EACCES/);
  }
});

test('failed macOS signing restores archive bytes and never claims a successful patch', () => {
  const writes = [];
  assert.throws(() => writeDesktopArchive({ asar: 'test.asar', app: 'test.app' }, 'original', 'patched', {
    platform: 'darwin', write: (...args) => writes.push(args), sign: () => { throw new Error('signing denied'); },
  }), /previous archive bytes were restored/);
  assert.deepEqual(writes, [['test.asar', 'patched'], ['test.asar', 'original']]);
  assert.doesNotThrow(() => writeDesktopArchive({ asar: 'test.asar' }, 'original', 'patched', {
    platform: 'win32', write: () => {}, sign: () => assert.fail('Windows must not invoke codesign'),
  }));
});
