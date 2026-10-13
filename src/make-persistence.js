// Serialized into the exact Make page. It only reads React's current
// codeFileChanges snapshots and returns bounded metadata, never source.
export function makePersistenceState() {
  let root;
  for (const element of document.querySelectorAll('*')) {
    const key = Object.keys(element).find(name => name.startsWith('__reactFiber$'));
    if (!key) continue;
    root = element[key];
    while (root.return) root = root.return;
    break;
  }
  if (!root) return null;
  const fibers = [root];
  const seen = new Set();
  const snapshots = [];
  function inspect(value, depth) {
    if (!value || typeof value !== 'object' || depth > 3 || seen.has(value) || seen.size > 50000) return;
    seen.add(value);
    try {
      if (Object.hasOwn(value, 'codeFileChanges')) {
        const state = value.codeFileChanges;
        snapshots.push({
          mode: state?.isGitSourceOfTruth === true ? 'git' : state?.isGitSourceOfTruth === false ? 'snapshot' : null,
          hasBaseline: state?.hasBaseline === true,
          savedVersion: typeof state?.baselineMakeVersionGitSha === 'string' ? state.baselineMakeVersionGitSha : null,
          pendingCount: Array.isArray(state?.changedFiles) ? state.changedFiles.length : null,
          isLoading: state?.isLoading === true,
          error: !!state?.error,
        });
      }
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 30)) inspect(item, depth + 1);
      } else {
        for (const [key, item] of Object.entries(value)) {
          if (key === 'children' || key === 'ref' || key === 'current' || key === 'owner' || key.startsWith('_')) continue;
          if (item && typeof item === 'object') inspect(item, depth + 1);
        }
      }
    } catch { /* Cross-origin DOM references are irrelevant to this state. */ }
  }
  let count = 0;
  while (fibers.length && count++ < 100000) {
    const fiber = fibers.pop();
    if (!fiber) continue;
    inspect(fiber.memoizedProps, 0);
    let hook = fiber.memoizedState;
    let hooks = 0;
    while (hook && hooks++ < 100) { inspect(hook.memoizedState, 0); hook = hook.next; }
    if (fiber.sibling) fibers.push(fiber.sibling);
    if (fiber.child) fibers.push(fiber.child);
  }
  if (!snapshots.length) return null;
  const unique = [...new Set(snapshots.map(state => JSON.stringify(state)))];
  return unique.length === 1 ? snapshots[0] : { ambiguous: true, count: unique.length };
}
