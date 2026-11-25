// Run fn over items with at most `limit` calls in flight. Results keep the
// input order. An error stops scheduling new work; calls already in flight
// settle, then the lowest-index error is thrown, the one a sequential loop
// would raise, so callers can dispose what they share.
export async function mapLimit(items, limit, fn) {
  const list = [...items];
  const results = new Array(list.length);
  let next = 0, failedAt = -1, firstError;
  const worker = async () => {
    while (failedAt < 0 && next < list.length) {
      const index = next++;
      try { results[index] = await fn(list[index], index); }
      catch (error) { if (failedAt < 0 || index < failedAt) { failedAt = index; firstError = error; } }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length) }, worker));
  if (failedAt >= 0) throw firstError;
  return results;
}

export const READ_CONCURRENCY = 8;
