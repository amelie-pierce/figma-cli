import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeCdp, waitForCdp, patchFailure } from '../src/lib/cdp-diagnostics.js';
import { MakeTransport } from '../src/make-transport.js';

async function endpoint(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { server, port: server.address().port };
}
const makePage = { id: 'MakeKey', type: 'page', url: 'https://www.figma.com/make/MakeKey/Title' };

test('closed endpoint reports exact port and actionable causes without asserting permissions', async t => {
  const { server, port } = await endpoint(t, () => {});
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(MakeTransport.listTargets({ port }), error => {
    assert.equal(error.endpoint, `http://127.0.0.1:${port}/json`);
    assert.equal(error.port, port);
    assert.equal(error.reason, 'ECONNREFUSED');
    assert.match(error.recovery.join(' '), /cannot distinguish/);
    return true;
  });
  const status = await waitForCdp({ port, timeoutMs: 100, intervalMs: 10 });
  assert.equal(status.status, 'endpoint-unavailable');
});

test('recognizes Make-only sessions without claiming editor or Desktop identity verification', async t => {
  const { port } = await endpoint(t, (req, res) => res.end(JSON.stringify([makePage])));
  const result = await waitForCdp({ port, timeoutMs: 300 });
  assert.equal(result.reachable, true);
  assert.equal(result.makeTargets, 1);
  assert.equal(result.designTargets, 0);
  assert.match(result.note, /does not prove editor readiness/);
});

test('wrong service, malformed response, HTTP failure, timeout and redirects stay bounded', async t => {
  const cases = [
    (req, res) => res.end(JSON.stringify([{ type: 'page', url: 'https://www.figma.com.evil.test/make/X' }])),
    (req, res) => res.end('{}'),
    (req, res) => { res.statusCode = 403; res.end(); },
    (req, res) => { res.statusCode = 302; res.setHeader('Location', 'https://example.com'); res.end(); },
    () => {},
  ];
  for (const [i, handler] of cases.entries()) {
    const { port } = await endpoint(t, handler);
    const result = await probeCdp({ port, timeoutMs: 80 });
    assert.equal(result.reachable, i === 0);
    assert.equal(result.status, i === 0 ? 'no-figma-target' : 'endpoint-unavailable');
    assert.equal(result.endpoint, `http://127.0.0.1:${port}/json`);
  }
});

test('post-launch verifier retries an unavailable endpoint within a bounded window', async t => {
  let requests = 0;
  const { port } = await endpoint(t, (req, res) => {
    requests++;
    res.end(requests === 1 ? 'not ready' : JSON.stringify([makePage]));
  });
  const result = await waitForCdp({ port, intervalMs: 5, timeoutMs: 500 });
  assert.equal(result.figmaTarget, true);
  assert.equal(requests, 2);
});

test('only actual patch permission errors suggest App Management', () => {
  const denied = patchFailure(Object.assign(new Error('denied'), { code: 'EPERM' }), 'darwin');
  assert.equal(denied.code, 'PATCH_PERMISSION_DENIED');
  assert.match(denied.recovery, /App Management/);
  const incompatible = patchFailure(new Error('Could not find the string to patch'), 'darwin');
  assert.equal(incompatible.code, 'PATCH_FAILED');
  assert.match(incompatible.recovery, /do not assume/);
});

async function cli(t, args, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'figma-cdp-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, FIGMA_CLI_NO_UPDATE_CHECK: '1', FIGMA_CLI_SKIP_SKILLS: '1', ...extraEnv };
  if (!Object.hasOwn(extraEnv, 'FIGMA_PORT')) delete env.FIGMA_PORT;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url)), ...args], { env, shell: false });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill(), 10000);
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  return { code, stdout, stderr };
}

test('global --port works before and after make list and on related Make commands', async t => {
  const { port } = await endpoint(t, (req, res) => res.end('[]'));
  for (const args of [['--port', String(port), 'make', 'list'], ['make', 'list', '--port', String(port)]]) {
    const result = await cli(t, args, { FIGMA_PORT: '1' });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), []);
  }
  const inspect = await cli(t, ['make', 'inspect', '--port', String(port), '--file', 'Missing']);
  assert.equal(inspect.code, 1);
  assert.match(inspect.stderr, /No open Figma Make page/);
  const diagnostic = await cli(t, ['connection', '--port', String(port)]);
  assert.equal(diagnostic.code, 1);
  assert.equal(JSON.parse(diagnostic.stdout).status, 'no-figma-target');
  assert.equal(JSON.parse(diagnostic.stdout).source, '--port');
});

test('make list JSON errors include endpoint and recovery', async t => {
  const { server, port } = await endpoint(t, () => {});
  await new Promise(resolve => server.close(resolve));
  const result = await cli(t, ['make', 'list', '--port', String(port)]);
  assert.equal(result.code, 1);
  const error = JSON.parse(result.stderr);
  assert.equal(error.port, port);
  assert.equal(error.code, 'CDP_DISCOVERY_FAILED');
  assert.ok(error.recovery.length);
});

test('a port saved by the CLI is reused by Make in a separate process', async t => {
  const home = mkdtempSync(join(tmpdir(), 'figma-saved-port-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, USERPROFILE: home };
  const { port } = await endpoint(t, (req, res) => res.end(JSON.stringify([
    { ...makePage, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/MakeKey` },
  ])));
  const saved = await cli(t, ['connection', '--save-port', String(port)], env);
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(JSON.parse(saved.stdout).effective.port, port);
  const listed = await cli(t, ['make', 'list'], env);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout)[0].fileKey, 'MakeKey');
  const diagnostic = await cli(t, ['connection'], env);
  assert.equal(diagnostic.code, 0, diagnostic.stderr);
  assert.equal(JSON.parse(diagnostic.stdout).source, 'saved');
});
