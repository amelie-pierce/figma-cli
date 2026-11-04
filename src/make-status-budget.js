// `make status` includes CDP discovery/connection in its wall budget. The
// default allows 30 s for that stage plus the existing 120 s Make operation;
// an explicit --timeout is the entire command budget.
export const STATUS_DEFAULT_WALL_MS = 150000;
export const STATUS_CONNECT_MS = 30000;
export async function runStatusBudget(client, file, action, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let timer;
  try {
    await Promise.race([
      (async () => {
        await client.connect(file);
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Make status timed out.');
        client.timeoutMs = Math.min(120000, remaining);
        await action();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Make status timed out.')), budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
