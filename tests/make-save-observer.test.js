import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { watchMakeSave } from '../src/make-save-observer.js';

function eventSource() {
  const listeners = new Set();
  let unsubscribeCalls = 0;
  return {
    onEvent(listener) {
      listeners.add(listener);
      return () => { unsubscribeCalls++; listeners.delete(listener); };
    },
    emit(event) { for (const listener of [...listeners]) listener(event); },
    get listenerCount() { return listeners.size; },
    get unsubscribeCalls() { return unsubscribeCalls; },
  };
}

const path = 'src/App.tsx';
const content = 'export const title = "Tiếng Việt 🌍";\n';
const bytes = Buffer.byteLength(content, 'utf8');
const sendMessage = (changes = {}) => ({ type: 'fs/file/write', requestId: 'write-1', data: {
  path: `code/${path}`, content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64', workspaceId: 'private-workspace',
}, ...changes });
const ackMessage = (changes = {}) => ({ type: 'fs/file/write', requestId: 'write-1', success: true,
  data: { path: `code/${path}`, size: bytes, writtenAtMs: 1791770400000, modifiedAtMs: 1791770400010, privateField: 'not-returned' }, ...changes });
const frame = (direction, message, { socket = 'socket-1', opcode = 1 } = {}) => ({
  method: `Network.webSocketFrame${direction}`,
  params: { requestId: socket, response: { opcode, payloadData: typeof message === 'string' ? message : JSON.stringify(message) } },
});

describe('Make save acknowledgement observation', () => {
  it('registers synchronously and matches exact UTF-8 bytes without sending any requests', async () => {
    const transport = eventSource();
    const watcher = watchMakeSave(transport, { path, content });
    assert.equal(transport.listenerCount, 1);
    transport.emit(frame('Sent', sendMessage()));
    transport.emit(frame('Received', ackMessage()));
    assert.deepEqual(await watcher.promise, { path, bytes, writtenAtMs: 1791770400000, modifiedAtMs: 1791770400010 });
    assert.ok(bytes > content.length);
    assert.equal(transport.listenerCount, 0);
    assert.equal(transport.unsubscribeCalls, 1);
    watcher.cancel();
    assert.equal(transport.unsubscribeCalls, 1);
  });

  it('ignores unrelated, malformed, binary, and wrong-content frames', async () => {
    const transport = eventSource();
    const watcher = watchMakeSave(transport, { path, content });
    transport.emit(frame('Received', ackMessage())); // No outbound match yet.
    transport.emit(frame('Sent', 'not-json'));
    transport.emit(frame('Sent', 'null'));
    transport.emit(frame('Sent', '[]'));
    transport.emit(frame('Sent', sendMessage(), { opcode: 2 }));
    transport.emit(frame('Sent', sendMessage({ type: 'fs/file/read' })));
    transport.emit(frame('Sent', sendMessage({ requestId: null })));
    transport.emit(frame('Sent', sendMessage({ data: { ...sendMessage().data, content: 'd3Jvbmc=' } })));
    transport.emit(frame('Sent', sendMessage({ data: { ...sendMessage().data, path: 'code/src/Other.tsx' } })));
    transport.emit(frame('Sent', sendMessage({ data: { ...sendMessage().data, encoding: 'utf8' } })));
    transport.emit(frame('Received', ackMessage()));
    assert.equal(transport.listenerCount, 1);
    transport.emit(frame('Sent', sendMessage()));
    transport.emit(frame('Received', ackMessage({ requestId: 'other-write' })));
    transport.emit(frame('Received', ackMessage(), { socket: 'other-socket' }));
    transport.emit(frame('Received', ackMessage(), { opcode: 2 }));
    assert.equal(transport.listenerCount, 1);
    transport.emit(frame('Received', ackMessage()));
    assert.equal((await watcher.promise).bytes, bytes);
  });

  it('pins the first matched write and does not substitute a later acknowledgement', async () => {
    const transport = eventSource();
    const watcher = watchMakeSave(transport, { path, content });
    transport.emit(frame('Sent', sendMessage()));
    transport.emit(frame('Sent', sendMessage({ requestId: 'write-2' })));
    transport.emit(frame('Received', ackMessage({ requestId: 'write-2' })));
    assert.equal(transport.listenerCount, 1);
    transport.emit(frame('Received', ackMessage({ success: false, error: 'secret server detail' })));
    await assert.rejects(watcher.promise, (error) => {
      assert.equal(error.code, 'MAKE_SAVE_REJECTED');
      assert.equal(error.outcome, 'rejected');
      assert.doesNotMatch(error.message, /secret server detail/);
      return true;
    });
    assert.equal(transport.listenerCount, 0);
  });

  it('rejects acknowledgements for the wrong path or byte count', async () => {
    for (const data of [
      { ...ackMessage().data, path: 'code/other' },
      { ...ackMessage().data, size: content.length },
      { ...ackMessage().data, size: String(bytes) },
    ]) {
      const transport = eventSource();
      const watcher = watchMakeSave(transport, { path, content });
      transport.emit(frame('Sent', sendMessage()));
      transport.emit(frame('Received', ackMessage({ data })));
      await assert.rejects(watcher.promise, (error) => error.code === 'MAKE_SAVE_ACK_MISMATCH' && error.outcome === 'unknown');
      assert.equal(transport.listenerCount, 0);
    }
  });

  it('never exposes arbitrary acknowledgement fields as timestamp metadata', async () => {
    const transport = eventSource();
    const watcher = watchMakeSave(transport, { path, content });
    transport.emit(frame('Sent', sendMessage()));
    transport.emit(frame('Received', ackMessage({ data: { ...ackMessage().data, writtenAtMs: 'credential-looking-value' } })));
    await assert.rejects(watcher.promise, (error) => error.code === 'MAKE_SAVE_ACK_MISMATCH' && !error.message.includes('credential-looking-value'));
  });

  it('rejects a close of the matching socket after a matching outbound write', async () => {
    const transport = eventSource();
    const watcher = watchMakeSave(transport, { path, content });
    transport.emit({ method: 'Network.webSocketClosed', params: { requestId: 'socket-1' } });
    transport.emit(frame('Sent', sendMessage()));
    transport.emit({ method: 'Network.webSocketClosed', params: { requestId: 'other-socket' } });
    assert.equal(transport.listenerCount, 1);
    transport.emit({ method: 'Network.webSocketClosed', params: { requestId: 'socket-1' } });
    await assert.rejects(watcher.promise, (error) => error.code === 'MAKE_SAVE_CONNECTION_CLOSED' && error.outcome === 'unknown');
    assert.equal(transport.listenerCount, 0);
  });

  it('reports unknown persistence on timeout and removes the listener', async () => {
    for (const send of [false, true]) {
      const transport = eventSource();
      const watcher = watchMakeSave(transport, { path, content, timeoutMs: 5 });
      if (send) transport.emit(frame('Sent', sendMessage()));
      await assert.rejects(watcher.promise, (error) => error.code === 'MAKE_SAVE_TIMEOUT' && error.outcome === 'unknown');
      assert.equal(transport.listenerCount, 0);
      assert.equal(transport.unsubscribeCalls, 1);
    }
  });

  it('cancels idempotently, settles safely, and ignores later acknowledgements', async () => {
    const transport = eventSource();
    const watcher = watchMakeSave(transport, { path, content, timeoutMs: 5 });
    transport.emit(frame('Sent', sendMessage()));
    watcher.cancel();
    watcher.cancel();
    transport.emit(frame('Received', ackMessage()));
    assert.equal(transport.listenerCount, 0);
    assert.equal(transport.unsubscribeCalls, 1);
    // Delayed attachment would trigger unhandledRejection without the internal
    // catch, as can happen when an editor dispatch fails before awaiting save.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(watcher.promise, (error) => error.code === 'MAKE_SAVE_CANCELLED');
  });

  it('handles zero-byte content and numeric request IDs', async () => {
    const transport = eventSource();
    const watcher = watchMakeSave(transport, { path, content: '' });
    transport.emit(frame('Sent', sendMessage({ requestId: 0, data: { ...sendMessage().data, content: '' } })));
    transport.emit(frame('Received', ackMessage({ requestId: 0, data: { ...ackMessage().data, size: 0 } })));
    assert.equal((await watcher.promise).bytes, 0);
  });

  it('validates inputs before adding a listener', () => {
    const transport = eventSource();
    for (const invalidPath of ['', '/index.html', '../index.html', 'src//index.html', 'src\\index.html']) {
      assert.throws(() => watchMakeSave(transport, { path: invalidPath, content }), /project-relative/);
    }
    assert.throws(() => watchMakeSave(transport, { path, content: null }), /UTF-8/);
    assert.throws(() => watchMakeSave(transport, { path, content, timeoutMs: 0 }), /timeoutMs/);
    assert.throws(() => watchMakeSave({}, { path, content }), /support/);
    assert.equal(transport.listenerCount, 0);
  });
});
