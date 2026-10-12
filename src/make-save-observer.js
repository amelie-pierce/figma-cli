/**
 * Observe a save performed by Make's existing UI. This module never sends CDP
 * commands or filesystem requests; callers enable Network before registering
 * the watcher and dispatch their editor change only after registration.
 */

function saveError(message, code, outcome = 'unknown') {
  const error = new Error(message);
  error.code = code;
  error.outcome = outcome;
  return error;
}

function validRequestId(value) {
  return (typeof value === 'string' && value.length > 0) ||
    (Number.isSafeInteger(value) && value >= 0);
}

function frameMessage(params) {
  if (typeof params?.requestId !== 'string' || !params.requestId ||
      params.response?.opcode !== 1 || typeof params.response.payloadData !== 'string') return null;
  try {
    const message = JSON.parse(params.response.payloadData);
    return message && typeof message === 'object' && !Array.isArray(message) ? message : null;
  } catch {
    return null;
  }
}

/**
 * Match an exact outbound UTF-8 write and its acknowledgement on the same
 * WebSocket. Timeout/disconnect means unknown persistence, never an invitation
 * to retry. Cancellation is safe even if the caller never awaits the promise.
 */
export function watchMakeSave(transport, { path, content, timeoutMs = 10000 } = {}) {
  if (typeof transport?.onEvent !== 'function') throw new Error('Make transport does not support save observation.');
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.endsWith('/') ||
      path.split('/').some((part) => !part || part === '.' || part === '..') || /[\\\u0000-\u001f\u007f]/.test(path)) {
    throw new Error('Make save observation requires an exact project-relative source path.');
  }
  if (typeof content !== 'string') throw new Error('Make save observation requires UTF-8 source content.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
    throw new Error('Make save observation timeoutMs must be between 1 and 120000.');
  }

  const remotePath = `code/${path}`;
  const expectedContent = Buffer.from(content, 'utf8').toString('base64');
  const bytes = Buffer.byteLength(content, 'utf8');
  let matched = null;
  let settled = false;
  let unsubscribe;
  let timer;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // A dispatch can fail before callers await this promise. Keep cancellation
  // and an early network failure from becoming unhandled rejections.
  promise.catch(() => {});

  function cleanup() {
    clearTimeout(timer);
    if (unsubscribe) {
      const removeListener = unsubscribe;
      unsubscribe = undefined;
      removeListener();
    }
  }
  function finish(error, result) {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectPromise(error);
    else resolvePromise(result);
  }
  function listener(event) {
    if (settled) return;
    const { method, params } = event || {};
    if (method === 'Network.webSocketClosed') {
      if (matched && params?.requestId === matched.socketId) {
        finish(saveError('Make save connection closed before acknowledgement; persistence is unknown. No retry was attempted.',
          'MAKE_SAVE_CONNECTION_CLOSED'));
      }
      return;
    }
    if (method !== 'Network.webSocketFrameSent' && method !== 'Network.webSocketFrameReceived') return;
    const message = frameMessage(params);
    if (!message || message.type !== 'fs/file/write' || !validRequestId(message.requestId)) return;
    if (method === 'Network.webSocketFrameSent') {
      if (!matched && message.data?.path === remotePath && message.data?.encoding === 'base64' &&
          message.data?.content === expectedContent) {
        matched = { socketId: params.requestId, requestId: message.requestId };
      }
      return;
    }
    if (!matched || params.requestId !== matched.socketId || message.requestId !== matched.requestId) return;
    if (message.success !== true) {
      finish(saveError('Make did not acknowledge the source write as successful. No retry was attempted.',
        'MAKE_SAVE_REJECTED', message.success === false ? 'rejected' : 'unknown'));
      return;
    }
    if (message.data?.path !== remotePath || message.data?.size !== bytes) {
      finish(saveError('Make save acknowledgement did not match the source path and byte count; persistence is unknown. No retry was attempted.',
        'MAKE_SAVE_ACK_MISMATCH'));
      return;
    }
    const { writtenAtMs, modifiedAtMs } = message.data;
    if (![writtenAtMs, modifiedAtMs].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      finish(saveError('Make save acknowledgement has invalid timestamps; persistence is unknown. No retry was attempted.',
        'MAKE_SAVE_ACK_MISMATCH'));
      return;
    }
    finish(null, { path, bytes, writtenAtMs, modifiedAtMs });
  }

  try {
    const removeListener = transport.onEvent(listener);
    if (typeof removeListener !== 'function') throw new Error('Make save event subscription does not support cleanup.');
    unsubscribe = removeListener;
    // Also clean up correctly if a transport delivers an event synchronously
    // during registration (normal CDP delivery is asynchronous).
    if (settled) cleanup();
    else timer = setTimeout(() => finish(saveError(
      'Timed out waiting for Make save acknowledgement; persistence is unknown. No retry was attempted.',
      'MAKE_SAVE_TIMEOUT')), timeoutMs);
  } catch (error) {
    finish(saveError('Unable to register Make save observation.', 'MAKE_SAVE_OBSERVER_UNAVAILABLE'));
    throw error;
  }

  return {
    promise,
    cancel() {
      finish(saveError('Make save observation was cancelled; persistence is unknown.', 'MAKE_SAVE_CANCELLED'));
    },
  };
}
