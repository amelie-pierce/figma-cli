// Reuse only the exact Make filesystem socket observed carrying Make's own
// workspace traffic. No cookies/tokens, private stores, guessed service URLs, or
// new network connections. The temporary send hook is restored after capture.
//
// Two outbound messages identify the socket and its workspace: Make's
// `control/provision`, sent when the page (re)connects its agent socket, for
// example after focus emulation starts; and `fs/file/read` for a project source
// file, sent when Make opens a file it has not cached. A provisioned socket is
// usable only after Make's `control/workspace_create_ack` arrives on it: the
// server refuses filesystem requests before that. A capture is cached per page
// until its socket closes, so later commands reuse it.
export function captureMakeFileSocket(fileKey, capturePath, timeoutMs, captureMs = timeoutMs) {
  const matchesFile = () => {
    const url = new URL(location.href);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['figma.com', 'www.figma.com'].includes(url.hostname) &&
      url.pathname.split('/')[1] === 'make' && url.pathname.split('/')[2] === fileKey;
  };
  if (!matchesFile()) throw new Error('Make project changed before filesystem capture.');
  const cacheKey = Symbol.for(`figma-cli.make.filesystem.${fileKey}`);
  const hookKey = Symbol.for('figma-cli.make.filesystem.hook');
  const open = () => {
    const record = globalThis[cacheKey];
    return record?.socket?.readyState === WebSocket.OPEN ? record : null;
  };
  const live = () => open()?.ready ? open() : null;
  const sameHost = (socket) => {
    try {
      const url = new URL(socket.url);
      return url.protocol === 'wss:' && url.hostname === new URL(location.href).hostname && !url.username && !url.password;
    } catch { return false; }
  };
  const identifies = (socket, message) => {
    const workspaceId = message?.data?.workspaceId;
    if (typeof workspaceId !== 'string' || !workspaceId) return false;
    if (message.type === 'control/provision') return sameHost(socket);
    if (message.type !== 'fs/file/read' || typeof message.data.path !== 'string') return false;
    return capturePath ? message.data.path === `code/${capturePath}` : message.data.path.startsWith('code/');
  };
  // One shared hook per page: concurrent bridges observe the same capture
  // instead of stacking send wrappers. It restores itself on capture or timeout.
  function arm() {
    if (live()) return null;
    const active = globalThis[hookKey];
    if (active && WebSocket.prototype.send === active.hooked) {
      active.extend(captureMs);
      return active;
    }
    if (WebSocket.prototype.send.figmaCliCapture) throw new Error('Another Make filesystem capture is active.');
    const original = WebSocket.prototype.send;
    const hook = {
      original, timer: null,
      restore() {
        clearTimeout(hook.timer);
        if (WebSocket.prototype.send === hooked) WebSocket.prototype.send = original;
        if (globalThis[hookKey] === hook) delete globalThis[hookKey];
      },
      extend(ms) { clearTimeout(hook.timer); hook.timer = setTimeout(() => hook.restore(), ms); },
    };
    function hooked(payload) {
      if (!live() && matchesFile() && typeof payload === 'string') {
        try {
          const message = JSON.parse(payload);
          if (identifies(this, message)) {
            // Make only reads files in a created workspace; a provision waits
            // for its acknowledgement. A newer provision replaces a pending one.
            const socket = this;
            const record = { socket, workspaceId: message.data.workspaceId, ready: message.type === 'fs/file/read' };
            globalThis[cacheKey] = record;
            socket.addEventListener('close', () => { if (globalThis[cacheKey] === record) delete globalThis[cacheKey]; }, { once: true });
            if (record.ready) hook.restore();
            else {
              const acknowledged = event => {
                try {
                  const reply = JSON.parse(event.data);
                  if (reply.type !== 'control/workspace_create_ack') return;
                  socket.removeEventListener('message', acknowledged);
                  if (reply.success !== true || globalThis[cacheKey] !== record) return;
                  record.ready = true;
                  hook.restore();
                } catch {}
              };
              socket.addEventListener('message', acknowledged);
            }
          }
        } catch {}
      }
      return original.call(this, payload);
    }
    hooked.figmaCliCapture = true;
    hook.hooked = hooked;
    WebSocket.prototype.send = hooked;
    globalThis[hookKey] = hook;
    hook.extend(captureMs);
    return hook;
  }
  const hook = arm();
  const send = hook?.original || globalThis[hookKey]?.original || WebSocket.prototype.send;
  const bridge = {
    disposed: false, requests: new Map(),
    get socket() { return this.disposed ? null : live()?.socket || null; },
    get workspaceId() { return this.disposed ? null : live()?.workspaceId || null; },
    status() {
      return { captured: !!this.socket, workspace: typeof this.workspaceId === 'string' && !!this.workspaceId,
        pending: !this.disposed && !!open() && !open().ready };
    },
    restore() { if (globalThis[hookKey] && globalThis[hookKey] === hook) hook.restore(); },
    request(type, data, requestId) {
      const socket = this.socket;
      const workspaceId = this.workspaceId;
      if (this.disposed || !matchesFile() || !socket || socket.readyState !== WebSocket.OPEN ||
          typeof workspaceId !== 'string' || !workspaceId) throw new Error('Make filesystem connection is unavailable.');
      if (!['fs/file/write', 'fs/file/read', 'fs/file/delete'].includes(type)) throw new Error('Unsupported Make filesystem operation.');
      if (!data || typeof data.path !== 'string' || !data.path.startsWith('code/') ||
          data.path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\u0000-\u001f\u007f]/.test(data.path)) {
        throw new Error('Invalid Make filesystem path.');
      }
      return new Promise((resolve, reject) => {
        const finish = (error, result) => {
          clearTimeout(timer); socket.removeEventListener('message', receive); socket.removeEventListener('close', closed);
          this.requests.delete(requestId);
          if (error) reject(error); else resolve(result);
        };
        const receive = event => {
          try {
            const reply = JSON.parse(event.data);
            if (reply.type === type && reply.requestId === requestId) finish(null, reply);
          } catch {}
        };
        const closed = () => finish(new Error('Make filesystem socket closed; outcome is unknown.'));
        const timer = setTimeout(() => finish(new Error('Make filesystem request timed out; outcome is unknown.')), timeoutMs);
        this.requests.set(requestId, () => finish(new Error('Make filesystem request cancelled; outcome is unknown.')));
        socket.addEventListener('message', receive); socket.addEventListener('close', closed);
        try { send.call(socket, JSON.stringify({ type, requestId, data: { ...data, workspaceId } })); }
        catch (error) { finish(error); }
      });
    },
    // Read, compare and write within one page invocation, so no CDP round trip
    // separates the final content check from the write request. A refusal
    // means no write was sent; any exception after it means the outcome is unknown.
    async replace(path, originalBase64, contentBase64, readId, writeId) {
      let current;
      try { current = await this.request('fs/file/read', { path, encoding: 'base64' }, readId); }
      catch (error) { return { refused: `Make source could not be re-read before writing: ${error.message}` }; }
      if (!current?.success || current.data?.path !== path || current.data?.encoding !== 'base64' ||
          current.data?.content !== originalBase64) {
        return { refused: 'Make source changed after the backup; replacement was refused.' };
      }
      // request() validates synchronously before sending; only a failure
      // after that point leaves the write's outcome unknown.
      let pending;
      try { pending = this.request('fs/file/write', { path, content: contentBase64, encoding: 'base64' }, writeId); }
      catch (error) { return { refused: `Make source write was not sent: ${error.message}` }; }
      return { reply: await pending };
    },
    dispose() { this.disposed = true; this.restore(); for (const cancel of this.requests.values()) cancel(); },
  };
  return bridge;
}
