// Run fn over items with at most `limit` calls in flight. Results keep the
// input order. The first error stops scheduling new work; calls already in
// flight settle before it is thrown, so callers can dispose what they share.
export async function mapLimit(items, limit, fn) {
  const list = [...items];
  const results = new Array(list.length);
  let next = 0, failed = false, firstError;
  const worker = async () => {
    while (!failed && next < list.length) {
      const index = next++;
      try { results[index] = await fn(list[index], index); }
      catch (error) { if (!failed) { failed = true; firstError = error; } }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length) }, worker));
  if (failed) throw firstError;
  return results;
}

export const READ_CONCURRENCY = 8;
