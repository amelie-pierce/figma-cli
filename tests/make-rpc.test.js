import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { captureMakeFileSocket } from '../src/make-rpc.js';

function setup() {
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    send(payload) { this.sent.push(JSON.parse(payload)); }
    reply(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  }
  const location = { href: 'https://www.figma.com/make/Exact/File' };
  const context = vm.createContext({ WebSocket: Socket, location, URL, setTimeout, clearTimeout });
  const bridge = vm.runInContext(`(${captureMakeFileSocket.toString()})('Exact', 'package.json', 1000)`, context);
  return { Socket, location, context, bridge, socket: new Socket() };
}

test('captures only the requested project file read and restores send immediately', async () => {
  const { Socket, bridge, socket } = setup();
  try {
    socket.send(JSON.stringify({ type: 'fs/file/read', data: { path: 'code/other.tsx', workspaceId: 'wrong' } }));
    assert.equal(bridge.status().captured, false);
    socket.send(JSON.stringify({ type: 'fs/file/read', data: { path: 'code/package.json', workspaceId: 'selected-workspace' } }));
    assert.equal(bridge.status().captured, true);
    assert.equal(Socket.prototype.send.figmaCliCapture, undefined);
    const pending = bridge.request('fs/file/write', { path: 'code/src/Button.tsx', content: 'YQ==', encoding: 'base64' }, 'new-id');
    assert.equal(socket.sent.at(-1).data.workspaceId, 'selected-workspace');
    socket.reply({ type: 'fs/file/write', requestId: 'unrelated', success: false });
    socket.reply({ type: 'fs/file/write', requestId: 'new-id', success: true, data: { path: 'code/src/Button.tsx' } });
    assert.equal((await pending).success, true);
  } finally { bridge.dispose(); }
});

test('rejects uncaptured sockets, unsafe paths, unsupported methods and project navigation', () => {
  const { bridge, socket, location } = setup();
  try {
    assert.throws(() => bridge.request('fs/file/write', { path: 'code/a' }, 'a'), /unavailable/);
    socket.send(JSON.stringify({ type: 'fs/file/read', data: { path: 'code/package.json', workspaceId: 'workspace' } }));
    for (const path of ['/etc/passwd', 'code/../a', 'code/a\\b', 'code//a']) {
      assert.throws(() => bridge.request('fs/file/write', { path }, 'a'), /Invalid/);
    }
    assert.throws(() => bridge.request('terminal/exec', { path: 'code/a' }, 'a'), /Unsupported/);
    location.href = 'https://www.figma.com/make/Other/File';
    assert.throws(() => bridge.request('fs/file/write', { path: 'code/a' }, 'a'), /unavailable/);
    assert.equal(socket.sent.length, 1);
  } finally { bridge.dispose(); }
});

test('disposal restores the hook and rejects pending work instead of retrying', async () => {
  const { bridge, socket, Socket } = setup();
  socket.send(JSON.stringify({ type: 'fs/file/read', data: { path: 'code/package.json', workspaceId: 'workspace' } }));
  const pending = bridge.request('fs/file/read', { path: 'code/a' }, 'a');
  bridge.dispose();
  await assert.rejects(pending, /cancelled/);
  assert.equal(Socket.prototype.send.figmaCliCapture, undefined);
  assert.equal(socket.sent.length, 2);
});
