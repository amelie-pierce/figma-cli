import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { MakeClient } from '../src/make-client.js';
import { buildMakeHierarchy, listMakeFiles, selectMakeFile } from '../src/make-tree.js';

const row = (name, kind, level, index, extra = {}) => ({
  name, kind, level, top: index * 32, height: 32,
  expanded: kind === 'folder' ? true : null, ...extra,
});

describe('Make complete tree hierarchy', () => {
  it('resolves identical basenames under separate parents without guessing', () => {
    const rows = [row('src', 'folder', 1, 0), row('App.tsx', 'file', 2, 1),
      row('tests', 'folder', 1, 2), row('App.tsx', 'file', 2, 3)];
    assert.deepEqual(buildMakeHierarchy(rows.reverse(), { contentHeight: 128 }).map((entry) => entry.path),
      ['src', 'src/App.tsx', 'tests', 'tests/App.tsx']);
  });

  it('rejects missing first, middle, and last virtualized rows', () => {
    assert.throws(() => buildMakeHierarchy([row('a', 'file', 1, 1)], { contentHeight: 64 }), /incomplete/);
    assert.throws(() => buildMakeHierarchy([row('a', 'file', 1, 0), row('c', 'file', 1, 2)], { contentHeight: 96 }), /incomplete/);
    assert.throws(() => buildMakeHierarchy([row('a', 'file', 1, 0)], { contentHeight: 64 }), /incomplete/);
  });

  it('rejects missing ancestors, children beneath files, and ambiguous paths', () => {
    assert.throws(() => buildMakeHierarchy([row('a', 'file', 2, 0)], { contentHeight: 32 }), /ancestor/);
    assert.throws(() => buildMakeHierarchy([row('a', 'file', 1, 0), row('b', 'file', 2, 1)], { contentHeight: 64 }), /cannot contain/);
    assert.throws(() => buildMakeHierarchy([row('a', 'file', 1, 0), row('a', 'file', 1, 1)], { contentHeight: 64 }), /ambiguous path/);
  });

  it('rejects collapsed folders, invalid names, row overlap, and entry limits', () => {
    assert.throws(() => buildMakeHierarchy([row('src', 'folder', 1, 0, { expanded: false })], { contentHeight: 32 }), /collapsed/);
    assert.throws(() => buildMakeHierarchy([row('../a', 'file', 1, 0)], { contentHeight: 32 }), /name/);
    assert.throws(() => buildMakeHierarchy([row('a', 'file', 1, 0), row('b', 'file', 1, 0)], { contentHeight: 32 }), /overlapping/);
    assert.throws(() => buildMakeHierarchy([row('a', 'file', 1, 0), row('b', 'file', 1, 1)], { contentHeight: 64, maxEntries: 1 }), /exceeds/);
  });
});

function file(name) { return { name, kind: 'file' }; }
function folder(name, children, expanded = false) { return { name, kind: 'folder', children, expanded }; }

/** Minimal DOM fixture: execute the production scripts against real virtualized
 * behavior, rather than replacing their return values with hand-authored rows. */
function fixture(nodes, { clientHeight = 64, skipPath, onAction, rejectSelection = false,
  missingRootReadsAfterClick = 0 } = {}) {
  let selectedPath = null;
  let position = 0;
  let missingRootReads = 0;
  const actions = [];
  const clicks = [];
  function flatten(children = nodes, prefix = '', level = 1) {
    return children.flatMap((node) => {
      const path = prefix ? `${prefix}/${node.name}` : node.name;
      return [{ node, path, level }, ...(node.kind === 'folder' && node.expanded ? flatten(node.children, path, level + 1) : [])];
    });
  }
  const content = { style: {} };
  Object.defineProperty(content.style, 'height', { get: () => `${flatten().length * 32}px` });
  const viewport = { clientHeight, style: { overflowY: 'auto' } };
  Object.defineProperty(viewport, 'scrollTop', {
    get: () => position,
    set: (value) => { position = Math.max(0, Math.min(value, flatten().length * 32 - clientHeight)); },
  });
  Object.defineProperty(viewport, 'scrollHeight', { get: () => Math.max(clientHeight, flatten().length * 32) });
  content.parentElement = viewport;
  const root = {
    parentElement: {},
    getBoundingClientRect: () => ({ width: 316, height: clientHeight }),
    querySelectorAll: () => flatten().flatMap(({ node, path, level }, index) => {
      const top = index * 32;
      if (top + 32 <= position || top >= position + clientHeight || path === skipPath) return [];
      const control = {
        getAttribute: (name) => ({
          'aria-label': `${node.kind === 'file' ? 'File' : 'Folder'} "${node.name}"`,
          'aria-expanded': node.kind === 'folder' ? String(node.expanded) : null,
          'aria-current': path === selectedPath ? 'page' : null,
        })[name] ?? null,
        click: () => {
          clicks.push(path);
          missingRootReads = missingRootReadsAfterClick;
          if (node.kind === 'folder') node.expanded = !node.expanded;
          else if (!rejectSelection) selectedPath = path;
        },
      };
      return [{
        parentElement: content,
        style: { top: `${top}px` },
        getBoundingClientRect: () => ({ height: 32, width: 316 }),
        getAttribute: (name) => ({ 'aria-label': node.name, 'aria-level': String(level),
          'aria-expanded': node.kind === 'folder' ? String(node.expanded) : null })[name] ?? null,
        querySelector: (selector) => selector === '[data-testid="code-file-item"]'
          ? (node.kind === 'file' ? control : null)
          : (node.kind === 'folder' ? control : null),
      }];
    }),
  };
  viewport.parentElement = root;
  const context = { document: { querySelectorAll: () => missingRootReads-- > 0 ? [] : [root] },
    getComputedStyle: (element) => element.style,
    setTimeout: (callback) => { callback(); return 1; } };
  return {
    nodes, actions, clicks, viewport,
    get selectedPath() { return selectedPath; },
    async evaluate(expression) {
      const match = expression.match(/\)\((\{[\s\S]*\})\)$/);
      const action = JSON.parse(match[1]);
      actions.push(action);
      onAction?.(action, { nodes, viewport, actions, clicks });
      // Clone data from the VM realm as the CDP transport does.
      return JSON.parse(JSON.stringify(await vm.runInNewContext(expression, context)));
    },
  };
}

describe('Make virtualized DOM traversal', () => {
  it('expands nested folders and reads all pages of a virtualized tree', async () => {
    const transport = fixture([folder('src', [folder('components', [file('App.tsx'), file('Button.tsx')]), file('main.tsx')]),
      folder('tests', [file('App.tsx')]), file('package.json')]);
    const entries = await listMakeFiles(transport);
    assert.deepEqual(entries.map((entry) => entry.path), ['src', 'src/components', 'src/components/App.tsx',
      'src/components/Button.tsx', 'src/main.tsx', 'tests', 'tests/App.tsx', 'package.json']);
    assert.deepEqual(transport.clicks, ['src', 'src/components', 'tests']);
    assert.ok(transport.actions.filter((action) => action.type === 'scroll').length > 4);
    assert.equal(transport.selectedPath, null);
  });

  it('uses list content height when the viewport is taller than the whole tree', async () => {
    const transport = fixture([file('index.html'), file('package.json')], { clientHeight: 953 });
    assert.equal(transport.viewport.scrollHeight, 953);
    assert.deepEqual((await listMakeFiles(transport)).map((entry) => entry.path), ['index.html', 'package.json']);
  });

  it('selects an exact path despite duplicate basenames and verifies aria-current', async () => {
    const transport = fixture([folder('src', [file('App.tsx')]), folder('tests', [file('App.tsx')])]);
    assert.deepEqual(await selectMakeFile(transport, 'tests/App.tsx'), {
      path: 'tests/App.tsx', kind: 'file', top: 64, level: 2, name: 'App.tsx',
      ancestors: [{ name: 'tests', kind: 'folder', level: 1, top: 32, height: 32,
        expanded: true, selected: false, path: 'tests' }],
    });
    assert.equal(transport.selectedPath, 'tests/App.tsx');
    assert.equal(transport.clicks.at(-1), 'tests/App.tsx');
  });

  it('waits for a transient Make tree remount after one selection click', async () => {
    const transport = fixture([file('App.tsx')], { missingRootReadsAfterClick: 2 });
    assert.equal((await selectMakeFile(transport, 'App.tsx')).path, 'App.tsx');
    assert.deepEqual(transport.clicks, ['App.tsx']);
  });

  it('fails closed on a virtualization gap', async () => {
    const transport = fixture([file('a'), file('b'), file('c')], { skipPath: 'b', clientHeight: 96 });
    await assert.rejects(listMakeFiles(transport), /incomplete/);
    assert.deepEqual(transport.clicks, []);
  });

  it('does not click a file if its tree metadata changes just before selection', async () => {
    const transport = fixture([file('a'), file('b')], {
      onAction(action, { nodes }) { if (action.type === 'select') nodes[1].name = 'renamed'; },
    });
    await assert.rejects(selectMakeFile(transport, 'b'), /changed before/);
    assert.deepEqual(transport.clicks, []);
  });

  it('does not click a file when a new entry changes content height', async () => {
    const transport = fixture([file('a'), file('b')], {
      onAction(action, { nodes }) { if (action.type === 'select') nodes.push(file('c')); },
    });
    await assert.rejects(selectMakeFile(transport, 'b'), /changed before/);
    assert.deepEqual(transport.clicks, []);
  });

  it('refreshes once when a write inserts its file and parent folder during a guarded tree action', async () => {
    let inserted = false;
    let armed = false;
    const transport = fixture([folder('src', [file('old.ts')])], {
      onAction(action, { nodes }) {
        if (armed && action.type === 'expand' && !inserted) {
          nodes[0].children.push(folder('field', [file('Input.tsx')]));
          inserted = true;
        }
      },
    });
    let beforeRows;
    const beforeEntries = await listMakeFiles(transport, { onSnapshot: snapshot => { beforeRows = snapshot.rows; } });
    transport.nodes[0].expanded = false;
    armed = true;
    const entries = await listMakeFiles(transport, { expectedChange: { beforeEntries, beforeRows, writtenPath: 'src/field/Input.tsx' } });
    assert.deepEqual(entries.map(entry => entry.path), ['src', 'src/old.ts', 'src/field', 'src/field/Input.tsx']);
    assert.equal(inserted, true);
  });

  it('refuses an unrelated file inserted alongside the written folder', async () => {
    let inserted = false;
    let armed = false;
    const transport = fixture([folder('src', [file('old.ts')])], {
      onAction(action, { nodes }) {
        if (armed && action.type === 'expand' && !inserted) {
          nodes[0].children.push(folder('field', [file('Input.tsx')]), file('stray.ts'));
          inserted = true;
        }
      },
    });
    let beforeRows;
    const beforeEntries = await listMakeFiles(transport, { onSnapshot: snapshot => { beforeRows = snapshot.rows; } });
    transport.nodes[0].expanded = false;
    armed = true;
    await assert.rejects(listMakeFiles(transport, { expectedChange: { beforeEntries, beforeRows, writtenPath: 'src/field/Input.tsx' } }), /changed before/);
  });

  it('does not authorize a tree refresh without the complete pre-write rows', async () => {
    const transport = fixture([folder('src', [file('old.ts')])]);
    const beforeEntries = await listMakeFiles(transport);
    transport.nodes[0].children.push(folder('field', [file('Input.tsx')]));
    await assert.rejects(listMakeFiles(transport, { expectedChange: { beforeEntries, writtenPath: 'src/field/Input.tsx' } }), /changed before/);
  });

  it('refreshes once when a delete removes its file and the folder it emptied during a guarded tree action', async () => {
    let removed = false;
    let armed = false;
    const transport = fixture([folder('src', [file('old.ts'), folder('field', [file('Input.tsx')])])], {
      clientHeight: 320,
      onAction(action, { nodes }) {
        if (armed && action.type === 'expand' && !removed) {
          nodes[0].children.splice(1, 1);
          removed = true;
        }
      },
    });
    let beforeRows;
    const beforeEntries = await listMakeFiles(transport, { onSnapshot: snapshot => { beforeRows = snapshot.rows; } });
    assert.ok(beforeEntries.some(entry => entry.path === 'src/field/Input.tsx'));
    transport.nodes[0].expanded = false;
    armed = true;
    const entries = await listMakeFiles(transport, { expectedChange: { beforeEntries, beforeRows, removedPath: 'src/field/Input.tsx' } });
    assert.deepEqual(entries.map(entry => entry.path), ['src', 'src/old.ts']);
    assert.equal(removed, true);
  });

  it('refuses an unrelated removal alongside the deleted file', async () => {
    let removed = false;
    let armed = false;
    const transport = fixture([folder('src', [file('old.ts'), folder('field', [file('Input.tsx')])])], {
      clientHeight: 320,
      onAction(action, { nodes }) {
        if (armed && action.type === 'expand' && !removed) {
          nodes[0].children.splice(0, 2);
          removed = true;
        }
      },
    });
    let beforeRows;
    const beforeEntries = await listMakeFiles(transport, { onSnapshot: snapshot => { beforeRows = snapshot.rows; } });
    transport.nodes[0].expanded = false;
    armed = true;
    await assert.rejects(listMakeFiles(transport, { expectedChange: { beforeEntries, beforeRows, removedPath: 'src/field/Input.tsx' } }), /changed before/);
  });

  it('waits for a delete and keeps its folder while it still holds other files', async () => {
    const transport = fixture([folder('src', [folder('field', [file('Input.tsx'), file('Label.tsx')])])], { clientHeight: 320 });
    let beforeRows;
    const beforeEntries = await listMakeFiles(transport, { onSnapshot: snapshot => { beforeRows = snapshot.rows; } });
    const unchanged = await listMakeFiles(transport, { expectedChange: { beforeEntries, beforeRows, removedPath: 'src/field/Input.tsx' } });
    assert.deepEqual(unchanged.map(entry => entry.path), beforeEntries.map(entry => entry.path));
    transport.nodes[0].children[0].children.splice(0, 1);
    const entries = await listMakeFiles(transport, { expectedChange: { beforeEntries, beforeRows, removedPath: 'src/field/Input.tsx' } });
    assert.deepEqual(entries.map(entry => entry.path), ['src', 'src/field', 'src/field/Label.tsx']);
    transport.nodes[0].children.splice(0, 1);
    await assert.rejects(listMakeFiles(transport, { expectedChange: { beforeEntries, beforeRows, removedPath: 'src/field/Input.tsx' } }), /changed before/);
  });

  it('rescans without clicking when a just-written file appears before a folder expansion', async () => {
    let added = false;
    const transport = fixture([folder('src', [file('a')]), file('package.json')], {
      onAction(action, { nodes }) {
        if (action.type === 'expand' && !added) { added = true; nodes.splice(1, 0, file('new.ts')); }
      },
    });
    assert.deepEqual((await listMakeFiles(transport)).map((entry) => entry.path),
      ['src', 'src/a', 'new.ts', 'package.json']);
    assert.deepEqual(transport.clicks, ['src']);
  });

  it('keeps every ancestor rendered with the leaf and returns root-to-parent metadata', async () => {
    const transport = fixture([folder('src', [folder('components', [file('App.tsx')], true)], true), file('package.json')],
      { clientHeight: 96 });
    const entry = await selectMakeFile(transport, 'src/components/App.tsx');
    assert.deepEqual(entry.ancestors.map(({ name, kind, level, top, height, expanded, path }) =>
      ({ name, kind, level, top, height, expanded, path })), [
      { name: 'src', kind: 'folder', level: 1, top: 0, height: 32, expanded: true, path: 'src' },
      { name: 'components', kind: 'folder', level: 2, top: 32, height: 32, expanded: true, path: 'src/components' },
    ]);
    assert.equal(transport.viewport.scrollTop, 0);
    assert.equal(transport.selectedPath, 'src/components/App.tsx');
  });

  it('refuses selection when an ancestor cannot share the rendered viewport with its leaf', async () => {
    const transport = fixture([folder('src', [file('a'), file('App.tsx')], true)], { clientHeight: 64 });
    await assert.rejects(selectMakeFile(transport, 'src/App.tsx'), /ancestry cannot fit/);
    assert.deepEqual(transport.clicks, []);
  });

  it('refuses before clicking when equal-sized subtrees swap and the changed parent is offscreen', async () => {
    const sameChildren = () => [file('App.tsx'), file('a'), file('b'), file('c')];
    const transport = fixture([folder('src', sameChildren(), true), folder('tests', sameChildren(), true)], {
      clientHeight: 64,
      onAction(action, { nodes, viewport }) {
        if (action.type !== 'select') return;
        nodes.reverse();
        viewport.scrollTop = action.row.top;
      },
    });
    await assert.rejects(selectMakeFile(transport, 'src/App.tsx'), /ancestry is not verifiable|changed before/);
    assert.ok(!transport.clicks.some(path => path.endsWith('/App.tsx')));
  });

  it('refuses before clicking when a renamed ancestor is offscreen but leaf metadata stays identical', async () => {
    const transport = fixture([folder('src', [file('App.tsx'), file('a'), file('b'), file('c')], true)], {
      clientHeight: 64,
      onAction(action, { nodes, viewport }) {
        if (action.type !== 'select') return;
        nodes[0].name = 'renamed';
        viewport.scrollTop = action.row.top;
      },
    });
    await assert.rejects(selectMakeFile(transport, 'src/App.tsx'), /ancestry is not verifiable/);
    assert.deepEqual(transport.clicks, []);
  });

  it('rejects non-existent, unsafe, and folder paths without clicking a file', async () => {
    const transport = fixture([folder('src', [file('a')], true)]);
    await assert.rejects(selectMakeFile(transport, 'a'), /not found/);
    await assert.rejects(selectMakeFile(transport, '../a'), /project-relative/);
    await assert.rejects(selectMakeFile(transport, '/src/a'), /project-relative/);
    await assert.rejects(selectMakeFile(transport, 'src'), /is a folder/);
    assert.ok(!transport.clicks.some(path => path.endsWith('/a')));
  });

  it('bounds enumeration and transport waits', async () => {
    await assert.rejects(listMakeFiles(fixture([file('a'), file('b')]), { maxEntries: 1 }), /exceeds/);
    await assert.rejects(listMakeFiles({ evaluate: () => new Promise(() => {}) }, { timeoutMs: 5 }), /Timed out/);
    await assert.rejects(listMakeFiles(fixture([file('a')]), { maxEntries: 0 }), /maxEntries/);
  });

  it('does not report selection success without a selected aria-current row', async () => {
    const transport = fixture([file('a')], { rejectSelection: true });
    await assert.rejects(selectMakeFile(transport, 'a', { timeoutMs: 20 }), /Timed out/);
    assert.deepEqual(transport.clicks, ['a']);
  });
});

// A MakeClient whose VFS, sandbox bridge and rendered tree are fakes, so the
// real writeDurable/deleteDurable, _durableAgreement and _sourceTree run offline.
// After the VFS change every folder collapses, and Make applies `change` to the
// rendered tree while the next scan expands src/lib, so the guard refuses once.
function fakeMake(nodes, files, change) {
  const vfs = new Map(Object.entries(files));
  let pending = false;
  const transport = fixture(nodes, { clientHeight: 320, onAction(action, context) {
    if (pending && action.type === 'expand' && action.row?.name === 'lib') { pending = false; change(context); }
  } });
  const collapse = items => items.forEach(item => { if (item.kind === 'folder') { item.expanded = false; collapse(item.children); } });
  const client = new MakeClient({ transport: { close() {} }, timeoutMs: 5000 });
  client.fileKey = 'ScratchKey';
  client._operation = fn => fn(Date.now() + 5000);
  client._ensureCode = async () => ({ busy: false, offline: false, readOnly: false });
  client._driftState = async () => ({ state: { mode: 'git', hasBaseline: true, savedVersion: 'a'.repeat(40),
    pendingCount: 0, pendingPaths: [], isLoading: false, error: false } });
  client._treeTransport = () => transport;
  client._backup = async () => '/private/backup';
  client._read = async () => { throw Object.assign(new Error('Make shows no source editor.'), { code: 'MAKE_NO_EDITOR' }); };
  client._bridgeRead = async (_bridge, path) => {
    if (!vfs.has(path)) throw new Error('missing');
    return { content: vfs.get(path) };
  };
  client._fileBridge = async () => ({
    dispose: async () => {},
    invoke: async (_fn, [, { path }]) => {
      const prefix = path === 'code' ? '' : `${path.slice('code/'.length)}/`;
      const names = [...vfs.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length).split('/')[0]);
      return names.length ? { success: true, data: { path, files: [...new Set(names)].map(name => ({ name })) } } : null;
    },
  });
  client._durable = async action => {
    if (action.type === 'read') return { exists: vfs.has(action.path), content: vfs.get(action.path) };
    if (action.type === 'write') vfs.set(action.path, action.content);
    if (action.type === 'delete') vfs.delete(action.path);
    collapse(transport.nodes);
    pending = true;
    return { accepted: true };
  };
  return client;
}

describe('Make durable writes and deletes across a guarded tree refresh', () => {
  const hash = text => createHash('sha256').update(text).digest('hex');
  const tree = (...extra) => [folder('src', [folder('lib', [file('old.ts')]), ...extra])];

  it('writes a file whose new folder appears during a guarded expand', async () => {
    const client = fakeMake(tree(), { 'src/lib/old.ts': 'old' },
      ({ nodes }) => nodes[0].children.push(folder('field', [file('Input.tsx')])));
    const result = await client.writeDurable('src/field/Input.tsx', 'input');
    assert.equal(result.verification, 'tree-vfs-sandbox-matched');
  });

  it('refuses a write when an unrelated file appears with the new folder', async () => {
    const client = fakeMake(tree(), { 'src/lib/old.ts': 'old' },
      ({ nodes }) => nodes[0].children.push(folder('field', [file('Input.tsx')]), file('stray.ts')));
    await assert.rejects(client.writeDurable('src/field/Input.tsx', 'input'), /durable write outcome is uncertain: Make file tree changed before/);
  });

  it('deletes a file whose emptied folder disappears during a guarded expand', async () => {
    const client = fakeMake(tree(folder('field', [file('Input.tsx')])), { 'src/lib/old.ts': 'old', 'src/field/Input.tsx': 'input' },
      ({ nodes }) => nodes[0].children.splice(1, 1));
    const result = await client.deleteDurable('src/field/Input.tsx', { expectedSha256: hash('input') });
    assert.equal(result.verification, 'tree-vfs-sandbox-delete-matched');
  });

  it('refuses a delete when an unrelated file disappears with the emptied folder', async () => {
    const client = fakeMake(tree(folder('field', [file('Input.tsx')])), { 'src/lib/old.ts': 'old', 'src/field/Input.tsx': 'input' },
      ({ nodes }) => { nodes[0].children.splice(1, 1); nodes[0].children[0].children.splice(0, 1); });
    await assert.rejects(client.deleteDurable('src/field/Input.tsx', { expectedSha256: hash('input') }),
      /durable delete outcome is uncertain: Make file tree changed before/);
  });
});
