// Reuse only the exact Make filesystem socket observed while opening a source
// file. No cookies/tokens, private stores, guessed service URLs, or new network
// connections. The temporary send hook is restored immediately after capture.
export function captureMakeFileSocket(fileKey, capturePath, timeoutMs) {
  const matchesFile = () => {
    const url = new URL(location.href);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['figma.com', 'www.figma.com'].includes(url.hostname) &&
      url.pathname.split('/')[1] === 'make' && url.pathname.split('/')[2] === fileKey;
  };
  if (!matchesFile()) throw new Error('Make project changed before filesystem capture.');
  const cacheKey = Symbol.for(`figma-cli.make.filesystem.${fileKey}`);
  const cached = globalThis[cacheKey];
  const original = WebSocket.prototype.send;
  if (original.figmaCliCapture) throw new Error('Another Make filesystem capture is active.');
  const bridge = {
    socket: cached?.socket?.readyState === WebSocket.OPEN ? cached.socket : null,
    workspaceId: cached?.socket?.readyState === WebSocket.OPEN ? cached.workspaceId : null,
    disposed: false, requests: new Map(),
    status() { return { captured: !!this.socket, workspace: typeof this.workspaceId === 'string' && !!this.workspaceId }; },
    restore() {
      clearTimeout(this.timer);
      if (WebSocket.prototype.send === hooked) WebSocket.prototype.send = original;
    },
    request(type, data, requestId) {
      if (this.disposed || !matchesFile() || !this.socket || this.socket.readyState !== WebSocket.OPEN ||
          typeof this.workspaceId !== 'string' || !this.workspaceId) throw new Error('Make filesystem connection is unavailable.');
      if (!['fs/file/write', 'fs/file/read', 'fs/file/delete'].includes(type)) throw new Error('Unsupported Make filesystem operation.');
      if (!data || typeof data.path !== 'string' || !data.path.startsWith('code/') ||
          data.path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\u0000-\u001f\u007f]/.test(data.path)) {
        throw new Error('Invalid Make filesystem path.');
      }
      const socket = this.socket;
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
        try { original.call(socket, JSON.stringify({ type, requestId, data: { ...data, workspaceId: this.workspaceId } })); }
        catch (error) { finish(error); }
      });
    },
    dispose() { this.disposed = true; this.restore(); for (const cancel of this.requests.values()) cancel(); this.socket = null; },
  };
  function hooked(payload) {
    if (!bridge.socket && matchesFile() && typeof payload === 'string') {
      try {
        const message = JSON.parse(payload);
        if (message.type === 'fs/file/read' && message.data?.path === `code/${capturePath}` &&
            typeof message.data.workspaceId === 'string' && message.data.workspaceId) {
          bridge.socket = this; bridge.workspaceId = message.data.workspaceId; bridge.restore();
          const record = { socket: this, workspaceId: message.data.workspaceId };
          globalThis[cacheKey] = record;
          this.addEventListener('close', () => { if (globalThis[cacheKey] === record) delete globalThis[cacheKey]; }, { once: true });
        }
      } catch {}
    }
    return original.call(this, payload);
  }
  if (!bridge.socket) {
    WebSocket.prototype.send = hooked;
    hooked.figmaCliCapture = true;
    bridge.timer = setTimeout(() => bridge.restore(), timeoutMs);
  }
  return bridge;
}
