import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { runStatusBudget, STATUS_DEFAULT_WALL_MS } from '../src/make-status-budget.js';

test('default status budget lets a connect longer than 30 s finish inside the wall budget', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let connectBudget;
  const client = {
    timeoutMs: 1,
    async connect(file) {
      assert.equal(file, 'ExactKey');
      connectBudget = client.timeoutMs;
      t.mock.timers.tick(45000);
    },
  };
  let operationBudget;
  await runStatusBudget(client, 'ExactKey', async () => { operationBudget = client.timeoutMs; }, STATUS_DEFAULT_WALL_MS);
  assert.equal(connectBudget, 120000);
  assert.equal(operationBudget, 105000);
});

test('default status budget caps the Make operation at 120 s after a quick connect', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const client = { timeoutMs: 1, async connect() { t.mock.timers.tick(20000); } };
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
