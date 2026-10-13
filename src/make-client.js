import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, chmod, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MakeTransport } from './make-transport.js';
import { listMakeFiles, selectMakeFile } from './make-tree.js';
import { watchMakeSave } from './make-save-observer.js';
import { validateImportFiles } from './make-import.js';
import { captureMakeFileSocket } from './make-rpc.js';
import { makeWorkspace, openMakeFilesTab } from './make-workspace.js';
import { makeUiSnapshot } from './make-ui.js';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

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
  const summary = {
    url: location.href, title: document.title, codeReady: ready, workspaceMode: context.mode, editorCount: editors.length,
    readOnly: editors.length === 1 ? editors[0].cmView?.view?.state?.readOnly !== false : null,
    busy, offline,
    ...(context.needsFilesTab ? { needsFilesTab: true } : {}),
    selectedName: selected.length === 1 ? selected[0].closest('[role="treeitem"]')?.getAttribute('aria-label') : null,
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

  async _evaluate(expression, deadline) {
    return this._bounded(() => this.transport.evaluate(guardExpression(this.fileKey, expression)), deadline);
  }

  _editor(action, deadline) {
    return this._evaluate(`(${makeEditorAction.toString()})(${JSON.stringify(action)}, (${makeWorkspace.toString()}))`, deadline);
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

  async _read(path, deadline) {
    const entry = await this._select(path, deadline);
    let state = await this._editor({ type: 'inspect' }, deadline);
    while (state.editorCount === 0) {
      await this._bounded(() => new Promise(resolve => setTimeout(resolve, 50)), deadline);
      state = await this._editor({ type: 'inspect' }, deadline);
    }
    const { content } = await this._editor({ type: 'read', entry }, deadline);
    return { entry, content, sha256: sha256(content) };
  }

  inspect() {
    return this._operation(async (deadline) => ({ fileKey: this.fileKey, ...await this._ensureCode(deadline) }));
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

  // Saved source through the filesystem bridge; the editor is only a fallback
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
        bridge = await this._fileBridge(existing, deadline);
      } catch (error) {
        if (remote || error.code !== 'MAKE_FILESYSTEM_UNAVAILABLE' || path.startsWith('node_modules/')) throw error;
        const result = await this._read(path, deadline);
        return { fileKey: this.fileKey, path, content: result.content, sha256: result.sha256, source: 'editor' };
      }
      try {
        const { content } = await this._bridgeRead(bridge, path);
        return { fileKey: this.fileKey, path, content, sha256: sha256(content), source: 'filesystem' };
      } finally { await bridge.dispose(); }
    });
  }

  async _bridgeRead(bridge, path) {
    const reply = await bridge.invoke('function(type, data, id) { return this.request(type, data, id); }', [
      'fs/file/read', { path: `code/${path}`, encoding: 'base64' }, randomUUID(),
    ]);
    if (!reply?.success || reply.data?.path !== `code/${path}` || reply.data?.encoding !== 'base64' || typeof reply.data?.content !== 'string') {
      throw new Error(`Make remote source read failed: ${path}`);
    }
    const bytes = Buffer.from(reply.data.content, 'base64');
    if (bytes.toString('base64') !== reply.data.content) throw new Error('Invalid remote source encoding');
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { content, base64: reply.data.content };
  }

  async _fileBridge(existing, deadline) {
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
      // Fallback for a page whose socket stayed open: Make reads a source file
      // it has not cached when that file is opened. Files the tree cannot
      // select are skipped rather than failing the capture.
      const candidates = existing.filter(entry => entry.kind === 'file').sort((a, b) =>
        Number(b.path.startsWith('src/vendor/')) - Number(a.path.startsWith('src/vendor/')));
      for (const candidate of candidates.slice(0, 8)) {
        try { await this._select(candidate.path, deadline); }
        catch (error) { if (/selection was refused/.test(error.message)) continue; throw error; }
        if (await captured(700)) return { invoke, dispose };
      }
    } catch (error) { await dispose(); throw error; }
    await dispose();
    const error = new Error('No Make filesystem connection was observed; no files were written. Make opens one when its page reconnects; ' +
      'if the project tab is in the foreground, switch to another Figma tab, wait a minute, and run the command again.');
    error.code = 'MAKE_FILESYSTEM_UNAVAILABLE';
    throw error;
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
      const bridge = await this._fileBridge(existing, deadline);
      await this._bounded(() => this.transport.send('Network.enable', {}, {
        timeoutMs: this._remaining(deadline),
      }), deadline);
      const watchers = validated.map(file => watchMakeSave(this.transport, {
        path: file.path, content: file.content, timeoutMs: this._remaining(deadline),
      }));
      const acknowledged = [];
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
        acknowledged.push(result);
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
            throw new Error(`Make did not acknowledge creation of ${file.path}.`);
          }
          const readback = await bridge.invoke('function(type, data, id) { return this.request(type, data, id); }', [
            'fs/file/read', { path: `code/${file.path}`, encoding: 'base64' }, randomUUID(),
          ]);
          if (!readback.success || readback.data?.path !== `code/${file.path}` ||
              readback.data?.encoding !== 'base64' || readback.data?.content !== Buffer.from(file.content).toString('base64')) {
            throw new Error(`Make source readback did not match ${file.path}.`);
          }
        }
        const saved = await this._bounded(() => Promise.all(pending), deadline);
        return { fileKey: this.fileKey, files: saved, verification: 'server-acknowledged', persistence: 'acknowledged' };
      } catch (cause) {
        const error = new Error(`Make import outcome may be partial or uncertain: ${cause.message} No retry or rollback was attempted. Inspect the file tree before resuming.`);
        error.outcome = 'uncertain';
        error.acknowledged = acknowledged;
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
      const bridge = await this._fileBridge(existing, deadline);
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
      const bridge = await this._fileBridge(existing, deadline);
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
        if (reply.success !== true) throw new Error('Make did not acknowledge removal.');
        return { path, backupPath, sha256: sha256(content), verification: 'server-acknowledged', persistence: 'acknowledged' };
      } catch (error) {
        if (backupPath) { error.backupPath = backupPath; error.message += ' Removal outcome may be uncertain; inspect before retrying.'; }
        throw error;
      } finally { await bridge.dispose(); }
    });
  }

  // The whole replacement runs through the filesystem bridge, so a file at
  // any depth works without fitting its folder chain into the file-tree
  // viewport. The bridge's own write reply is Make's server acknowledgement,
  // so the editor-save observer the old editor path needed is not used.
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
      const bridge = await this._fileBridge(existing, deadline);
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
            throw new Error(reply?.success === false ? 'Make rejected the source write.' : 'Make did not acknowledge the source write.');
          }
          if (reply.data?.path !== remotePath || reply.data?.size !== replacement.length) {
            throw new Error('Make write acknowledgement did not match the source path and byte count.');
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
          verification: 'server-acknowledged', readback: 'matched', persistence: 'acknowledged', receipt };
      } finally { await bridge.dispose(); }
    });
  }

  close() {
    this.transport.close();
    this.fileKey = null;
  }
}
