import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, chmod, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MakeTransport } from './make-transport.js';
import { listMakeFiles, selectMakeFile } from './make-tree.js';
import { watchMakeSave } from './make-save-observer.js';
import { validateImportFiles } from './make-import.js';
import { captureMakeFileSocket } from './make-rpc.js';
import { sessionOnly } from './make-session.js';
import { makeWorkspace, openMakeFilesTab } from './make-workspace.js';
import { makeUiSnapshot } from './make-ui.js';
import { makePersistenceState, makeVersionHistory } from './make-persistence.js';
import { compareVendor, digest, externalReceipt, sourcePath, vendorManifest, verifyGeneratedManifest } from './make-drift.js';
import { makeDurablePageAction, requireFirstVersionPending, requireGitMode, requireExactPending, TREE_HIDDEN_ROOT_FILES } from './make-durable.js';
import { gitBlobSha, isIgnored, parseIgnore } from './git-tree.js';
import { lfsMatcher, PROJECT_EXCLUDES, PROJECT_MARKER, treeOf, workingFlat } from './make-project.js';
import { SandboxGit } from './sandbox-git.js';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

// createVersion may have run: the caller must inspect, never retry the save.
function uncertainSave(message) {
  const error = new Error(message);
  error.createVersionCalled = true;
  return error;
}

// Make's pending state moved between the pre-check and the write, so nothing
// was written and the caller may retry once Make is idle again.
function pendingChanged(what) {
  const error = new Error(`Make version or pending files changed before the durable ${what}.`);
  error.code = 'MAKE_PENDING_CHANGED';
  return error;
}

function saveRequest(title, expectedPaths) {
  if (typeof title !== 'string' || !title.trim() || title.length > 160) throw new Error('Make version title must be 1–160 characters.');
  if (!Array.isArray(expectedPaths) || !expectedPaths.length || expectedPaths.length > 1000) throw new Error('Provide the exact expected changed-file set.');
  expectedPaths.forEach(sourcePath);
}
// Each CDP call has its own timeout (the transport's, 5 s by default), which a
// call carrying a whole file into the page can outlast: a 377 KB stylesheet
// write timed out live. Such a call gets 100 ms more per KiB it carries.
const payloadTimeout = bytes => 5000 + Math.ceil(bytes / 1024) * 100;

// How long a selected file may show no source editor before durable read-back
// uses the agreeing client VFS, sandbox and rendered tree instead.
const EDITOR_WAIT_MS = 3000;

// Serialized into the Make page, with no dependency on private application stores.
function makeEditorAction(action, workspace) {
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  let contentRoot = document;
  const allVisible = (selector) => [...contentRoot.querySelectorAll(selector)].filter(visible);
  const busy = allVisible('button[aria-label="Stop"], [data-testid="code-chat-send-button"]')
    .some((button) => button.getAttribute('aria-label') === 'Stop' || button.innerText?.trim() === 'Stop');
  const offline = /Some changes won[’']t be synced/i.test(document.body?.innerText || '');
  const context = workspace(action.type);
  contentRoot = context.root;
  const editors = allVisible('.cm-content');
  const selected = allVisible('[data-testid="code-file-item"][aria-current="page"]');
  const trees = allVisible('[data-testid="virtualized-file-tree-container"][role="tree"]');
  const ready = context.ready && trees.length === 1;
  // The Files workspace names the mounted editor's full path; the legacy layout names only its leaf.
  const editorPath = () => {
    if (context.mode !== 'files-workspace' || editors.length !== 1) return null;
    const crumbs = allVisible('[data-testid="files-workspace-header"] nav[aria-label="File path"]');
    const leaves = allVisible('[data-testid="files-workspace-selected-file"]');
    const parts = crumbs.length === 1 ? [...crumbs[0].children].filter(visible).filter(element => element.textContent?.trim()) : [];
    if (leaves.length !== 1 || parts.length < 2 || parts.at(-1) !== leaves[0]) return null;
    return parts.slice(1).map(element => element.textContent.trim()).join('/');
  };
  const summary = {
    url: location.href, title: document.title, codeReady: ready, workspaceMode: context.mode, editorCount: editors.length,
    readOnly: editors.length === 1 ? editors[0].cmView?.view?.state?.readOnly !== false : null,
    busy, offline,
    ...(context.needsFilesTab ? { needsFilesTab: true } : {}),
    selectedName: selected.length === 1 ? selected[0].closest('[role="treeitem"]')?.getAttribute('aria-label') : null,
    editorPath: editorPath(),
  };
  if (action.type === 'ensure-code' || action.type === 'inspect') return summary;
  // Source writes go through the filesystem bridge, never the editor.
  if (!['read', 'diagnostics'].includes(action.type)) throw new Error('Unknown Make editor action.');
  if (!ready) throw new Error('Make Code editor is not ready.');
  if (busy) throw new Error('Make is generating changes; wait until generation finishes.');
  if (offline) throw new Error('Make reports that some changes will not be synced.');
  if (editors.length !== 1) throw new Error('Expected exactly one visible Make source editor.');
  const contentElement = editors[0];
  const view = contentElement.cmView?.view;
  if (!view?.state?.doc || typeof view.state.doc.toString !== 'function' || typeof view.dispatch !== 'function') {
    throw new Error('Unsupported Make source editor.');
  }
  if (view.state.readOnly !== false || contentElement.getAttribute('contenteditable') !== 'true') {
    throw new Error('Make source editor is read-only.');
  }
  const entry = action.entry;
  if (selected.length !== 1) throw new Error('Make selected source file is absent or ambiguous.');
  const row = selected[0].closest('[role="treeitem"]');
  if (!row || row.getAttribute('aria-label') !== entry.name ||
      Number(row.getAttribute('aria-level')) !== entry.level ||
      !/^\d+(?:\.\d+)?px$/.test(row.style.top) || Number.parseFloat(row.style.top) !== entry.top ||
      selected[0].getAttribute('aria-label') !== `File "${entry.name}"`) {
    throw new Error('Make selected source file changed before the editor operation.');
  }
  const treeRows = [...trees[0].querySelectorAll('[role="treeitem"]')];
  if (!treeRows.includes(row) || !Array.isArray(entry.ancestors) || entry.ancestors.length !== entry.level - 1 ||
      [...entry.ancestors.map((ancestor) => ancestor.name), entry.name].join('/') !== entry.path) {
    throw new Error('Make source file ancestry is unavailable or changed.');
  }
  const rowTop = (element) => /^\d+(?:\.\d+)?px$/.test(element.style.top) ? Number.parseFloat(element.style.top) : NaN;
  for (const [index, expected] of entry.ancestors.entries()) {
    const matches = treeRows.filter((element) => rowTop(element) === expected.top);
    if (expected.kind !== 'folder' || expected.level !== index + 1 || expected.expanded !== true ||
        matches.length !== 1 || !visible(matches[0])) {
      throw new Error('Make source file ancestor is absent or changed; all ancestors must be rendered.');
    }
    const ancestor = matches[0];
    const folder = ancestor.querySelector('button[aria-label^="Folder "]');
    const expanded = ancestor.getAttribute('aria-expanded') ?? folder?.getAttribute('aria-expanded');
    const folderExpanded = folder?.getAttribute('aria-expanded');
    if (!folder || ancestor.querySelector('[data-testid="code-file-item"]') ||
        ancestor.getAttribute('aria-label') !== expected.name ||
        Number(ancestor.getAttribute('aria-level')) !== expected.level ||
        ancestor.getBoundingClientRect().height !== expected.height ||
        folder.getAttribute('aria-label') !== `Folder "${expected.name}"` || expanded !== 'true' ||
        (folderExpanded != null && folderExpanded !== expanded) ||
        treeRows.some((element) => rowTop(element) > expected.top && rowTop(element) < entry.top &&
          Number(element.getAttribute('aria-level')) <= expected.level)) {
      throw new Error('Make source file ancestor changed before the editor operation.');
    }
  }
  // A rendered root-to-leaf span must be contiguous. Otherwise an offscreen
  // intervening folder could change which path the identical leaf belongs to.
  if (entry.ancestors.length) {
    const firstTop = entry.ancestors[0].top;
    const span = treeRows.filter((element) => rowTop(element) >= firstTop && rowTop(element) <= entry.top)
      .sort((a, b) => rowTop(a) - rowTop(b));
    let bottom = firstTop;
    for (const element of span) {
      if (!visible(element) || Math.abs(rowTop(element) - bottom) > 1) {
        throw new Error('Make source file ancestry is incomplete in the rendered tree.');
      }
      bottom = rowTop(element) + element.getBoundingClientRect().height;
    }
  }
  if (context.mode === 'files-workspace') {
    const crumbs = allVisible('[data-testid="files-workspace-header"] nav[aria-label="File path"]');
    const leaves = allVisible('[data-testid="files-workspace-selected-file"]');
    const parts = crumbs.length === 1 ? [...crumbs[0].children].filter(visible).filter(element => element.textContent?.trim()) : [];
    if (leaves.length !== 1 || parts.at(-1) !== leaves[0] || leaves[0].textContent.trim() !== entry.name ||
        parts.length !== entry.path.split('/').length + 1 || parts.slice(1).map(element => element.textContent.trim()).join('/') !== entry.path) {
      throw new Error('Make Files workspace breadcrumb does not match the selected source path.');
    }
  } else {
    const headings = allVisible('h2 input[data-testid="code-file-name-input"]');
    if (headings.length !== 1 || headings[0].value !== entry.name) {
      throw new Error('Make editor heading does not match the selected source file.');
    }
  }
  const original = view.state.doc.toString();
  if (action.type === 'diagnostics') {
    if (original !== action.original) throw new Error('Make source changed while waiting for diagnostics.');
    const fields = (view.state.values || []).filter(value => value?.diagnostics && typeof value.diagnostics.between === 'function');
    const diagnostics = [];
    const seen = new Set();
    for (const field of fields) field.diagnostics.between(0, original.length, (from, to, value) => {
      const entries = value.spec?.diagnostics || (value.spec?.diagnostic ? [value.spec.diagnostic] : []);
      for (const entry of entries) {
        if (typeof entry.message !== 'string') continue;
        const item = { from, to, line: original.slice(0, from).split('\n').length,
          severity: entry.severity, message: entry.message };
        const key = JSON.stringify(item);
        if (!seen.has(key)) { seen.add(key); diagnostics.push(item); }
      }
    });
    return { available: fields.length > 0, diagnostics };
  }
  return { content: original };
}

function guardExpression(fileKey, expression) {
  return `(async () => {
    const url = new URL(location.href);
    const match = url.pathname.match(/^\\/make\\/([A-Za-z0-9_-]+)(?:\\/|$)/);
    if (url.protocol !== 'https:' || !['figma.com', 'www.figma.com'].includes(url.hostname) ||
        url.username || url.password || url.port || !match || match[1] !== ${JSON.stringify(fileKey)}) {
      throw new Error('Make tab no longer matches the requested file key.');
    }
    return (${expression});
  })()`;
}

async function writePrivateFile(path, content) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Source editing through the observed Make Code UI, isolated from Design. */
export class MakeClient {
  constructor({ transport = new MakeTransport(), timeoutMs = 15000, maxEntries = 10000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
      throw new Error('Make timeoutMs must be between 1 and 120000.');
    }
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.maxEntries = maxEntries;
    this.fileKey = null;
    this._running = false;
  }

  async connect(fileKeyOrURL) {
    await this.transport.connect(fileKeyOrURL, { timeoutMs: this.timeoutMs });
    this.fileKey = this.transport.target?.fileKey;
    if (!this.fileKey) {
      this.transport.close();
      throw new Error('Make connection did not identify an exact file key.');
    }
    return this;
  }

  _remaining(deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Make operation timed out.');
    return remaining;
  }

  async _bounded(operation, deadline) {
    const remaining = this._remaining(deadline);
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Make operation timed out.')), remaining); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // `bytes` is the size the call returns, when larger than what it sends;
  // never past the operation's deadline.
  async _evaluate(expression, deadline, { bytes = 0 } = {}) {
    const timeoutMs = Math.min(this._remaining(deadline), Math.max(this.transport.timeoutMs || 0, payloadTimeout(Math.max(expression.length, bytes))));
    return this._bounded(() => this.transport.evaluate(guardExpression(this.fileKey, expression), { timeoutMs }), deadline);
  }

  // A read returns a whole file of unknown size, so it may take the
  // operation's remaining time; reads change nothing.
  _editor(action, deadline) {
    return this._evaluate(`(${makeEditorAction.toString()})(${JSON.stringify(action)}, (${makeWorkspace.toString()}))`, deadline,
      { bytes: action.type === 'read' ? Infinity : 0 });
  }

  async _operation(callback) {
    if (!this.fileKey) throw new Error('Make client is not connected.');
    if (this._running) throw new Error('A Make operation is already running on this client.');
    this._running = true;
    const deadline = Date.now() + this.timeoutMs;
    // Hidden Desktop tabs do not update their virtualized tree. Temporarily
    // emulate focus in this renderer and reserve time to restore it, without
    // moving OS focus or extending the operation's total timeout.
    const cleanupBudget = Math.min(1000, Math.max(1, Math.floor(this.timeoutMs / 10)));
    const workDeadline = deadline - cleanupBudget;
    let result;
    let operationError;
    try {
      // A hidden Make page reconnects its agent socket when focus emulation
      // starts. Arm the passive capture first so that reconnect identifies the
      // filesystem socket. Best effort: commands that need the bridge report
      // its absence themselves.
      try {
        await this._evaluate(`(() => { (${captureMakeFileSocket.toString()})(${JSON.stringify(this.fileKey)}, null, 1000, ${Math.min(10000, this.timeoutMs)}); return true; })()`, workDeadline);
      } catch {}
      await this._bounded(() => this.transport.send('Emulation.setFocusEmulationEnabled', { enabled: true }, {
        timeoutMs: this._remaining(workDeadline),
      }), workDeadline);
      result = await callback(workDeadline);
    } catch (error) {
      operationError = error;
    } finally {
      try {
        // Also disable after a failed enable: its response may have been lost
        // after the renderer applied it. This never retries the source write.
        const cleanupDeadline = Math.min(deadline, Date.now() + cleanupBudget);
        await this._bounded(() => this.transport.send('Emulation.setFocusEmulationEnabled', { enabled: false }, {
          timeoutMs: this._remaining(cleanupDeadline),
        }), cleanupDeadline);
      } catch (error) {
        const note = `Temporary Make focus emulation could not be disabled: ${error.message}`;
        if (operationError) operationError.message += ` ${note}`;
        else {
          operationError = new Error(`Make operation completed. ${note}`);
          if (result?.backupPath) {
            operationError.backupPath = result.backupPath;
            operationError.message += ` Original backup: ${result.backupPath}.`;
          }
          if (result?.versionId) {
            operationError.version = result;
            operationError.message += ` Make version ${result.versionNumber} (${result.gitSha}) was created; do not retry the save.`;
          }
        }
      } finally {
        this._running = false;
      }
    }
    if (operationError) throw operationError;
    return result;
  }

  async _ensureCode(deadline) {
    let state = await this._editor({ type: 'ensure-code' }, deadline);
    if (state.needsFilesTab) await this._evaluate(`(${openMakeFilesTab.toString()})(${Math.min(1000, this._remaining(deadline))})`, deadline);
    while (!state.codeReady) {
      await this._bounded(() => new Promise((resolve) => setTimeout(resolve, 50)), deadline);
      state = await this._editor({ type: 'inspect' }, deadline);
    }
    return state;
  }

  _treeTransport(deadline) {
    return { evaluate: (expression) => this._evaluate(expression, deadline) };
  }

  async _select(path, deadline) {
    await this._ensureCode(deadline);
    return this._bounded(() => selectMakeFile(this._treeTransport(deadline), path, {
      timeoutMs: this._remaining(deadline), maxEntries: this.maxEntries,
    }), deadline);
  }

  // Make renders some files, such as Markdown, as a preview with no source
  // editor. With editorWaitMs, a selected file whose editor has not appeared
  // by then is reported as MAKE_NO_EDITOR instead of waiting for the deadline.
  async _read(path, deadline, { editorWaitMs } = {}) {
    const entry = await this._select(path, deadline);
    const editorDeadline = editorWaitMs == null ? deadline : Math.min(deadline, Date.now() + editorWaitMs);
    let state = await this._editor({ type: 'inspect' }, deadline);
    while (state.editorCount === 0) {
      if (Date.now() >= editorDeadline && editorDeadline < deadline) {
        const error = new Error(`Make shows no source editor for ${path}.`);
        error.code = 'MAKE_NO_EDITOR';
        throw error;
      }
      await this._bounded(() => new Promise(resolve => setTimeout(resolve, 50)), deadline);
      state = await this._editor({ type: 'inspect' }, deadline);
    }
    const { content } = await this._editor({ type: 'read', entry }, deadline);
    return { entry, content, sha256: sha256(content) };
  }

  inspect() {
    return this._operation(async (deadline) => ({ fileKey: this.fileKey, ...await this._ensureCode(deadline) }));
  }

  // A cheap probe for waiting until Make is idle: the editor flags, the
  // persistence state and the client-VFS hash of each named path.
  idleState(paths = []) {
    return this._operation(async deadline => {
      const ui = await this._ensureCode(deadline);
      const state = (await this._driftState(deadline)).state;
      const sha = {};
      for (const path of paths) {
        const entry = await this._durable({ type: 'read', path: sourcePath(path) }, deadline);
        sha[path] = entry?.exists ? sha256(entry.content) : null;
      }
      return { busy: !!ui.busy, offline: !!ui.offline, state, sha };
    });
  }

  ui() {
    return this._operation(async deadline => ({ fileKey: this.fileKey,
      ...await this._evaluate(`(${makeUiSnapshot.toString()})()`, deadline) }));
  }

  diagnostics(path) {
    return this._operation(async deadline => {
      const { entry, content, sha256: hash } = await this._read(path, deadline);
      // Selecting a file starts a language-server request; avoid reporting the
      // initial empty lint state as if it were a completed response.
      await this._bounded(() => new Promise(resolve => setTimeout(resolve, 1000)), deadline);
      const result = await this._editor({ type: 'diagnostics', entry, original: content }, deadline);
      return { fileKey: this.fileKey, path, sha256: hash, ...result };
    });
  }

  preview() {
    return this._operation(async deadline => {
      const contexts = new Map();
      let attachedSession;
      const unsubscribe = this.transport.onEvent(({ method, params }) => {
        if (method === 'Runtime.executionContextCreated' && params.context?.auxData?.isDefault) {
          contexts.set(params.context.auxData.frameId, params.context.id);
        }
      });
      try {
        await this.transport.send('Runtime.enable');
        await this._evaluate(`(() => { (${makeWorkspace.toString()})('ensure-preview'); return true; })()`, deadline);
        await this._bounded(() => new Promise(resolve => setTimeout(resolve, 1200)), deadline);
        const tree = await this.transport.send('Page.getFrameTree');
        const frames = [];
        const visit = node => { if (!node) return; frames.push(node.frame); node.childFrames?.forEach(visit); };
        visit(tree.frameTree);
        const previews = frames.filter(frame => {
          try { const url = new URL(frame.url); return url.protocol === 'https:' && /\.makeproxy-[a-z]+\.figma\.site$/.test(url.hostname); }
          catch { return false; }
        });
        const contextId = previews.length === 1 ? contexts.get(previews[0].id) : undefined;
        if (!contextId) {
          const urls = await this._evaluate(`([...document.querySelectorAll('iframe')].map(el=>el.src).filter(value => { try { return /\\.makeproxy-[a-z]+\\.figma\\.site$/.test(new URL(value).hostname); } catch { return false; } }))`, deadline);
          if (urls.length !== 1) throw new Error('Exact Make preview iframe is unavailable.');
          const targets = await this.transport.send('Target.getTargets');
          const matching = targets.targetInfos.filter(target => target.type === 'iframe' && target.url === urls[0]);
          if (matching.length !== 1) throw new Error('Exact isolated Make preview target is unavailable.');
          attachedSession = (await this.transport.send('Target.attachToTarget', { targetId: matching[0].targetId, flatten: true })).sessionId;
        }
        const expression = `(() => ({ url: location.origin + location.pathname,
          title: document.title, readyState: document.readyState,
          headings: [...document.querySelectorAll('h1,h2,h3')].map(el => el.textContent),
          text: document.body.innerText.slice(0, 12000),
          errorOverlay: [...document.querySelectorAll('vite-error-overlay')].map(el => el.shadowRoot?.textContent || el.textContent),
          width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          height: innerHeight, scrollHeight: document.documentElement.scrollHeight,
          regions: [...document.querySelectorAll('[data-panel], [role="tablist"], [role="tabpanel"]')].map(el => {
            const rect = el.getBoundingClientRect();
            return { id: el.id, role: el.getAttribute('role'), label: el.getAttribute('aria-label'),
              x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
          }),
          buttons: [...document.querySelectorAll('button')].map(el => ({ text: el.textContent, disabled: el.disabled })),
          controls: document.querySelectorAll('input,select,textarea,[role="switch"],[role="combobox"]').length
        }))()`;
        const result = await this.transport.send('Runtime.evaluate', {
          ...(contextId ? { contextId } : {}), expression, returnByValue: true,
        }, { timeoutMs: this._remaining(deadline), sessionId: attachedSession });
        if (result.exceptionDetails) throw new Error('Could not read Make preview.');
        return { fileKey: this.fileKey, ...result.result.value };
      } finally { unsubscribe(); if (attachedSession) await this.transport.send('Target.detachFromTarget', { sessionId: attachedSession }); }
    });
  }

  files() {
    return this._operation(async (deadline) => {
      await this._ensureCode(deadline);
      return this._bounded(() => listMakeFiles(this._treeTransport(deadline), {
        timeoutMs: this._remaining(deadline), maxEntries: this.maxEntries,
      }), deadline);
    });
  }

  // The session's working copy through the filesystem bridge; the editor is only a fallback
  // when no filesystem connection can be observed, and never for --remote.
  read(path, { remote = false } = {}) {
    return this._operation(async (deadline) => {
      validateImportFiles([{ path, content: '' }]);
      await this._ensureCode(deadline);
      const existing = await listMakeFiles(this._treeTransport(deadline), {
        timeoutMs: this._remaining(deadline), maxEntries: this.maxEntries,
      });
      if (!path.startsWith('node_modules/') && !existing.some(entry => entry.kind === 'file' && entry.path === path)) {
        throw new Error(`Make source file is missing: ${path}`);
      }
      let bridge;
      try {
        bridge = await this._fileBridge(deadline);
      } catch (error) {
        if (remote || error.code !== 'MAKE_FILESYSTEM_UNAVAILABLE' || path.startsWith('node_modules/')) throw error;
        const result = await this._read(path, deadline, { editorWaitMs: EDITOR_WAIT_MS }).catch(cause => {
          if (cause.code === 'MAKE_NO_EDITOR') cause.message += ' The filesystem bridge is unavailable, so it cannot be read; retry.';
          throw cause;
        });
        return { fileKey: this.fileKey, path, content: result.content, sha256: result.sha256, source: 'editor' };
      }
      try {
        const { content } = await this._bridgeRead(bridge, path);
        return { fileKey: this.fileKey, path, content, sha256: sha256(content), source: 'filesystem' };
      } finally { await bridge.dispose(); }
    });
  }

  async _bridgeRead(bridge, path) {
    const bytes = await this._bridgeReadBytes(bridge, path);
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { content, base64: bytes.toString('base64') };
  }

  async _bridgeReadBytes(bridge, path) {
    const reply = await bridge.invoke('function(type, data, id) { return this.request(type, data, id); }', [
      'fs/file/read', { path: `code/${path}`, encoding: 'base64' }, randomUUID(),
    ]);
    if (!reply?.success || reply.data?.path !== `code/${path}` || reply.data?.encoding !== 'base64' || typeof reply.data?.content !== 'string') {
      throw new Error(`Make remote source read failed: ${path}`);
    }
    const bytes = Buffer.from(reply.data.content, 'base64');
    if (bytes.toString('base64') !== reply.data.content) throw new Error('Invalid remote source encoding');
    return bytes;
  }

  async _driftState(deadline) {
    const scan = await this._evaluate(`(${makePersistenceState.toString()})()`, deadline);
    const state = scan?.state;
    if (!state || state.ambiguous || !['git', 'snapshot'].includes(state.mode) ||
        state.pendingCount == null) return { state: null };
    return { state };
  }

  _durable(action, deadline) {
    return this._evaluate(`(${makeDurablePageAction.toString()})(${JSON.stringify(action)})`, deadline,
      { bytes: action.type === 'read' ? Infinity : 0 });
  }

  _sourceTree(deadline, expectedChange, onSnapshot) {
    return listMakeFiles(this._treeTransport(deadline), {
      timeoutMs: this._remaining(deadline), maxEntries: this.maxEntries, expectedChange, onSnapshot,
    });
  }

  // Absence is proven by listing an existing ancestor folder, never the project
  // root (only make status lists it). Refuse before changing anything when the
  // nearest listable ancestor would be the root.
  async _requireListableAncestor(path, deadline) {
    const [top, ...rest] = path.split('/');
    if (!rest.length || (!top.startsWith('.') && !(await this._sourceTree(deadline))
      .some(entry => entry.kind === 'folder' && entry.path === top))) {
      throw new Error(`Make cannot prove ${path} absent: only files below an existing top-level folder can be created or deleted.`);
    }
  }

  // Returns which independent views agreed. On timeout, the error names the
  // last state of each view instead of a bare timeout.
  async _durableAgreement(path, expectedContent, deadline, { treeState, expectedChange } = {}) {
    const hidden = path.split('/').some(part => part.startsWith('.')) || TREE_HIDDEN_ROOT_FILES.includes(path);
    let observed = null;
    let editorDisagreed = false;
    try {
      for (;;) {
        const vfs = await this._durable({ type: 'read', path }, deadline);
        const bridge = await this._fileBridge(deadline);
        let sandbox;
        let absentInSandbox = false;
        try {
          if (expectedContent === null) {
            const segments = path.split('/');
            for (let depth = segments.length - 1; depth >= 0; depth--) {
              const remotePath = ['code', ...segments.slice(0, depth)].join('/');
              // Make never answers a listing of a missing directory; try the parent.
              const listing = await bridge.invoke('function(type, data, id) { return this.request(type, data, id); }', [
                'fs/dir/list', { path: remotePath, includeHidden: true }, randomUUID(),
              ]).catch(() => null);
              if (listing?.success === true && listing.data?.path === remotePath && Array.isArray(listing.data.files)) {
                absentInSandbox = !listing.data.files.some(entry => entry?.name === segments[depth]);
                break;
              }
            }
          } else sandbox = await this._bridgeRead(bridge, path).catch(() => null);
        }
        finally { await bridge.dispose(); }
        const tree = await this._sourceTree(deadline, expectedChange, treeState
          ? snapshot => { treeState.entries = snapshot.entries; treeState.rows = snapshot.rows; } : undefined);
        const inTree = tree.some(entry => entry.kind === 'file' && entry.path === path);
        if (expectedContent === null) {
          observed = { vfs: vfs.exists ? 'present' : 'absent', sandbox: absentInSandbox ? 'absent' : 'present or unlisted',
            tree: inTree ? 'present' : 'absent' };
          if (!vfs.exists && absentInSandbox && !inTree) return 'tree-vfs-sandbox-delete-matched';
        } else {
          const view = (exists, content) => !exists ? 'absent' : content === expectedContent ? 'matched' : 'different';
          observed = { vfs: view(vfs.exists, vfs.content), sandbox: sandbox ? view(true, sandbox.content) : 'unreadable',
            tree: inTree ? 'present' : hidden ? 'omits hidden files' : 'absent' };
          if (observed.vfs === 'matched' && observed.sandbox === 'matched' && (inTree || hidden)) {
            // Make's rendered tree deliberately omits dotfiles and root lockfiles. VFS and sandbox
            // agreement is the available independent proof for those paths.
            if (hidden) return 'vfs-sandbox-matched';
            // Make need not mount an editor for a file that is not open. If it
            // does mount one, its bytes must also agree. Deep paths may be
            // listed in the tree even when the viewport cannot select them;
            // they fall back only while the mounted editor provably shows
            // another path.
            try {
              const editor = await this._read(path, deadline, { editorWaitMs: EDITOR_WAIT_MS });
              observed.editor = editor.content === expectedContent ? 'matched' : 'different';
              if (observed.editor === 'matched') return 'editor-tree-vfs-sandbox-matched';
              editorDisagreed = true;
            } catch (error) {
              if (!editorDisagreed && error.code === 'MAKE_NO_EDITOR') return 'tree-vfs-sandbox-matched';
              if (!editorDisagreed && error.code === 'MAKE_TREE_VIEWPORT') {
                const editor = await this._editor({ type: 'inspect' }, deadline);
                if (editor.editorCount === 0 || (editor.editorPath && editor.editorPath !== path)) {
                  return 'tree-vfs-sandbox-matched';
                }
              }
              observed.editor = editorDisagreed ? 'different' : 'unavailable';
            }
          }
        }
        await this._bounded(() => new Promise(resolve => setTimeout(resolve, 100)), deadline);
      }
    } catch (cause) {
      if (!observed || cause.message !== 'Make operation timed out.') throw cause;
      const views = Object.entries(observed).map(([name, value]) => `${name} ${value}`).join(', ');
      throw new Error(`Make read-back for ${path} timed out before every view agreed (${views}).`);
    }
  }

  // A path's content in Make's client VFS: { exists, content }.
  readDurable(path) {
    sourcePath(path);
    return this._operation(deadline => this._durable({ type: 'read', path }, deadline));
  }

  // rewrite: write even when Make already holds this content, so Make's client
  // owns it (createVersion skips a lockfile only Make's install rewrote).
  writeDurable(path, content, { expectedSha256, firstVersion = false, rewrite = false, backupDir = join(homedir(), '.figma-cli', 'make-backups') } = {}) {
    sourcePath(path);
    if (typeof content !== 'string') throw new Error('Make durable write requires UTF-8 text.');
    if (expectedSha256 != null && !/^[a-fA-F0-9]{64}$/.test(expectedSha256)) throw new Error('Invalid expected SHA-256.');
    return this._operation(async deadline => {
      const ui = await this._ensureCode(deadline);
      if (ui.busy || ui.offline || ui.readOnly === true) throw new Error('Make editor is busy, offline or read-only.');
      const before = requireGitMode((await this._driftState(deadline)).state, { firstVersion });
      const existing = await this._durable({ type: 'read', path }, deadline);
      if (existing.exists !== (expectedSha256 != null)) throw new Error('Expected SHA-256 is required for an existing file and forbidden for a new file.');
      const originalSha256 = existing.exists ? sha256(existing.content) : null;
      if (existing.exists && originalSha256 !== expectedSha256.toLowerCase()) throw new Error('Make source changed; SHA-256 does not match.');
      if (!existing.exists) await this._requireListableAncestor(path, deadline);
      const treeState = {};
      await this._durableAgreement(path, existing.exists ? existing.content : null, deadline, { treeState });
      if (existing.exists && existing.content === content && !rewrite) return { fileKey: this.fileKey, path, changed: false, sha256: originalSha256, verification: 'unchanged' };
      const backupPath = existing.exists ? await this._bounded(() => this._backup(path, existing.content, {
        backupDir, operation: 'durable-write', replacementSha256: sha256(content),
      }), deadline) : null;
      const immediate = requireGitMode((await this._driftState(deadline)).state, { firstVersion });
      if (immediate.savedVersion !== before.savedVersion || JSON.stringify(immediate.pendingPaths) !== JSON.stringify(before.pendingPaths)) {
        throw pendingChanged('write');
      }
      let verification;
      try {
        const accepted = await this._durable({ type: 'write', path, content, expectedContent: existing.exists ? existing.content : null }, deadline);
        if (accepted?.refused) throw new Error(accepted.refused);
        const expectedChange = !existing.exists && !path.split('/').some(part => part.startsWith('.')) &&
          !TREE_HIDDEN_ROOT_FILES.includes(path)
          ? { beforeEntries: treeState.entries, beforeRows: treeState.rows, writtenPath: path } : undefined;
        verification = await this._durableAgreement(path, content, deadline, { expectedChange });
      } catch (cause) {
        const error = new Error(`Make durable write outcome is uncertain: ${cause.message}. Inspect before retrying.`);
        error.backupPath = backupPath;
        throw error;
      }
      return { fileKey: this.fileKey, path, changed: true, beforeSha256: originalSha256,
        sha256: sha256(content), bytes: Buffer.byteLength(content), backupPath,
        verification, persistence: 'pending-version' };
    });
  }

  deleteDurable(path, { expectedSha256, firstVersion = false, backupDir = join(homedir(), '.figma-cli', 'make-backups') } = {}) {
    sourcePath(path);
    if (!/^[a-fA-F0-9]{64}$/.test(expectedSha256 || '')) throw new Error('Make durable delete requires expected SHA-256.');
    return this._operation(async deadline => {
      const ui = await this._ensureCode(deadline);
      if (ui.busy || ui.offline || ui.readOnly === true) throw new Error('Make editor is busy, offline or read-only.');
      const before = requireGitMode((await this._driftState(deadline)).state, { firstVersion });
      const original = await this._durable({ type: 'read', path }, deadline);
      if (!original.exists || sha256(original.content) !== expectedSha256.toLowerCase()) throw new Error('Make source is missing or changed; delete refused.');
      await this._requireListableAncestor(path, deadline);
      await this._durableAgreement(path, original.content, deadline);
      const backupPath = await this._bounded(() => this._backup(path, original.content, { backupDir, operation: 'durable-delete' }), deadline);
      const immediate = requireGitMode((await this._driftState(deadline)).state, { firstVersion });
      if (immediate.savedVersion !== before.savedVersion || JSON.stringify(immediate.pendingPaths) !== JSON.stringify(before.pendingPaths)) {
        throw pendingChanged('delete');
      }
      try {
        const accepted = await this._durable({ type: 'delete', path, expectedContent: original.content }, deadline);
        if (accepted?.refused) throw new Error(accepted.refused);
        await this._durableAgreement(path, null, deadline);
      } catch (cause) {
        const error = new Error(`Make durable delete outcome is uncertain: ${cause.message}. Inspect before retrying.`);
        error.backupPath = backupPath;
        throw error;
      }
      return { fileKey: this.fileKey, path, beforeSha256: sha256(original.content), backupPath,
        verification: 'tree-vfs-sandbox-delete-matched', persistence: 'pending-version' };
    });
  }

  // Make does not list these paths as pending, so their bytes are captured
  // from both the client VFS and the session sandbox, which must agree.
  async _unlistedSnapshot(paths, deadline) {
    if (!paths.length) return [];
    const files = [];
    const bridge = await this._fileBridge(deadline);
    try {
      for (const path of paths) {
        const vfs = await this._durable({ type: 'read', path }, deadline);
        const sandbox = await this._bridgeRead(bridge, path);
        if (!vfs.exists || vfs.content !== sandbox.content) {
          throw new Error(`Make client VFS and sandbox disagree for unlisted path ${path}.`);
        }
        files.push({ path, sha256: sha256(vfs.content) });
      }
    } finally { await bridge.dispose(); }
    return files;
  }

  saveVersion(title, expectedPaths) {
    saveRequest(title, expectedPaths);
    return this._operation(async deadline => {
      const ui = await this._ensureCode(deadline);
      if (ui.busy || ui.offline || ui.readOnly === true) throw new Error('Make editor is busy, offline or read-only.');
      const before = requireGitMode((await this._driftState(deadline)).state);
      const { listed: changedFiles, unlisted } = requireExactPending(before, expectedPaths);
      const unlistedFiles = await this._unlistedSnapshot(unlisted, deadline);
      let version;
      try { version = await this._durable({ type: 'save', title, expectedPaths: changedFiles, expectedGitSha: before.savedVersion }, deadline); }
      catch (cause) { throw new Error(`Make version outcome is uncertain: ${cause.message}. Inspect versions before retrying.`); }
      if (version?.refused) throw new Error(version.refused);
      if (typeof version?.id !== 'string' || !version.id || !Number.isSafeInteger(version.versionNumber) ||
          !/^[a-f0-9]{40}$/.test(version.gitSha || '')) throw new Error('Make version response is incomplete; inspect versions before retrying.');
      const saved = { fileKey: this.fileKey, title, versionId: version.id, versionNumber: version.versionNumber,
        gitSha: version.gitSha, previousGitSha: before.savedVersion, changedFiles,
        ...(unlistedFiles.length ? { unlistedFiles } : {}) };
      try {
        for (;;) {
          const after = (await this._driftState(deadline)).state;
          if (after?.mode === 'git' && after.hasBaseline && !after.isLoading && !after.error &&
              after.savedVersion === version.gitSha && after.pendingCount === 0) break;
          await this._bounded(() => new Promise(resolve => setTimeout(resolve, 100)), deadline);
        }
        if (!unlistedFiles.length) return { ...saved, verification: 'saved-version-clean-pending' };
        const afterUnlisted = await this._unlistedSnapshot(unlisted, deadline);
        if (JSON.stringify(afterUnlisted) !== JSON.stringify(unlistedFiles)) {
          throw new Error(`unlisted files changed across the save: ${unlisted.join(', ')}`);
        }
        return { ...saved, verification: 'saved-version-clean-pending; unlisted-post-save-read-matched' };
      } catch (cause) {
        const error = new Error(`Make version ${version.versionNumber} (${version.gitSha}) was created but the clean baseline or unlisted-file read-back was not observed: ${cause.message}. Do not retry the save.`);
        error.version = saved;
        throw error;
      }
    });
  }

  // The first version of a git-mode file that has never been saved. Make lists
  // no pending files without a baseline, and its sandbox commits every write,
  // so the expected set is checked against the working copy's difference from
  // `since`, a sandbox commit the caller read before writing. The saved tree
  // must equal the working tree that check read.
  saveFirstVersion(title, expectedPaths, { since } = {}) {
    return this.saveCheckedVersion(title, expectedPaths, { firstVersion: true, since });
  }

  // Save a version whose content is checked as a tree, not through Make's
  // pending list. Make lists no pending files before its first version, and it
  // never lists paths under a dot folder such as .figma-cli/ (scratch probe,
  // 2026-10-14). The expected set must equal the working copy's difference
  // from the base: the saved version's tree, or with firstVersion the `since`
  // sandbox commit. Make must list nothing pending, and the saved tree must
  // equal the working tree this check read. With `listed` (deploy), Make may
  // list pending paths, but only expected ones; createVersion is then given
  // exactly the set Make lists, and the tree check still covers every path.
  async saveCheckedVersion(title, expectedPaths, { firstVersion = false, since, listed = false } = {}) {
    saveRequest(title, expectedPaths);
    if (firstVersion && !/^[a-f0-9]{40}$/.test(since || '')) {
      throw new Error('--first-version requires --since <commit>: the sandbox head make status reported before the writes.');
    }
    const before = await this.projectStatus();
    const state = requireGitMode(before.persistence, { firstVersion });
    if (firstVersion && before.treeSource !== 'sandbox-head') throw new Error('Make sandbox HEAD was not the comparison base; first version refused.');
    if (!firstVersion) {
      if (before.treeSource !== 'saved-version') throw new Error('Make saved version was not the comparison base; version refused.');
      const others = listed ? state.pendingPaths.filter(path => !expectedPaths.includes(path)) : state.pendingPaths;
      if (others.length) {
        throw new Error(`Make lists other pending changes; expected ${listed ? 'only the expected paths' : 'none'}, found ${JSON.stringify(others)}.`);
      }
    }
    const baseFlat = !firstVersion ? before.makeFlat : await this._operation(async deadline => {
      const bridge = await this._fileBridge(deadline);
      try {
        const reader = this._sandboxGit(bridge);
        if (!await reader.reaches(before.head, since)) {
          throw new Error(`Commit ${since} is not in the sandbox history of HEAD ${before.head}; first version refused.`);
        }
        return await reader.flatten(await reader.commitTree(since));
      } finally { await bridge.dispose(); }
    });
    const changedFiles = requireFirstVersionPending(baseFlat, before.workingFlat, expectedPaths);
    const version = await this._operation(async deadline => {
      const ui = await this._ensureCode(deadline);
      if (ui.busy || ui.offline || ui.readOnly === true) throw new Error('Make editor is busy, offline or read-only.');
      const now = requireGitMode((await this._driftState(deadline)).state, { firstVersion });
      if (JSON.stringify(now) !== JSON.stringify(state)) throw new Error(`Make state changed before the ${firstVersion ? 'first ' : ''}version.`);
      const bridge = await this._fileBridge(deadline);
      try {
        if (await this._sandboxGit(bridge).head() !== before.head) throw new Error(`Make sandbox HEAD changed before the ${firstVersion ? 'first ' : ''}version.`);
      } finally { await bridge.dispose(); }
      let created;
      try {
        created = await this._durable({ type: 'save', ...(firstVersion ? { firstVersion: true } : {}), title,
          expectedPaths: listed ? state.pendingPaths : [],
          expectedGitSha: firstVersion ? null : state.savedVersion }, deadline);
      }
      catch (cause) { throw uncertainSave(`Make version outcome is uncertain: ${cause.message}. Inspect versions before retrying.`); }
      if (created?.refused) throw new Error(created.refused);
      if (typeof created?.id !== 'string' || !created.id || !Number.isSafeInteger(created.versionNumber) ||
          !/^[a-f0-9]{40}$/.test(created.gitSha || '')) throw uncertainSave('Make version response is incomplete; inspect versions before retrying.');
      return created;
    });
    const saved = { fileKey: this.fileKey, title, ...(firstVersion ? { firstVersion: true } : {}), versionId: version.id,
      versionNumber: version.versionNumber, gitSha: version.gitSha, previousGitSha: firstVersion ? null : state.savedVersion,
      ...(firstVersion ? { since } : {}), sandboxHead: before.head, changedFiles, workingTree: before.workingTree };
    try {
      await this._operation(async deadline => {
        for (;;) {
          const after = (await this._driftState(deadline)).state;
          if (after?.mode === 'git' && after.hasBaseline && !after.isLoading && !after.error &&
              after.savedVersion === version.gitSha && after.pendingCount === 0) return;
          await this._bounded(() => new Promise(resolve => setTimeout(resolve, 100)), deadline);
        }
      });
      const after = await this.projectStatus();
      if (after.treeSource !== 'saved-version' || after.persistence?.savedVersion !== version.gitSha) {
        throw new Error('the saved version is not the baseline Make reports');
      }
      // A deploy compares content: listing exposes no file mode, so a file
      // Make rewrote itself (its own reinstall of pnpm-lock.yaml) can keep
      // 100755 where the working tree guessed 100644 (scratch, 2026-10-15).
      const contentDiffers = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter(path => a.get(path)?.blob !== b.get(path)?.blob);
      const differs = listed
        ? contentDiffers(after.makeFlat, before.workingFlat).length || contentDiffers(after.workingFlat, after.makeFlat).length
        : after.makeTree !== before.workingTree || after.workingTree !== after.makeTree;
      if (differs) throw new Error(`saved tree ${after.makeTree} differs from the checked working tree ${before.workingTree}`);
      const modeOnly = listed ? [...after.makeFlat].filter(([path, entry]) => before.workingFlat.get(path)?.mode !== entry.mode).map(([path]) => path).sort() : [];
      return { ...saved, tree: after.makeTree, ...(modeOnly.length ? { modeOnly } : {}),
        verification: `${firstVersion ? 'first-version' : 'saved-version'}-clean-baseline; saved-${listed ? 'content' : 'tree'}-matched` };
    } catch (cause) {
      const error = new Error(`Make version ${version.versionNumber} (${version.gitSha}) was created but its baseline or tree was not verified: ${cause.message}. Do not retry the save.`);
      error.version = saved;
      throw error;
    }
  }

  // Reload only this Make tab, then wait for the new document's Make state:
  // what a later session sees, rather than this page's in-memory copy.
  reloadPage() {
    return this._operation(async deadline => {
      const nonce = randomUUID();
      await this._evaluate(`(() => { window.__figmaCliReload = ${JSON.stringify(nonce)}; return true; })()`, deadline);
      await this._bounded(() => this.transport.send('Page.reload', {}, { timeoutMs: this._remaining(deadline) }), deadline);
      for (;;) {
        await this._bounded(() => new Promise(resolve => setTimeout(resolve, 250)), deadline);
        let state = null;
        try {
          const fresh = await this._evaluate(`window.__figmaCliReload !== ${JSON.stringify(nonce)} && document.readyState === 'complete'`, deadline);
          if (fresh === true) state = (await this._driftState(deadline)).state;
        } catch (error) {
          // The old document's context is destroyed while the page navigates.
          if (error.message === 'Make operation timed out.') throw error;
        }
        if (state && !state.isLoading && !state.error) return { reloaded: true, persistence: state };
      }
    });
  }

  // Bound each renderer/socket batch independently. Large kits can take more
  // than one command timeout in total, but no Runtime.callFunctionOn owns the
  // whole tree. Version/pending state is checked at every batch boundary.
  async inventoryVendor(root = 'src/vendor/atomic-aui', { includeBytes = false, batchSize = 24 } = {}) {
    sourcePath(root);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 64) throw new Error('Inventory batch size must be 1–64.');
    const directories = [root];
    const files = [];
    const seenDirectories = new Set();
    const inventory = new Map();
    const contents = new Map();
    let baseline;
    while (directories.length || files.length) {
      await this._operation(async deadline => {
        const state = (await this._driftState(deadline)).state;
        if (baseline !== undefined && JSON.stringify(state) !== JSON.stringify(baseline)) throw new Error('Make state changed during inventory.');
        if (baseline === undefined) baseline = state;
        const bridge = await this._fileBridge(deadline);
        try {
          let count = 0;
          while (count < batchSize && (directories.length || files.length)) {
            if (directories.length) {
              const directory = directories.shift();
              if (seenDirectories.has(directory)) throw new Error(`Make directory was listed twice: ${directory}`);
              seenDirectories.add(directory);
              const remotePath = `code/${directory}`;
              const reply = await bridge.invoke('function(type, data, id) { return this.request(type, data, id); }', [
                'fs/dir/list', { path: remotePath, includeHidden: true }, randomUUID(),
              ]);
              if (reply?.success !== true || reply.data?.path !== remotePath || !Array.isArray(reply.data.files)) {
                throw new Error(`Make directory listing is unavailable: ${directory}`);
              }
              const names = new Set();
              for (const entry of reply.data.files) {
                const name = sourcePath(entry?.name);
                if (name.includes('/') || entry.path !== name || names.has(name) ||
                    (entry.isFile === true) === (entry.isDirectory === true)) {
                  throw new Error(`Make directory listing is ambiguous: ${directory}`);
                }
                names.add(name);
                const path = `${directory}/${name}`;
                if (entry.isDirectory) directories.push(path);
                else files.push({ path, size: entry.size });
              }
            } else {
              const { path, size } = files.shift();
              const relative = path.slice(root.length + 1);
              if (inventory.has(relative)) throw new Error(`Duplicate Make file: ${path}`);
              const bytes = await this._bridgeReadBytes(bridge, path);
              if (Number.isSafeInteger(size) && bytes.length !== size) throw new Error(`Make file changed during inventory: ${path}`);
              inventory.set(relative, { path: relative, bytes: bytes.length, sha256: digest(bytes) });
              if (includeBytes) contents.set(relative, bytes);
            }
            if (seenDirectories.size + inventory.size + directories.length + files.length > this.maxEntries) {
              throw new Error('Make drift inventory exceeds the entry limit.');
            }
            count++;
          }
        } finally { await bridge.dispose(); }
        const after = (await this._driftState(deadline)).state;
        if (JSON.stringify(after) !== JSON.stringify(baseline)) throw new Error('Make state changed during inventory.');
      });
    }
    return { inventory, contents, state: baseline, batches: Math.ceil((seenDirectories.size + inventory.size) / batchSize) };
  }

  // Project-root inventory for the git tree hash. It lists every file under
  // the Make project root, hidden ones included, minus what Make's sandbox git
  // excludes: .git, the PROJECT_EXCLUDES baseline, .git/info/exclude (passed
  // in as `exclude`) and each folder's .gitignore. As in git, a tracked path is
  // kept even when an ignore rule matches it; the baseline always wins. An
  // untracked node_modules folder is skipped. Excluded files are never read.
  // Version/pending state is bracketed per batch, as for inventoryVendor.
  async inventoryProject({ includeBytes = false, batchSize = 24, tracked = [], exclude = null } = {}) {
    const keep = typeof includeBytes === 'function' ? includeBytes : () => includeBytes === true;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 64) throw new Error('Inventory batch size must be 1–64.');
    const list = async (bridge, directory) => {
      const remotePath = directory ? `code/${directory}` : 'code';
      const reply = await bridge.invoke('function(type, data, id) { return this.request(type, data, id); }', [
        'fs/dir/list', { path: remotePath, includeHidden: true }, randomUUID(),
      ]);
      if (reply?.success !== true || reply.data?.path !== remotePath || !Array.isArray(reply.data.files)) {
        throw new Error(`Make directory listing is unavailable: ${directory || '(project root)'}`);
      }
      const names = new Set();
      return reply.data.files.map(entry => {
        const name = sourcePath(entry?.name);
        if (name.includes('/') || entry.path !== name || names.has(name) ||
            (entry.isFile === true) === (entry.isDirectory === true)) {
          throw new Error(`Make directory listing is ambiguous: ${directory || '(project root)'}`);
        }
        // VS Code FileType.SymbolicLink; Make reports no link target to hash.
        if (Number.isInteger(entry.type) && (entry.type & 64)) throw new Error(`Make symbolic links are unsupported: ${directory ? `${directory}/` : ''}${name}`);
        names.add(name);
        return { name, isDirectory: entry.isDirectory === true, size: entry.size };
      });
    };
    const hard = parseIgnore(PROJECT_EXCLUDES.join('\n'));
    const trackedFiles = new Set(tracked);
    const trackedFolders = new Set([...trackedFiles].flatMap(path => path.split('/').slice(0, -1)
      .map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
    const directories = [{ path: '', rules: exclude ? parseIgnore(exclude.toString('utf8')) : [], ignored: false }];
    const files = [];
    const seenDirectories = new Set();
    const inventory = new Map();
    const contents = new Map();
    const excluded = [];
    let baseline;
    while (directories.length || files.length) {
      await this._operation(async deadline => {
        const state = (await this._driftState(deadline)).state;
        if (baseline !== undefined && JSON.stringify(state) !== JSON.stringify(baseline)) throw new Error('Make state changed during inventory.');
        if (baseline === undefined) baseline = state;
        const bridge = await this._fileBridge(deadline);
        try {
          let count = 0;
          while (count < batchSize && (directories.length || files.length)) {
            if (directories.length) {
              const { path: directory, rules: inherited, ignored: inIgnored } = directories.shift();
              if (seenDirectories.has(directory)) throw new Error(`Make directory was listed twice: ${directory}`);
              seenDirectories.add(directory);
              const entries = await list(bridge, directory);
              let rules = inherited;
              const join = name => directory ? `${directory}/${name}` : name;
              const ignoreFile = entries.find(entry => entry.name === '.gitignore' && !entry.isDirectory);
              if (ignoreFile && !isIgnored(rules, join('.gitignore'), false)) {
                rules = [...rules, ...parseIgnore((await this._bridgeReadBytes(bridge, join('.gitignore'))).toString('utf8'), directory)];
              }
              for (const entry of entries) {
                const path = join(entry.name);
                const ignored = inIgnored || isIgnored(rules, path, entry.isDirectory);
                const untrackedModules = entry.isDirectory && entry.name === 'node_modules';
                const keepTracked = entry.isDirectory ? trackedFolders.has(path) : trackedFiles.has(path);
                if ((!directory && entry.name === '.git') || isIgnored(hard, path, entry.isDirectory) ||
                    ((ignored || untrackedModules) && !keepTracked)) {
                  excluded.push(entry.isDirectory ? `${path}/` : path);
                  continue;
                }
                if (entry.isDirectory) directories.push({ path, rules, ignored });
                else files.push({ path, size: entry.size });
              }
            } else {
              const { path, size } = files.shift();
              if (inventory.has(path)) throw new Error(`Duplicate Make file: ${path}`);
              const bytes = await this._bridgeReadBytes(bridge, path);
              if (Number.isSafeInteger(size) && bytes.length !== size) throw new Error(`Make file changed during inventory: ${path}`);
              inventory.set(path, { path, bytes: bytes.length, sha256: digest(bytes), blob: gitBlobSha(bytes) });
              if (keep(path)) contents.set(path, bytes);
            }
            if (seenDirectories.size + inventory.size + directories.length + files.length > this.maxEntries) {
              throw new Error('Make project inventory exceeds the entry limit.');
            }
            count++;
          }
        } finally { await bridge.dispose(); }
        const after = (await this._driftState(deadline)).state;
        if (JSON.stringify(after) !== JSON.stringify(baseline)) throw new Error('Make state changed during inventory.');
      });
    }
    return { inventory, contents, state: baseline, excluded: excluded.sort(), excludeSource: exclude ? '.git/info/exclude' : 'baseline-only',
      batches: Math.ceil((seenDirectories.size + inventory.size) / batchSize) };
  }

  // A sandbox git reader over the filesystem bridge.
  _sandboxGit(bridge) {
    // Make never answers a listing of a missing folder, so each folder is
    // listed only after its parent shows it. '' is .git itself, which the
    // root listing omits, so its absence cannot be proven: any failed
    // listing fails the read.
    const listings = new Map();
    const listDir = async path => {
      if (!listings.has(path)) {
        let names = null;
        const slash = path.lastIndexOf('/');
        if (!path || (await listDir(slash < 0 ? '' : path.slice(0, slash)))?.includes(path.slice(slash + 1))) {
          const remotePath = path ? `code/.git/${path}` : 'code/.git';
          let reply;
          try {
            reply = await bridge.invoke('function(type, data, id) { return this.request(type, data, id); }', [
              'fs/dir/list', { path: remotePath, includeHidden: true }, randomUUID(),
            ]);
          } catch (error) { throw new Error(`Make sandbox git is unavailable: ${remotePath}: ${error.message}`); }
          if (reply?.success !== true || reply.data?.path !== remotePath || !Array.isArray(reply.data.files)) {
            throw new Error(`Make sandbox git is unavailable: ${remotePath} could not be listed.`);
          }
          names = reply.data.files.map(entry => entry.name);
        }
        listings.set(path, names);
      }
      return listings.get(path);
    };
    const readFile = async path => {
      const slash = path.lastIndexOf('/');
      const names = await listDir(slash < 0 ? '' : path.slice(0, slash));
      return names?.includes(path.slice(slash + 1)) ? this._bridgeReadBytes(bridge, `.git/${path}`) : null;
    };
    return new SandboxGit({ readFile, listDir });
  }

  // Read-only inputs for `make status`: the saved version's own tree from the
  // sandbox git objects (exact file modes), the project inventory with that
  // tree's paths kept as tracked, the working-copy tree, the marker and the
  // AI-turn version history.
  async projectStatus() {
    const git = await this._operation(async deadline => {
      const state = (await this._driftState(deadline)).state;
      const history = await this._evaluate(`(${makeVersionHistory.toString()})()`, deadline);
      const bridge = await this._fileBridge(deadline);
      try {
        const reader = this._sandboxGit(bridge);
        const head = await reader.head();
        const saved = state?.hasBaseline && /^[a-f0-9]{40}$/.test(state.savedVersion || '') ? state.savedVersion : null;
        const tree = await reader.commitTree(saved || head);
        const flat = await reader.flatten(tree);
        const exclude = await reader.readFile('info/exclude');
        const after = (await this._driftState(deadline)).state;
        if (JSON.stringify(after) !== JSON.stringify(state)) throw new Error('Make state changed while reading its git objects.');
        return { state, history, head, tree, flat, treeSource: saved ? 'saved-version' : 'sandbox-head', exclude };
      } finally { await bridge.dispose(); }
    });
    const scan = await this.inventoryProject({ includeBytes: path => path === PROJECT_MARKER || path === '.gitattributes',
      tracked: [...git.flat.keys()], exclude: git.exclude });
    if (JSON.stringify(scan.state) !== JSON.stringify(git.state)) throw new Error('Make state changed during inventory.');
    const isLfs = lfsMatcher(scan.contents.get('.gitattributes')?.toString('utf8'));
    const working = workingFlat(scan.inventory, git.flat);
    const lfsPaths = [...new Set([...scan.inventory.keys(), ...git.flat.keys()])].filter(isLfs).sort();
    return { persistence: scan.state, history: git.history, head: git.head, makeTree: git.tree, treeSource: git.treeSource,
      makeFlat: git.flat, workingFlat: working, workingTree: treeOf(working), fileCount: scan.inventory.size,
      workingSha256: new Map([...scan.inventory].map(([path, file]) => [path, file.sha256])),
      excluded: scan.excluded, excludeSource: scan.excludeSource, lfsPaths, isLfs,
      markerBytes: scan.contents.get(PROJECT_MARKER) ?? null, batches: scan.batches };
  }

  // The team-mode marker as Make's client VFS holds it, for the write gate.
  projectMarker() {
    return this._operation(async deadline => {
      const entry = await this._durable({ type: 'read', path: PROJECT_MARKER }, deadline);
      return entry.exists ? Buffer.from(entry.content, 'utf8') : null;
    });
  }

  async drift(manifestBytes, { root = 'src/vendor/atomic-aui', receiptBytes } = {}) {
    const manifest = vendorManifest(manifestBytes, root);
    const receipt = externalReceipt(receiptBytes, { fileKey: this.fileKey, manifestSha256: manifest.sha256 });
    const { inventory, contents, state, batches } = await this.inventoryVendor(root, { includeBytes: true });
    const result = compareVendor(manifest, inventory, {
      manifestFile: inventory.get('VENDOR.json'), stateBefore: state, stateAfter: state, receipt,
    });
    if (contents.has('tokens/generated.manifest.json')) {
      try { verifyGeneratedManifest(contents.get('tokens/generated.manifest.json'), inventory); }
      catch (error) { result.reasons.push(error.message); result.ok = false; }
    }
    return { fileKey: this.fileKey, ...result, batches, scanTruncation: { arrayItems: 0, depth: 0 } };
  }

  async _fileBridge(deadline) {
    const response = await this.transport.send('Runtime.evaluate', {
      expression: `(${captureMakeFileSocket.toString()})(${JSON.stringify(this.fileKey)}, null, ${Math.min(5000, this._remaining(deadline))}, ${this._remaining(deadline)})`,
      returnByValue: false,
    }, { timeoutMs: this._remaining(deadline) });
    if (response.exceptionDetails || !response.result?.objectId) throw new Error('Could not observe Make filesystem connection.');
    const objectId = response.result.objectId;
    const invoke = async (fn, args = []) => {
      const result = await this.transport.send('Runtime.callFunctionOn', {
        objectId, functionDeclaration: fn, arguments: args.map(value => ({ value })),
        returnByValue: true, awaitPromise: true,
      }, { timeoutMs: this._remaining(deadline) });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Make filesystem operation failed.');
      return result.result?.value;
    };
    const dispose = async () => {
      try { await this.transport.send('Runtime.callFunctionOn', {
        objectId, functionDeclaration: 'function() { this.dispose(); }', returnByValue: true,
      }, { timeoutMs: 400 }); }
      finally { await this.transport.send('Runtime.releaseObject', { objectId }, { timeoutMs: 400 }); }
    };
    // A provisioned socket stays pending until Make acknowledges creating its
    // workspace (about a second after provisioning, observed live); wait
    // longer for that than for a capture that has not started.
    const captured = async (ms, pendingMs = ms) => {
      const started = Date.now();
      for (;;) {
        const status = await invoke('function() { return this.status(); }');
        if (status?.captured && status.workspace) return true;
        if (Date.now() - started >= (status?.pending ? pendingMs : ms) || Date.now() >= deadline) return false;
        await this._bounded(() => new Promise(resolve => setTimeout(resolve, 50)), deadline);
      }
    };
    try {
      // Usually captured already: from a socket cached earlier in this page, or
      // from the reconnect that focus emulation triggered at operation start.
      if (await captured(1500, 8000)) return { invoke, dispose };
      // A page whose agent socket stayed open since it provisioned unobserved
      // sends nothing that identifies it. Close that socket so Make reconnects
      // and provisions under the armed hook (about 1.5 s, observed live), but
      // never while Make is generating.
      const state = await this._editor({ type: 'inspect' }, deadline);
      if (!state.busy && await this._reconnectAgentSocket(deadline) && await captured(4000, 8000)) return { invoke, dispose };
    } catch (error) { await dispose(); throw error; }
    await dispose();
    const error = new Error('No Make filesystem connection was observed; no files were written. Make opens one when its page reconnects; ' +
      'if the project tab is in the foreground, switch to another Figma tab, wait a minute, and run the command again.');
    error.code = 'MAKE_FILESYSTEM_UNAVAILABLE';
    throw error;
  }

  async _reconnectAgentSocket(deadline) {
    const prototype = await this.transport.send('Runtime.evaluate', { expression: 'WebSocket.prototype' }, { timeoutMs: this._remaining(deadline) });
    if (!prototype.result?.objectId) return 0;
    try {
      const sockets = await this.transport.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId }, { timeoutMs: this._remaining(deadline) });
      if (!sockets.objects?.objectId) return 0;
      try {
        const result = await this.transport.send('Runtime.callFunctionOn', {
          objectId: sockets.objects.objectId, arguments: [{ value: this.fileKey }], returnByValue: true,
          functionDeclaration: `function(fileKey) {
            const record = globalThis[Symbol.for('figma-cli.make.filesystem.' + fileKey)];
            const host = new URL(location.href).hostname;
            let closed = 0;
            for (const socket of this) {
              try {
                const url = new URL(socket.url);
                if (socket.readyState !== WebSocket.OPEN || socket === record?.socket || url.protocol !== 'wss:' ||
                    url.hostname !== host || url.pathname !== '/api/agentcontrol/subscribe') continue;
                socket.close();
                closed++;
              } catch {}
            }
            return closed;
          }`,
        }, { timeoutMs: this._remaining(deadline) });
        return result.result?.value || 0;
      } finally { await this.transport.send('Runtime.releaseObject', { objectId: sockets.objects.objectId }, { timeoutMs: 400 }); }
    } finally { await this.transport.send('Runtime.releaseObject', { objectId: prototype.result.objectId }, { timeoutMs: 400 }); }
  }

  async _backup(path, content, metadata) {
    const root = resolve(metadata.backupDir);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(root, 'make-'));
    await chmod(directory, 0o700);
    const backupPath = join(directory, 'original.txt');
    await writePrivateFile(backupPath, content);
    await writePrivateFile(join(directory, 'metadata.json'), JSON.stringify({
      fileKey: this.fileKey, path, sha256: sha256(content), operation: metadata.operation,
      ...(metadata.replacementSha256 ? { replacementSha256: metadata.replacementSha256 } : {}),
      createdAt: new Date().toISOString(),
    }, null, 2) + '\n');
    return backupPath;
  }

  importFiles(files) {
    const validated = validateImportFiles(files);
    return this._operation(async deadline => {
      const state = await this._ensureCode(deadline);
      if (state.busy || state.offline) throw new Error('Make is busy or offline; import refused.');
      const existing = await listMakeFiles(this._treeTransport(deadline), {
        timeoutMs: this._remaining(deadline), maxEntries: this.maxEntries,
      });
      validateImportFiles(validated, existing);
      const bridge = await this._fileBridge(deadline);
      await this._bounded(() => this.transport.send('Network.enable', {}, {
        timeoutMs: this._remaining(deadline),
      }), deadline);
      const watchers = validated.map(file => watchMakeSave(this.transport, {
        path: file.path, content: file.content, timeoutMs: this._remaining(deadline),
      }));
      const sessionWrites = [];
      const observedWrites = [];
      const removeDiagnostics = this.transport.onEvent(({ method, params }) => {
        if (!['Network.webSocketFrameSent', 'Network.webSocketFrameReceived'].includes(method)) return;
        try {
          const message = JSON.parse(params.response.payloadData);
          if (!message.type?.startsWith('fs/') || observedWrites.length >= 20) return;
          observedWrites.push({ direction: method.endsWith('Sent') ? 'sent' : 'received', type: message.type,
            path: message.data?.path, encoding: message.data?.encoding, success: message.success,
            size: message.data?.size });
        } catch {}
      });
      const pending = watchers.map((watcher, index) => watcher.promise.then(receipt => {
        const { path, bytes, sha256 } = validated[index];
        const result = { path, bytes, sha256, receipt };
        sessionWrites.push(result);
        return result;
      }));
      pending.forEach(promise => promise.catch(() => {}));
      try {
        const ready = await this._editor({ type: 'inspect' }, deadline);
        if (!ready.codeReady || ready.busy || ready.offline) throw new Error('Make became unavailable before import.');
        for (const file of validated) {
          const reply = await bridge.invoke('function(type, data, id) { return this.request(type, data, id); }', [
            'fs/file/write', { path: `code/${file.path}`, content: Buffer.from(file.content).toString('base64'), encoding: 'base64' }, randomUUID(),
          ]);
          if (reply.success !== true || reply.data?.path !== `code/${file.path}` || reply.data?.size !== file.bytes) {
            throw new Error(`Make did not accept the session write of ${file.path}.`);
          }
          const readback = await bridge.invoke('function(type, data, id) { return this.request(type, data, id); }', [
            'fs/file/read', { path: `code/${file.path}`, encoding: 'base64' }, randomUUID(),
          ]);
          if (!readback.success || readback.data?.path !== `code/${file.path}` ||
              readback.data?.encoding !== 'base64' || readback.data?.content !== Buffer.from(file.content).toString('base64')) {
            throw new Error(`Make source readback did not match ${file.path}.`);
          }
        }
        const written = await this._bounded(() => Promise.all(pending), deadline);
        return { fileKey: this.fileKey, files: written, verification: 'session-readback-matched', ...sessionOnly };
      } catch (cause) {
        const error = new Error(`Make import outcome may be partial or uncertain: ${cause.message} No retry or rollback was attempted. Inspect the file tree before resuming.`);
        error.outcome = 'uncertain';
        error.sessionWrites = sessionWrites;
        error.requestedPaths = validated.map(file => file.path);
        error.observedWrites = observedWrites;
        throw error;
      } finally {
        removeDiagnostics();
        watchers.forEach(watcher => watcher.cancel());
        await bridge.dispose();
      }
    });
  }

  verifyFiles(files) {
    const validated = validateImportFiles(files);
    return this._operation(async deadline => {
      await this._ensureCode(deadline);
      const existing = await listMakeFiles(this._treeTransport(deadline), {
        timeoutMs: this._remaining(deadline), maxEntries: this.maxEntries,
      });
      for (const file of validated) {
        if (!existing.some(entry => entry.kind === 'file' && entry.path === file.path)) {
          throw new Error(`Make source file is missing: ${file.path}`);
        }
      }
      const bridge = await this._fileBridge(deadline);
      try {
        const verified = [];
        for (const file of validated) {
          const reply = await bridge.invoke('function(type, data, id) { return this.request(type, data, id); }', [
            'fs/file/read', { path: `code/${file.path}`, encoding: 'base64' }, randomUUID(),
          ]);
          if (!reply.success || reply.data?.path !== `code/${file.path}` || reply.data?.encoding !== 'base64' ||
              reply.data?.content !== Buffer.from(file.content).toString('base64')) {
            throw new Error(`Make source differs from expected content: ${file.path}`);
          }
          verified.push({ path: file.path, sha256: file.sha256, bytes: file.bytes });
        }
        return { fileKey: this.fileKey, verification: 'remote-content-matched', files: verified };
      } finally { await bridge.dispose(); }
    });
  }

  remove(path, { expectedSha256, backupDir = join(homedir(), '.figma-cli', 'make-backups') } = {}) {
    validateImportFiles([{ path, content: '' }]);
    if (!/^[a-fA-F0-9]{64}$/.test(expectedSha256 || '')) throw new Error('Removal requires the previous source SHA-256.');
    return this._operation(async deadline => {
      const state = await this._ensureCode(deadline);
      if (state.busy || state.offline) throw new Error('Make is busy or offline; removal refused.');
      const existing = await listMakeFiles(this._treeTransport(deadline), {
        timeoutMs: this._remaining(deadline), maxEntries: this.maxEntries,
      });
      if (!existing.some(entry => entry.path === path && entry.kind === 'file')) throw new Error('Exact source file not found.');
      const bridge = await this._fileBridge(deadline);
      let backupPath;
      try {
        let content;
        try { ({ content } = await this._bridgeRead(bridge, path)); }
        catch { throw new Error('Could not verify exact source before removal.'); }
        if (sha256(content) !== expectedSha256.toLowerCase()) throw new Error('Make source changed; removal refused.');
        backupPath = await this._bounded(() => this._backup(path, content, { backupDir, operation: 'remove' }), deadline);
        const reply = await bridge.invoke('function(type, data, id) { return this.request(type, data, id); }', [
          'fs/file/delete', { path: `code/${path}` }, randomUUID(),
        ]);
        if (reply.success !== true) throw new Error('Make did not accept the session removal.');
        return { path, backupPath, sha256: sha256(content), verification: 'session-delete-accepted', ...sessionOnly };
      } catch (error) {
        if (backupPath) { error.backupPath = backupPath; error.message += ' Removal outcome may be uncertain; inspect before retrying.'; }
        throw error;
      } finally { await bridge.dispose(); }
    });
  }

  // The whole replacement runs through the filesystem bridge, so a file at
  // any depth works without fitting its folder chain into the file-tree
  // viewport. The bridge writes the session's working copy only; Make's own
  // Save is never triggered, so the result is labelled session-only.
  replace(path, content, { expectedSha256, backupDir = join(homedir(), '.figma-cli', 'make-backups') } = {}) {
    return this._operation(async (deadline) => {
      if (typeof content !== 'string') throw new Error('Replacement content must be a UTF-8 string.');
      if (typeof expectedSha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(expectedSha256)) {
        throw new Error('Replacement requires the SHA-256 returned by read as expectedSha256.');
      }
      validateImportFiles([{ path, content }]);
      const state = await this._ensureCode(deadline);
      if (state.busy) throw new Error('Make is generating changes; replacement refused until generation finishes.');
      if (state.offline) throw new Error('Make reports that some changes will not be synced; replacement refused.');
      // A visible read-only editor means this project cannot be edited here.
      if (state.readOnly === true) throw new Error('Make source editor is read-only; replacement refused.');
      const existing = await listMakeFiles(this._treeTransport(deadline), {
        timeoutMs: this._remaining(deadline), maxEntries: this.maxEntries,
      });
      // Replacement never creates: the path must already be a project file.
      if (!existing.some(entry => entry.kind === 'file' && entry.path === path)) {
        throw new Error(`Make source file is missing: ${path}`);
      }
      const bridge = await this._fileBridge(deadline);
      try {
        const original = await this._bridgeRead(bridge, path);
        const originalSha256 = sha256(original.content);
        if (originalSha256 !== expectedSha256.toLowerCase()) {
          throw new Error('Make source changed since it was read; SHA-256 does not match.');
        }
        if (original.content === content) {
          return { path, backupPath: null, sha256: originalSha256, changed: false,
            verification: 'unchanged', persistence: 'unverified' };
        }
        const backupPath = await this._bounded(() => this._backup(path, original.content, {
          backupDir, operation: 'replace', replacementSha256: sha256(content),
        }), deadline);
        const remotePath = `code/${path}`;
        const replacement = Buffer.from(content, 'utf8');
        const encoded = replacement.toString('base64');
        const uncertain = (error) => {
          const failure = new Error(`Make replacement outcome is uncertain: ${error.message} Original backup: ${backupPath}. No retry or rollback was attempted.`);
          failure.backupPath = backupPath;
          failure.outcome = 'uncertain';
          return failure;
        };
        // From here, a lost response may mean the write ran. Never retry or undo.
        let outcome;
        try {
          outcome = await bridge.invoke('function(path, original, content, readId, writeId) { return this.replace(path, original, content, readId, writeId); }', [
            remotePath, original.base64, encoded, randomUUID(), randomUUID(),
          ]);
        } catch (error) { throw uncertain(error); }
        if (typeof outcome?.refused === 'string') {
          const refusal = new Error(`${outcome.refused} No write was sent. Original backup: ${backupPath}.`);
          refusal.backupPath = backupPath;
          refusal.outcome = 'refused';
          throw refusal;
        }
        let receipt;
        try {
          const reply = outcome?.reply;
          if (reply?.success !== true) {
            throw new Error(reply?.success === false ? 'Make rejected the session write.' : 'Make did not answer the session write.');
          }
          if (reply.data?.path !== remotePath || reply.data?.size !== replacement.length) {
            throw new Error('Make session-write reply did not match the source path and byte count.');
          }
          const readback = await this._bridgeRead(bridge, path);
          if (readback.base64 !== encoded || sha256(readback.content) !== sha256(content)) {
            throw new Error('Make source readback did not match the replacement.');
          }
          const { writtenAtMs, modifiedAtMs } = reply.data;
          receipt = { path, bytes: replacement.length,
            ...([writtenAtMs, modifiedAtMs].every(value => Number.isSafeInteger(value) && value >= 0) ? { writtenAtMs, modifiedAtMs } : {}) };
        } catch (error) { throw uncertain(error); }
        return { path, backupPath, sha256: sha256(content), changed: true,
          verification: 'session-readback-matched', readback: 'matched', ...sessionOnly, receipt };
      } finally { await bridge.dispose(); }
    });
  }

  close() {
    this.transport.close();
    this.fileKey = null;
  }
}
