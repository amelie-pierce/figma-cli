import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectMakeDesktop } from '../src/lib/connect-make.js';

function fixture(overrides = {}) {
  const calls = [];
  const options = {
    port: 9333,
    locate: () => ({ app: 'test-app', binary: 'test-binary', asar: 'test-asar' }),
    probe: async () => ({ reachable: false }),
    patched: () => false,
    patch: () => { calls.push('patch'); },
    stop: () => { calls.push('stop'); },
    launch: async (binary, port) => { calls.push(['launch', binary, port]); },
    wait: async ({ port }) => { calls.push(['wait', port]); return { reachable: true, figmaTarget: true, makeTargets: 1 }; },
    ...overrides,
  };
  return { options, calls };
}

test('Make setup reuses reachable Figma without patching or restarting', async () => {
  const { options, calls } = fixture({ probe: async () => ({ reachable: true, figmaTarget: true }) });
  const result = await connectMakeDesktop(options);
  assert.equal(result.ready, true);
  assert.equal(result.reused, true);
  assert.deepEqual(calls, []);
});

test('Make setup never stops a responding non-Figma service or missing installation', async () => {
  for (const overrides of [
    { probe: async () => ({ reachable: true, figmaTarget: false }) },
    { locate: () => null },
  ]) {
    const { options, calls } = fixture(overrides);
    assert.equal((await connectMakeDesktop(options)).ready, false);
    assert.deepEqual(calls, []);
  }
});

test('macOS permission failures stop before restart, while Windows receives appropriate guidance', async () => {
  for (const platform of ['darwin', 'win32']) {
    const { options, calls } = fixture({ platform, patch: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } });
    const result = await connectMakeDesktop(options);
    assert.equal(result.code, 'PATCH_PERMISSION_DENIED');
    assert.equal(result.recovery.includes('App Management'), platform === 'darwin');
    assert.equal(result.ready, false);
    assert.deepEqual(calls, []);
  }
});

test('Make setup awaits restart and verifies the requested port without a Design daemon', async () => {
  for (const platform of ['darwin', 'win32']) {
    for (const port of [9233, 9333]) {
      const { options, calls } = fixture({ platform, port });
      const probes = [];
      options.probe = async args => { probes.push(args.port); return { reachable: false }; };
      assert.equal((await connectMakeDesktop(options)).ready, true);
      assert.deepEqual(probes, [port]);
      assert.deepEqual(calls, ['patch', 'stop', ['launch', 'test-binary', port], ['wait', port]]);
    }
  }
});

test('stop failures abort launch, and endpoint failures are not reported as success', async () => {
  const stopped = fixture({ stop: () => { throw new Error('permission denied'); } });
  assert.equal((await connectMakeDesktop(stopped.options)).code, 'FIGMA_RESTART_FAILED');
  assert.deepEqual(stopped.calls, ['patch']);
  const launched = fixture({ wait: async () => ({ reachable: false, status: 'endpoint-unavailable' }) });
  const result = await connectMakeDesktop(launched.options);
  assert.equal(result.ready, false);
  assert.equal(result.status, 'endpoint-unavailable');
});
