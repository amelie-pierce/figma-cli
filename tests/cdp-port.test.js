import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCdpSettings, saveCdpPort, parseCdpPort, connectionConfigPath } from '../src/lib/cdp-config.js';

function profile(t) {
  const home = mkdtempSync(join(tmpdir(), 'figma-cdp-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('port precedence is explicit option, environment, saved config, default', t => {
  const home = profile(t);
  assert.deepEqual([getCdpSettings({ home, env: {} }).port, getCdpSettings({ home, env: {} }).source], [9222, 'default']);
  saveCdpPort('9333', { home });
  assert.equal(getCdpSettings({ home, env: {} }).port, 9333);
  assert.equal(getCdpSettings({ home, env: {} }).source, 'saved');
  assert.equal(getCdpSettings({ home, env: { FIGMA_PORT: '9444' } }).port, 9444);
  assert.equal(getCdpSettings({ home, env: { FIGMA_PORT: '9444' }, port: '9555' }).port, 9555);
  assert.equal(getCdpSettings({ home, env: {} }).port, 9333, 'temporary overrides do not change saved state');
});

test('invalid ports fail closed instead of silently selecting another service', t => {
  const home = profile(t);
  for (const value of ['abc', '9333junk', '0', '-1', '65536', '1.5', '', ' 9333 ', undefined, null]) {
    assert.throws(() => parseCdpPort(value), /integer/);
  }
  assert.throws(() => getCdpSettings({ home, env: { FIGMA_PORT: 'bad' } }), /integer/);
  assert.equal(parseCdpPort('65535'), 65535);
});

test('saving preserves unknown fields and refuses corrupt or foreign records', t => {
  const home = profile(t);
  const path = connectionConfigPath(home);
  mkdirSync(join(home, '.figma-cli'));
  for (const content of ['bad json', '{"owner":"another-tool"}']) {
    writeFileSync(path, content);
    assert.throws(() => saveCdpPort(9333, { home }), /Cannot read/);
    assert.equal(readFileSync(path, 'utf8'), content);
  }
  writeFileSync(path, JSON.stringify({ owner: 'amelie-pierce/figma-cli', schemaVersion: 1, port: 9222, custom: true }));
  saveCdpPort(9333, { home });
  assert.equal(JSON.parse(readFileSync(path)).custom, true);
});
