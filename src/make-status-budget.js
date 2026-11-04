// `make status` includes CDP discovery/connection in its budget. The default
// allows 30 s for that stage plus the existing 120 s Make operation; an
// explicit --timeout bounds connection and the Make read together.
export const STATUS_DEFAULT_WALL_MS = 150000;
export const STATUS_CONNECT_MS = 30000;
export async function runStatusBudget(client, file, action, budgetMs) {
  const deadline = Date.now() + budgetMs;
  await client.connect(file);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Make status timed out.');
  client.timeoutMs = Math.min(120000, remaining);
  await action();
}
