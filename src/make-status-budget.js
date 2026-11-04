// `make status` includes CDP discovery/connection in its budget. The default
// 150 s wall budget lets connection use up to the client maximum and the Make
// operation the rest, capped at 120 s; an explicit --timeout bounds both.
export const STATUS_DEFAULT_WALL_MS = 150000;
const CLIENT_MAX_MS = 120000;
export async function runStatusBudget(client, file, action, budgetMs) {
  const deadline = Date.now() + budgetMs;
  client.timeoutMs = Math.min(CLIENT_MAX_MS, budgetMs);
  await client.connect(file);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Make status timed out.');
  client.timeoutMs = Math.min(CLIENT_MAX_MS, remaining);
  // Every Make operation the action runs shares the one wall deadline.
  client.deadline = deadline;
  await action();
}
