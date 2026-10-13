// Serialized into the selected Make page. Only Make's own client VFS and
// createVersion are called; no service endpoint or page-global credential is used.
export async function makeDurablePageAction(action) {
  let root;
  for (const element of document.querySelectorAll('*')) {
    const key = Object.keys(element).find(name => name.startsWith('__reactFiber$'));
    if (!key) continue;
    root = element[key];
    while (root.return) root = root.return;
    break;
  }
  if (!root) throw new Error('Make React state is unavailable.');
  const fibers = [root];
  const vfsSet = new Set();
  const sandboxSet = new Set();
  const threads = new Set();
  const pendingStates = [];
  let count = 0;
  while (fibers.length) {
    if (count++ >= 100000) throw new Error('Make state scan exceeded its bound.');
    const fiber = fibers.pop();
    const props = fiber?.memoizedProps;
    if (props && Object.hasOwn(props, 'codeFileChanges')) {
      const changes = props.codeFileChanges;
      const paths = Array.isArray(changes?.changedFiles) && changes.changedFiles.every(item => typeof item?.path === 'string')
        ? changes.changedFiles.map(item => item.path).sort() : null;
      pendingStates.push({ git: changes?.isGitSourceOfTruth === true, baseline: changes?.baselineMakeVersionGitSha,
        hasBaseline: changes?.hasBaseline === true, loading: changes?.isLoading === true, error: !!changes?.error, paths });
    }
    if (typeof props?.vfs?.writeFile === 'function' && typeof props.vfs.deleteFile === 'function') vfsSet.add(props.vfs);
    if (typeof props?.state?.sandbox?.createVersion === 'function') sandboxSet.add(props.state.sandbox);
    const threadId = props?.chatController?.chatSdkState?.threadId;
    if (typeof threadId === 'string' && threadId) threads.add(threadId);
    if (fiber?.sibling) fibers.push(fiber.sibling);
    if (fiber?.child) fibers.push(fiber.child);
  }
  if (action.type === 'save') {
    const unique = [...new Set(pendingStates.map(state => JSON.stringify(state)))];
    const current = pendingStates[0];
    if (unique.length !== 1 || !current?.git || !current.hasBaseline || current.loading || current.error ||
        current.baseline !== action.expectedGitSha || !Array.isArray(current.paths) ||
        JSON.stringify(current.paths) !== JSON.stringify([...action.expectedPaths].sort())) {
      return { refused: 'Make version or pending file set changed before createVersion.' };
    }
    if (sandboxSet.size !== 1 || threads.size !== 1) throw new Error('Make version function or thread is absent or ambiguous.');
    const version = await [...sandboxSet][0].createVersion({ threadId: [...threads][0], title: action.title });
    return { id: version?.id, versionNumber: version?.versionNumber, gitSha: version?.gitSha };
  }
  if (vfsSet.size !== 1) throw new Error('Make client VFS is absent or ambiguous.');
  const vfs = [...vfsSet][0];
  const path = `/${action.path}`;
  if (action.type === 'read') {
    const entry = vfs.getFileEntryByPath(path);
    return { exists: !!entry, content: entry ? await entry.asyncContents : null };
  }
  if (action.type === 'write') {
    const entry = vfs.getFileEntryByPath(path);
    const current = entry ? await entry.asyncContents : null;
    if (current !== action.expectedContent) return { refused: 'Make client VFS content changed before write.' };
    await vfs.writeFile(path, action.content);
    return { accepted: true };
  }
  if (action.type === 'delete') {
    const entry = vfs.getFileEntryByPath(path);
    const current = entry ? await entry.asyncContents : null;
    if (current !== action.expectedContent) return { refused: 'Make client VFS content changed before delete.' };
    await vfs.deleteFile(path);
    return { accepted: true };
  }
  throw new Error('Unknown Make durable action.');
}

export function requireGitMode(state) {
  if (!state) throw new Error('Make saving mode is unavailable; durable operation refused.');
  if (state.mode !== 'git') throw new Error('Snapshot-mode Make files are unsupported by durable writes; use the Save card workflow.');
  if (!state.hasBaseline || !/^[a-f0-9]{40}$/.test(state.savedVersion || '') || state.isLoading || state.error || !Array.isArray(state.pendingPaths)) {
    throw new Error('Make git baseline or pending state is unverified; durable operation refused.');
  }
  return state;
}

export function requireExactPending(state, expectedPaths) {
  requireGitMode(state);
  const actual = [...state.pendingPaths].sort();
  const expected = [...new Set(expectedPaths)].sort();
  if (expected.length !== expectedPaths.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Make has unrelated or missing pending changes; expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}.`);
  }
  return actual;
}
