// A batch of writes and deletes through a fake client's own single-file methods, in order: what
// MakeClient.writeDurableBatch does for its callers, minus Make. Each call is logged in
// client.batchLog so tests can see which files travelled together. A failure carries what was
// written before it, as the real client's errors do.
export async function batchThrough(client, items, { backupDir } = {}) {
  (client.batchLog ??= []).push(items.map(item => item.path));
  const results = [];
  try {
    for (const item of items) {
      const vendorTreeFallback = item.path.startsWith('src/vendor/atomic-aui/');
      if (item.delete) {
        const result = await client.deleteDurable(item.path, { expectedSha256: item.expectedSha256, backupDir, vendorTreeFallback });
        results.push({ ...result, path: item.path, changed: true });
      } else {
        const result = await client.writeDurable(item.path, item.content, { expectedSha256: item.expectedSha256, backupDir,
          vendorTreeFallback, ...(item.releaseAsset ? { releaseAsset: true } : {}) });
        results.push({ changed: true, ...result, path: item.path });
      }
    }
  } catch (error) {
    error.batchWritesStarted = results.length > 0;
    error.completedWrites = results.filter(result => result.changed);
    error.uncertainWrites = [];
    throw error;
  }
  return results;
}
