import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../src/lib/map-limit.js';

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

test('mapLimit keeps input order whatever the completion order', async () => {
  const out = await mapLimit([30, 1, 20, 2, 10], 3, async (ms, index) => { await tick(ms); return `${index}:${ms}`; });
  assert.deepEqual(out, ['0:30', '1:1', '2:20', '3:2', '4:10']);
  assert.deepEqual(await mapLimit([], 8, async () => 1), []);
});

test('mapLimit never runs more than the limit at once, and does overlap', async () => {
  let active = 0, peak = 0;
  await mapLimit(Array.from({ length: 20 }, (_, i) => i), 8, async () => {
    peak = Math.max(peak, ++active); await tick(5); active--;
  });
  assert.equal(peak, 8);
});

test('mapLimit throws the error a sequential loop would, schedules nothing new, and lets running calls settle', async () => {
  const started = [], finished = [];
  await assert.rejects(mapLimit([0, 1, 2, 3, 4, 5, 6, 7], 2, async item => {
    started.push(item);
    if (item === 1) { await tick(1); throw new Error('index 1, first in time'); }
    await tick(item === 0 ? 20 : 5);
    if (item === 0) throw new Error('index 0, later in time');
    finished.push(item);
  }), /index 0/);
  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(finished, []);
  await assert.rejects(mapLimit([0, 1, 2, 3], 2, async item => {
    await tick(item === 0 ? 20 : 1);
    if (item === 2) throw new Error('only failure');
    return item;
  }), /only failure/);
});
