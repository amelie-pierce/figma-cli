// Serialized into the exact Make page. It only reads React's current
// codeFileChanges snapshots and returns bounded metadata, never source.
// Scan the provider's direct props. Traversing arbitrary app
// objects exhausts the budget on large Make files before reaching the provider.
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
  const snapshots = [];
  const truncation = { arrayItems: 0, depth: 0 };
  let exhausted = false;
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    try {
      if (Object.hasOwn(value, 'codeFileChanges')) {
        const state = value.codeFileChanges;
        const changed = Array.isArray(state?.changedFiles) ? state.changedFiles : null;
        snapshots.push({
          mode: state?.isGitSourceOfTruth === true ? 'git' : state?.isGitSourceOfTruth === false ? 'snapshot' : null,
          hasBaseline: state?.hasBaseline === true,
          savedVersion: typeof state?.baselineMakeVersionGitSha === 'string' ? state.baselineMakeVersionGitSha : null,
          pendingCount: changed?.length ?? null,
          pendingPaths: changed?.every(item => typeof item?.path === 'string') ? changed.map(item => item.path).sort() : null,
          isLoading: state?.isLoading === true,
          error: !!state?.error,
        });
      }
      // Some provider hooks wrap the state once. Do not recurse into generic
      // props: Make's VFS and preview graph can contain hundreds of thousands
      // of unrelated objects.
      if (value.codeFileChanges == null && value.value?.codeFileChanges) inspect(value.value);
    } catch { /* Cross-origin DOM references are irrelevant to this state. */ }
  }
  let count = 0;
  while (fibers.length) {
    if (count++ >= 100000) { exhausted = true; break; }
    const fiber = fibers.pop();
    if (!fiber) continue;
    inspect(fiber.memoizedProps);
    if (fiber.sibling) fibers.push(fiber.sibling);
    if (fiber.child) fibers.push(fiber.child);
  }
  if (exhausted || !snapshots.length) return { state: null, truncation };
  const unique = [...new Set(snapshots.map(state => JSON.stringify(state)))];
  return { state: unique.length === 1 ? snapshots[0] : { ambiguous: true, count: unique.length }, truncation };
}
