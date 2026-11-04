import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { runStatusBudget, STATUS_DEFAULT_WALL_MS } from '../src/make-status-budget.js';

// A manual clock: Node 18's mock timers cannot fake Date, so stub Date.now.
function fakeClock(t) {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  return { tick(ms) { now += ms; } };
}

test('default status budget lets a connect longer than 30 s finish inside the wall budget', async (t) => {
  const clock = fakeClock(t);
  let connectBudget;
  const client = {
    timeoutMs: 1,
    async connect(file) {
      assert.equal(file, 'ExactKey');
      connectBudget = client.timeoutMs;
      clock.tick(45000);
    },
  };
  const started = Date.now();
  let operationBudget;
  await runStatusBudget(client, 'ExactKey', async () => { operationBudget = client.timeoutMs; }, STATUS_DEFAULT_WALL_MS);
  assert.equal(connectBudget, 120000);
  assert.equal(operationBudget, 120000);
  // The whole command shares one 5 minute deadline.
  assert.equal(client.deadline - started, 300000);
});

test('default status budget gives late Make operations only what is left of 5 minutes', async (t) => {
  const clock = fakeClock(t);
  const client = { timeoutMs: 1, async connect() { clock.tick(200000); } };
  let operationBudget;
  await runStatusBudget(client, 'ExactKey', async () => { operationBudget = client.timeoutMs; }, STATUS_DEFAULT_WALL_MS);
  assert.equal(operationBudget, 100000);
});

test('default status budget caps the Make operation at 120 s after a quick connect', async (t) => {
  const clock = fakeClock(t);
  const client = { timeoutMs: 1, async connect() { clock.tick(20000); } };
  let operationBudget;
  await runStatusBudget(client, 'ExactKey', async () => { operationBudget = client.timeoutMs; }, STATUS_DEFAULT_WALL_MS);
  assert.equal(operationBudget, 120000);
});

test('an explicit timeout gives the Make operation only what connection left', async () => {
  let connectBudget;
  const client = { timeoutMs: 1, async connect() { connectBudget = client.timeoutMs; await delay(200); } };
  let operationBudget;
  let finished = false;
  await runStatusBudget(client, 'ExactKey', async () => {
    operationBudget = client.timeoutMs;
    await delay(50);
    finished = true;
  }, 1000);
  assert.equal(finished, true);
  assert.equal(connectBudget, 1000);
  assert.ok(operationBudget < 1000 && operationBudget > 500, `remaining budget ${operationBudget}`);
});

test('an explicit timeout can expire during fake connection', async () => {
  const client = { timeoutMs: 1000, async connect() { await delay(1200); } };
  let actionRan = false;
  await assert.rejects(runStatusBudget(client, 'ExactKey', async () => { actionRan = true; }, 1000), /Make status timed out/);
  assert.equal(actionRan, false);
});

test('an explicit timeout bounds every Make operation the status action runs, not each one', async () => {
  const { MakeClient } = await import('../src/make-client.js');
  // Each Make operation takes ~150 ms, well inside the 500 ms budget on its
  // own; four of them in sequence must not outlive the whole-command budget.
  const transport = {
    target: null,
    async connect() { transport.target = { fileKey: 'ExactKey' }; },
    async evaluate(expression) { if (expression.includes('ui-snapshot-probe')) await delay(150); return {}; },
    async send() { return {}; },
    close() {},
  };
  const client = new MakeClient({ transport, timeoutMs: 1000 });
  const probe = () => client._operation(deadline => client._evaluate('"ui-snapshot-probe"', deadline));
  let completed = 0;
  const started = Date.now();
  await assert.rejects(runStatusBudget(client, 'ExactKey', async () => {
    for (let i = 0; i < 4; i++) { await probe(); completed++; }
  }, 500), /timed out/);
  assert.ok(completed < 4, `completed ${completed} operations`);
  assert.ok(Date.now() - started < 900, `ran ${Date.now() - started} ms`);
});
