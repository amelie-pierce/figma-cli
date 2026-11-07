// Explicit opt-in. Writes only benchmark text in the dedicated scratch Make;
// never run this as part of the fake-client suite or against a prototype.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MakeClient } from '../../src/make-client.js';
import { MakeTransport } from '../../src/make-transport.js';

if (!process.argv.includes('--scratch-confirmed')) throw new Error('Confirm scratch-only isolation before running this live test.');
const fileKey = 'Iv9p3539krJZZ4MZsDjjfg';
const paths = Array.from({ length: 7 }, (_, i) => `src/benchmark/${String(i + 4).padStart(2, '0')}.txt`);
const hash = text => createHash('sha256').update(text).digest('hex');
const log = value => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }));
const client = new MakeClient({ transport: new MakeTransport({ port: 9333 }), timeoutMs: 120000 });
const settle = client._settleMutation.bind(client);
client._settleMutation = async (tracker, deadline) => {
  const start = Date.now();
  const result = await settle(tracker, deadline);
  log({ trackerWaitMs: Date.now() - start, expected: tracker.expectedPaths });
  return result;
};
const expected = new Map();
const outsideBenchmark = status => [...status.workingSha256].filter(([path]) => !path.startsWith('src/benchmark/')).sort();

try {
  await client.connect(fileKey);
  assert.equal(await client.projectMarker(), null, 'scratch must remain solo');
  const baseline = await client.projectStatus();
  log({ baseline: baseline.persistence, nonBenchmarkFiles: outsideBenchmark(baseline).length });
  if (baseline.persistence.pendingPaths.length) {
    throw new Error(`Scratch file has pending changes ${JSON.stringify(baseline.persistence.pendingPaths)}; refusing to start.`);
  }
  for (const phase of ['save-after-each', 'serial-without-saves']) {
    for (const path of paths) {
      const original = await client.readDurable(path);
      const content = `${original.content ?? ''}\ntracker regression ${phase} ${new Date().toISOString()}\n`;
      expected.set(path, content);
      const start = Date.now();
      const write = await client.writeDurableConfirmed(path, content, {
        ...(original.exists ? { expectedSha256: hash(original.content) } : {}),
        backupDir: `${process.cwd()}/.tracker-backups`,
      });
      log({ phase, write, elapsedMs: Date.now() - start });
      if (phase === 'save-after-each') log({ phase, save: await client.saveVersion(`Tracker regression ${path}`, [path]) });
    }
  }
  const serial = await client.projectStatus();
  assert.deepEqual(serial.persistence.pendingPaths, paths);
  assert.deepEqual(outsideBenchmark(serial), outsideBenchmark(baseline));
  log({ serialInventory: serial.persistence });
  log({ finalSave: await client.saveVersion('Tracker regression serial batch', paths) });
  await client.reloadPage();
  await client.probeFilesystemReady();
  const after = await client.projectStatus();
  assert.deepEqual(after.persistence.pendingPaths, []);
  assert.deepEqual(outsideBenchmark(after), outsideBenchmark(baseline));
  const files = await client.readRemoteFiles(paths);
  for (const [path, content] of expected) assert.equal(files.get(path).sha256, hash(content));
  log({ outcome: 'passed', freshReload: true, writes: 14, individualSaves: 7, serialSave: 1,
    final: after.persistence, nonBenchmarkFilesUnchanged: outsideBenchmark(after).length });
} catch (error) {
  log({ outcome: 'failed', message: error.message, code: error.code, version: error.version });
  process.exitCode = 1;
} finally { client.close(); }
