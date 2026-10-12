import WebSocket from 'ws';
import { getCdpPort } from './figma-patch.js';

const DEFAULT_TIMEOUT_MS = 5000;
const FILE_KEY = /^[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function validateOptions(port, timeoutMs) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Make CDP port must be an integer from 1 to 65535');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw new Error('Make CDP timeout must be a positive finite number');
  }
}

function keyFromURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['figma.com', 'www.figma.com'].includes(url.hostname)
      || url.username || url.password || url.port) return null;
    const match = url.pathname.match(/^\/make\/([A-Za-z0-9_-]+)(?:\/|$)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function requestedKey(value) {
  if (typeof value !== 'string' || !value) {
    throw new Error('Provide an exact Figma Make file key or https://www.figma.com/make/ URL');
  }
  if (FILE_KEY.test(value)) return value;
  const key = keyFromURL(value);
  if (key) return key;
  throw new Error('Provide an exact Figma Make file key or https://www.figma.com/make/ URL');
}

function validWebSocketURL(value, port) {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' && LOOPBACK_HOSTS.has(url.hostname)
      && Number(url.port || 80) === port && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

async function discoverTargets(port, signal) {
  // Reject redirects so discovery cannot leave the configured local service.
  const response = await fetch(`http://127.0.0.1:${port}/json`, { signal, redirect: 'error' });
  if (!response.ok) throw new Error(`Make CDP discovery failed: HTTP ${response.status}`);
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error('Make CDP discovery returned an invalid target list');
  return targets.flatMap((target) => {
    if (!target || target.type !== 'page' || typeof target.id !== 'string' || !target.id) return [];
    const fileKey = keyFromURL(target.url);
    if (!fileKey || !validWebSocketURL(target.webSocketDebuggerUrl, port)) return [];
    return [{
      id: target.id,
      title: typeof target.title === 'string' ? target.title : '',
      url: target.url,
      fileKey,
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    }];
  });
}

/** A separate, bounded CDP connection to one exact Make file. Never retries. */
export class MakeTransport {
  constructor({ port = getCdpPort(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    validateOptions(port, timeoutMs);
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.target = null;
    this.ws = null;
    this._nextId = 0;
    this._pending = new Map();
    this._eventListeners = new Set();
    this._connectController = null;
  }

  static async listTargets({ port = getCdpPort(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    validateOptions(port, timeoutMs);
    return discoverTargets(port, AbortSignal.timeout(timeoutMs));
  }

  async connect(fileKeyOrURL, { timeoutMs = this.timeoutMs } = {}) {
    const fileKey = requestedKey(fileKeyOrURL);
    validateOptions(this.port, timeoutMs);
    if (this.ws || this._connectController) throw new Error('Make transport is already connected or connecting');
    const controller = new AbortController();
    this._connectController = controller;
    const timer = setTimeout(() => controller.abort(new Error('Make CDP connection timed out')), timeoutMs);
    try {
      const targets = (await discoverTargets(this.port, controller.signal))
        .filter((target) => target.fileKey === fileKey);
      controller.signal.throwIfAborted();
      if (!targets.length) throw new Error(`No open Figma Make page with exact file key ${fileKey}`);
      if (targets.length !== 1) throw new Error(`Multiple open Figma Make pages have file key ${fileKey}; close duplicate tabs`);
      const target = targets[0];
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(target.webSocketDebuggerUrl, { followRedirects: false });
        this.ws = socket;
        let opened = false;
        const abort = () => {
          reject(controller.signal.reason);
          socket.terminate();
        };
        controller.signal.addEventListener('abort', abort, { once: true });
        const cleanup = () => controller.signal.removeEventListener('abort', abort);
        socket.on('open', () => {
          if (controller.signal.aborted) return abort();
          opened = true;
          cleanup();
          this.target = target;
          resolve();
        });
        socket.on('message', (data) => this._receive(data, socket));
        socket.on('error', (error) => {
          cleanup();
          if (!opened) reject(error);
          if (this.ws === socket) this._failPending(error);
          socket.terminate();
        });
        socket.on('close', () => {
          cleanup();
          const error = new Error('Make CDP connection closed');
          if (!opened) reject(error);
          if (this.ws === socket) {
            this.ws = null;
            this.target = null;
            this._failPending(error);
          }
        });
      });
      return this;
    } catch (error) {
      if (this.ws) this.ws.terminate();
      this.ws = null;
      this.target = null;
      throw error;
    } finally {
      clearTimeout(timer);
      if (this._connectController === controller) this._connectController = null;
    }
  }

  send(method, params = {}, { timeoutMs = this.timeoutMs, sessionId } = {}) {
    validateOptions(this.port, timeoutMs);
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Make transport is not connected'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this._nextId;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Make CDP ${method} timed out; the command was not retried`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
          if (!error) return;
          const pending = this._pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this._pending.delete(id);
          pending.reject(error);
        });
      } catch (error) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) {
      const details = response.exceptionDetails;
      throw new Error(details.exception?.description || details.text || 'Make JavaScript evaluation failed');
    }
    return response.result?.value;
  }

  /** Receive CDP events as { method, params }; returns an unsubscribe function. */
  onEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('Make CDP event listener must be a function');
    this._eventListeners.add(listener);
    return () => this._eventListeners.delete(listener);
  }

  _receive(data, socket) {
    if (this.ws !== socket) return;
    let message;
    try {
      message = JSON.parse(data.toString());
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
    } catch {
      this._failPending(new Error('Invalid Make CDP response'));
      socket.terminate();
      return;
    }
    if (message.id === undefined && typeof message.method === 'string') {
      const event = { method: message.method, params: message.params || {} };
      for (const listener of this._eventListeners) {
        // A consumer failure must not break response delivery for other users.
        try { listener(event); } catch {}
      }
      return;
    }
    const pending = this._pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || 'Make CDP command failed'));
    else pending.resolve(message.result);
  }

  _failPending(error) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
  }

  close() {
    const error = new Error('Make transport closed');
    this._connectController?.abort(error);
    this._failPending(error);
    this._eventListeners.clear();
    const socket = this.ws;
    this.ws = null;
    this.target = null;
    if (socket) socket.terminate();
  }
}
