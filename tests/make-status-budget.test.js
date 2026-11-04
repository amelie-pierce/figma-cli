import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { runStatusBudget, STATUS_CONNECT_MS, STATUS_DEFAULT_WALL_MS } from '../src/make-status-budget.js';

test('default status budget keeps the Make operation after fake connection time', async () => {
  assert.equal(STATUS_DEFAULT_WALL_MS, STATUS_CONNECT_MS + 120000);
  const client = {
    timeoutMs: 120,
    async connect(file) { assert.equal(file, 'ExactKey'); await delay(100); },
  };
  let operationBudget;
  await runStatusBudget(client, 'ExactKey', async () => {
    operationBudget = client.timeoutMs;
    await delay(100);
  }, 1000);
  assert.ok(operationBudget > 500 && operationBudget <= 1000, `default budget leaves time for the operation: ${operationBudget}`);
});

test('an explicit timeout includes fake connection and the rest of status', async () => {
  const client = { timeoutMs: 1000, async connect() { await delay(200); } };
  let operationBudget;
  await assert.rejects(runStatusBudget(client, 'ExactKey', async () => {
    operationBudget = client.timeoutMs;
    await delay(1200);
  }, 1000), /Make status timed out/);
  assert.ok(operationBudget < 1000 && operationBudget > 500, `remaining budget ${operationBudget}`);
});

test('an explicit timeout can expire during fake connection', async () => {
  const client = { timeoutMs: 1000, async connect() { await delay(1200); } };
  let actionRan = false;
  await assert.rejects(runStatusBudget(client, 'ExactKey', async () => { actionRan = true; }, 1000), /Make status timed out/);
  assert.equal(actionRan, false);
});
