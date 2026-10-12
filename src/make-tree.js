/**
 * Traverse Make's visible, virtualized Code file tree. This adapter uses only
 * DOM state and ordinary folder/file clicks; it never accesses Design APIs or
 * Make's private application stores.
 */

const POSITION_TOLERANCE = 1;

function optionsWithDeadline({ timeoutMs = 15000, maxEntries = 10000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
    throw new Error('Make tree timeoutMs must be between 1 and 120000.');
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100000) {
    throw new Error('Make tree maxEntries must be an integer between 1 and 100000.');
  }
  return { deadline: Date.now() + timeoutMs, maxEntries };
}

function sameRow(a, b) {
  return a.name === b.name && a.kind === b.kind && a.level === b.level &&
    a.top === b.top && a.height === b.height && a.expanded === b.expanded;
}

function validateName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' ||
      /[\/\\\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('Make file tree contains an unsupported or ambiguous entry name.');
  }
}

/**
 * Reconstruct paths only from a complete, contiguous, fully expanded tree.
 * Exposed for deterministic tests of virtualization and hierarchy safeguards.
 */
export function buildMakeHierarchy(rows, { contentHeight, maxEntries = 10000, allowCollapsed = false } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Make file tree has no readable entries.');
  }
  if (rows.length > maxEntries) throw new Error(`Make file tree exceeds ${maxEntries} entries.`);
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) {
    throw new Error('Make file tree content height is unavailable.');
  }
  const ordered = [...rows].sort((a, b) => a.top - b.top);
  const ancestors = [];
  const paths = new Set();
  let previousBottom = 0;
  let previous;
  const entries = ordered.map((row) => {
    validateName(row.name);
    if (!Number.isInteger(row.level) || row.level < 1 ||
        !Number.isFinite(row.top) || row.top < 0 ||
        !Number.isFinite(row.height) || row.height <= 0 ||
        !['file', 'folder'].includes(row.kind)) {
      throw new Error('Make file tree contains malformed row metadata.');
    }
    if (Math.abs(row.top - previousBottom) > POSITION_TOLERANCE ||
        (previous && row.top <= previous.top)) {
      throw new Error('Make file tree is incomplete: missing or overlapping virtualized rows.');
    }
    if (row.kind === 'folder' && row.expanded !== true && !allowCollapsed) {
      throw new Error('Make file tree is incomplete: a folder is still collapsed.');
    }
    if (row.level > ancestors.length + 1) {
      throw new Error('Make file tree is incomplete: an ancestor is missing.');
    }
    ancestors.length = row.level - 1;
    if (row.level > 1 && ancestors[row.level - 2]?.kind !== 'folder') {
      throw new Error('Make file tree is invalid: a file cannot contain child entries.');
    }
    if (row.level > 1 && ancestors[row.level - 2]?.expanded !== true) {
      throw new Error('Make file tree is invalid: a collapsed folder cannot have visible children.');
    }
    const path = [...ancestors.map((ancestor) => ancestor.name), row.name].join('/');
    if (paths.has(path)) throw new Error(`Make file tree contains an ambiguous path: ${path}`);
    paths.add(path);
    ancestors.push(row);
    previous = row;
    previousBottom = row.top + row.height;
    return { path, kind: row.kind, level: row.level, top: row.top };
  });
  if (Math.abs(previousBottom - contentHeight) > POSITION_TOLERANCE) {
    throw new Error('Make file tree is incomplete: final virtualized rows are missing.');
  }
  return entries;
}

// Self-contained because the function is serialized into the page context.
async function treeDOMAction(action) {
  function inspect() {
    const roots = [...document.querySelectorAll('[data-testid="virtualized-file-tree-container"][role="tree"]')]
      .filter((element) => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0);
    if (roots.length !== 1) throw new Error('Expected exactly one visible Make Code file tree.');
    const root = roots[0];
    const elements = [...root.querySelectorAll('[role="treeitem"]')];
    if (!elements.length) throw new Error('Make Code file tree has no rendered rows.');
    const content = elements[0].parentElement;
    if (!elements.every((row) => row.parentElement === content)) {
      throw new Error('Unsupported Make file tree row containers.');
    }
    let viewport = content.parentElement;
    while (viewport && viewport !== root.parentElement) {
      const style = getComputedStyle(viewport);
      if (/(auto|scroll)/.test(style.overflowY || style.overflow) && viewport.clientHeight > 0) break;
      viewport = viewport.parentElement;
    }
    if (!viewport || viewport === root.parentElement) {
      throw new Error('Make file tree scroll viewport is unavailable.');
    }
    // scrollHeight is at least clientHeight, even when the list is shorter.
    // The explicit inner list height describes the actual virtualized rows.
    const contentHeight = /^\d+(?:\.\d+)?px$/.test(content.style.height)
      ? Number.parseFloat(content.style.height) : NaN;
    if (!Number.isFinite(contentHeight) || contentHeight <= 0) {
      throw new Error('Make file tree content height is unavailable.');
    }
    const rows = elements.map((element) => {
      const file = element.querySelector('[data-testid="code-file-item"]');
      const folder = element.querySelector('button[aria-label^="Folder "]');
      if (Boolean(file) === Boolean(folder)) throw new Error('Ambiguous Make file tree row type.');
      const control = file || folder;
      const name = element.getAttribute('aria-label');
      const kind = file ? 'file' : 'folder';
      if (control.getAttribute('aria-label') !== `${file ? 'File' : 'Folder'} "${name}"`) {
        throw new Error('Make file tree entry labels disagree.');
      }
      const level = Number(element.getAttribute('aria-level'));
      const top = /^\d+(?:\.\d+)?px$/.test(element.style.top) ? Number.parseFloat(element.style.top) : NaN;
      const height = element.getBoundingClientRect().height;
      const rowExpanded = element.getAttribute('aria-expanded');
      const controlExpanded = control.getAttribute('aria-expanded');
      if (folder && rowExpanded != null && controlExpanded != null && rowExpanded !== controlExpanded) {
        throw new Error('Make folder expansion attributes disagree.');
      }
      const expandedAttribute = rowExpanded ?? controlExpanded;
      if (folder && expandedAttribute !== 'true' && expandedAttribute !== 'false') {
        throw new Error('Make folder expansion state is unavailable.');
      }
      if (!name || !Number.isInteger(level) || level < 1 || !Number.isFinite(top) || height <= 0) {
        throw new Error('Make file tree contains malformed row metadata.');
      }
      return { name, kind, level, top, height, expanded: folder ? expandedAttribute === 'true' : null,
        selected: control.getAttribute('aria-current') === 'page', element, control };
    });
    return { viewport, contentHeight, rows };
  }
  function snapshot(state) {
    return { contentHeight: state.contentHeight, scrollTop: state.viewport.scrollTop,
      clientHeight: state.viewport.clientHeight,
      rows: state.rows.map(({ element, control, ...row }) => row) };
  }
  function checkExpected(state) {
    if (Math.abs(state.contentHeight - action.contentHeight) > 1) {
      throw new Error('Make file tree changed before the requested action. Run the command again.');
    }
    for (const row of state.rows) {
      const expected = action.expectedRows.find((candidate) => candidate.top === row.top);
      if (!expected || expected.name !== row.name || expected.kind !== row.kind ||
          expected.level !== row.level || expected.height !== row.height || expected.expanded !== row.expanded) {
        throw new Error('Make file tree changed before the requested action. Run the command again.');
      }
    }
  }
  const state = inspect();
  if (action.type === 'scroll') {
    state.viewport.scrollTop = action.top;
    // scrollTop changes before React mounts the new virtualized rows. Wait for
    // actual coverage of this viewport, not merely a fixed animation delay.
    const deadline = Date.now() + 1500;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const next = inspect();
      const first = Math.min(...next.rows.map(row => row.top));
      const last = Math.max(...next.rows.map(row => row.top + row.height));
      if (first <= next.viewport.scrollTop + 1 &&
          last >= Math.min(next.contentHeight, next.viewport.scrollTop + next.viewport.clientHeight) - 1) {
        return snapshot(next);
      }
      if (Date.now() >= deadline) throw new Error('Make file tree did not render the requested viewport.');
    }
  }
  if (action.type === 'expand' || action.type === 'collapse' || action.type === 'select') {
    checkExpected(state);
    const matches = state.rows.filter((row) => row.top === action.row.top && row.name === action.row.name &&
      row.level === action.row.level && row.kind === action.row.kind);
    if (matches.length !== 1) throw new Error('Make file tree target is absent or ambiguous.');
    const row = matches[0];
    if (action.type === 'expand' && (row.kind !== 'folder' || row.expanded !== false)) {
      throw new Error('Make folder changed before expansion.');
    }
    if (action.type === 'collapse' && (row.kind !== 'folder' || row.expanded !== true)) {
      throw new Error('Make folder changed before collapse.');
    }
    if (action.type === 'select') {
      if (row.kind !== 'file') throw new Error('Only Make source files can be selected.');
      if (!Array.isArray(action.ancestors) || action.ancestors.length !== row.level - 1) {
        throw new Error('Make source ancestry is incomplete; selection was refused.');
      }
      for (const [index, ancestor] of action.ancestors.entries()) {
        const candidates = state.rows.filter((candidate) => candidate.top === ancestor.top);
        const current = candidates[0];
        if (candidates.length !== 1 || ancestor.level !== index + 1 ||
            ancestor.kind !== 'folder' || ancestor.expanded !== true ||
            current.name !== ancestor.name || current.kind !== ancestor.kind ||
            current.level !== ancestor.level || current.height !== ancestor.height ||
            current.expanded !== ancestor.expanded) {
          throw new Error('Make source ancestry is not verifiable in the current file-tree viewport; selection was refused.');
        }
      }
    }
    row.control.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    return snapshot(inspect());
  }
  if (action.type !== 'snapshot') throw new Error('Unknown Make tree action.');
  return snapshot(state);
}

async function evaluateTree(transport, action, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Timed out while reading the Make file tree.');
  let timer;
  try {
    return await Promise.race([
      transport.evaluate(`(${treeDOMAction.toString()})(${JSON.stringify(action)})`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out while reading the Make file tree.')), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function scanTree(transport, { deadline, maxEntries, targetPath }) {
  let expansions = 0;
  for (;;) {
    let state = await evaluateTree(transport, { type: 'scroll', top: 0 }, deadline);
    const contentHeight = state.contentHeight;
    const observed = new Map();
    let restart = false;
    for (;;) {
      if (!Number.isFinite(state.contentHeight) || state.contentHeight <= 0 ||
          !Number.isFinite(state.clientHeight) || state.clientHeight <= 0 ||
          !Number.isFinite(state.scrollTop) || !Array.isArray(state.rows) || !state.rows.length) {
        throw new Error('Make file tree returned invalid viewport metadata.');
      }
      if (state.contentHeight !== contentHeight) {
        restart = true;
        break;
      }
      const visibleTops = new Set();
      for (const row of state.rows) {
        validateName(row.name);
        if (visibleTops.has(row.top)) throw new Error('Make file tree contains ambiguous overlapping rows.');
        visibleTops.add(row.top);
        const previous = observed.get(row.top);
        if (previous && !sameRow(previous, row)) {
          throw new Error('Make file tree changed during traversal. Run the command again.');
        }
        observed.set(row.top, row);
      }
      if (observed.size > maxEntries) throw new Error(`Make file tree exceeds ${maxEntries} entries.`);
      let folderAction;
      if (targetPath) {
        const prefix = [...observed.values()].sort((a, b) => a.top - b.top);
        const paths = buildMakeHierarchy(prefix, {
          contentHeight: prefix.at(-1).top + prefix.at(-1).height, maxEntries, allowCollapsed: true,
        });
        folderAction = state.rows.flatMap(row => {
          if (row.kind !== 'folder') return [];
          const folderPath = paths.find(entry => entry.top === row.top)?.path;
          const wanted = targetPath.startsWith(`${folderPath}/`);
          return row.expanded === wanted ? [] : [{ row, type: wanted ? 'expand' : 'collapse' }];
        })[0];
      } else {
        const row = state.rows.find(row => row.kind === 'folder' && row.expanded === false);
        if (row) folderAction = { row, type: 'expand' };
      }
      if (folderAction) {
        if (++expansions > maxEntries) throw new Error('Make file tree exceeded the folder expansion limit.');
        await evaluateTree(transport, { type: folderAction.type, row: folderAction.row, contentHeight,
          expectedRows: state.rows }, deadline);
        restart = true;
        break;
      }
      const maxScroll = Math.max(0, contentHeight - state.clientHeight);
      if (state.scrollTop >= maxScroll - POSITION_TOLERANCE) {
        const rows = [...observed.values()].sort((a, b) => a.top - b.top);
        const entries = buildMakeHierarchy(rows, { contentHeight, maxEntries, allowCollapsed: !!targetPath });
        return { entries, rows, contentHeight, clientHeight: state.clientHeight };
      }
      const nextTop = Math.min(maxScroll, state.scrollTop + Math.max(1, state.clientHeight * 0.75));
      const previousTop = state.scrollTop;
      state = await evaluateTree(transport, { type: 'scroll', top: nextTop }, deadline);
      if (state.scrollTop <= previousTop) throw new Error('Make file tree did not scroll; traversal is incomplete.');
    }
    if (!restart) throw new Error('Make file tree traversal did not complete.');
  }
}

export async function listMakeFiles(transport, options = {}) {
  const result = await scanTree(transport, optionsWithDeadline(options));
  return result.entries;
}

export async function selectMakeFile(transport, path, options = {}) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.endsWith('/') ||
      path.split('/').some((part) => !part || part === '.' || part === '..') || /[\\\u0000-\u001f\u007f]/.test(path)) {
    throw new Error('Use an exact project-relative Make source path, such as src/App.tsx.');
  }
  const settings = optionsWithDeadline(options);
  const result = await scanTree(transport, { ...settings, targetPath: path });
  const entry = result.entries.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`Make source file not found: ${path}`);
  if (entry.kind !== 'file') throw new Error(`Make source path is a folder: ${path}`);
  const expectedRow = result.rows.find((row) => row.top === entry.top);
  const parts = path.split('/');
  const ancestors = parts.slice(0, -1).map((_, index) => {
    const ancestorPath = parts.slice(0, index + 1).join('/');
    const ancestorEntry = result.entries.find((candidate) => candidate.path === ancestorPath);
    const ancestorRow = ancestorEntry && result.rows.find((candidate) => candidate.top === ancestorEntry.top);
    if (!ancestorRow || ancestorRow.kind !== 'folder' || ancestorRow.level !== index + 1 || ancestorRow.expanded !== true) {
      throw new Error('Make source ancestry is incomplete; selection was refused.');
    }
    return { ...ancestorRow, path: ancestorPath };
  });
  // A DOM-only adapter cannot prove the identity of an unmounted ancestor.
  // Keep the entire ancestor chain and leaf rendered together, or refuse.
  const selectionTop = ancestors[0]?.top ?? entry.top;
  if (entry.top + expectedRow.height - selectionTop > result.clientHeight + POSITION_TOLERANCE) {
    throw new Error('Make source ancestry cannot fit in the file-tree viewport; selection was refused. Enlarge the Code panel or use a shallower source path.');
  }
  await evaluateTree(transport, { type: 'scroll', top: selectionTop }, settings.deadline);
  let state = await evaluateTree(transport, { type: 'select', row: expectedRow,
    contentHeight: result.contentHeight, expectedRows: result.rows, ancestors }, settings.deadline);
  for (;;) {
    if (state.contentHeight !== result.contentHeight) {
      throw new Error('Make file tree changed while selecting the source file.');
    }
    for (const ancestor of ancestors) {
      const rendered = state.rows.filter((candidate) => candidate.top === ancestor.top);
      if (rendered.length !== 1 || !sameRow(rendered[0], ancestor)) {
        throw new Error('Make source ancestry changed or is no longer rendered after selection.');
      }
    }
    const selected = state.rows.filter((row) => row.kind === 'file' && row.selected);
    if (selected.length === 1 && sameRow(selected[0], expectedRow)) {
      return { ...entry, name: expectedRow.name, ancestors };
    }
    // The DOM action's short wait lets React apply a click. Subsequent reads
    // also yield briefly in the page to avoid a busy CDP polling loop.
    state = await evaluateTree(transport, { type: 'scroll', top: selectionTop }, settings.deadline);
  }
}
