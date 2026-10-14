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

test('the project root may be listed but never read, written or deleted', () => {
  const { bridge, socket } = setup();
  try {
    socket.send(JSON.stringify({ type: 'fs/file/read', data: { path: 'code/package.json', workspaceId: 'workspace' } }));
    for (const type of ['fs/file/read', 'fs/file/write', 'fs/file/delete']) {
      assert.throws(() => bridge.request(type, { path: 'code' }, 'a'), /Invalid/, type);
    }
    assert.throws(() => bridge.request('fs/dir/list', { path: 'code/' }, 'a'), /Invalid/);
    bridge.request('fs/dir/list', { path: 'code', includeHidden: true }, 'root').catch(() => {});
    assert.equal(socket.sent.at(-1).data.path, 'code');
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

function provisioned(capturePath = null) {
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    url = 'wss://www.figma.com/api/agentcontrol/subscribe';
    sent = [];
    send(payload) { this.sent.push(JSON.parse(payload)); }
    reply(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  }
  const location = { href: 'https://www.figma.com/make/Exact/File' };
  const context = vm.createContext({ WebSocket: Socket, location, URL, setTimeout, clearTimeout });
  const capture = () => vm.runInContext(`(${captureMakeFileSocket.toString()})('Exact', ${JSON.stringify(capturePath)}, 1000)`, context);
  return { Socket, location, context, capture };
}
const provision = (socket, workspaceId = 'provisioned-workspace', success = true) => {
  socket.send(JSON.stringify({ type: 'control/provision', data: { namespace: 'n', workspaceId } }));
  socket.reply({ type: 'control/workspace_create_ack', success, data: { created: success } });
};

test('captures the socket that Make provisions on its own host, independent of file reads', () => {
  const { Socket, capture } = provisioned();
  const bridge = capture();
  try {
    const foreign = new Socket();
    foreign.url = 'wss://other.example/api/agentcontrol/subscribe';
    provision(foreign);
    const insecure = new Socket();
    insecure.url = 'ws://www.figma.com/api/agentcontrol/subscribe';
    provision(insecure);
    const unnamed = new Socket();
    provision(unnamed, '');
    assert.equal(bridge.status().captured, false);
    const socket = new Socket();
    provision(socket);
    assert.equal(bridge.status().captured && bridge.status().workspace, true);
    assert.equal(Socket.prototype.send.figmaCliCapture, undefined);
    bridge.request('fs/file/read', { path: 'code/src/specs/Field.md', encoding: 'base64' }, 'read-id').catch(() => {});
    assert.equal(socket.sent.at(-1).data.workspaceId, 'provisioned-workspace');
    assert.equal(foreign.sent.length, 1);
  } finally { bridge.dispose(); }
});

test('without a capture path any project source read identifies the socket', () => {
  const { Socket, capture } = provisioned();
  const bridge = capture();
  try {
    const socket = new Socket();
    socket.send(JSON.stringify({ type: 'fs/file/read', data: { path: 'other/file', workspaceId: 'w' } }));
    assert.equal(bridge.status().captured, false);
    socket.send(JSON.stringify({ type: 'fs/file/read', data: { path: 'code/src/lib/deep/Field.tsx', workspaceId: 'w' } }));
    assert.equal(bridge.status().captured, true);
  } finally { bridge.dispose(); }
});

test('concurrent bridges share one hook and a capture cached until the socket closes', () => {
  const { Socket, capture } = provisioned();
  const first = capture();
  const second = capture();
  const socket = new Socket();
  provision(socket);
  assert.equal(first.status().captured && second.status().captured, true);
  first.dispose();
  // A later bridge reuses the cached capture without hooking send again.
  const later = capture();
  assert.equal(Socket.prototype.send.figmaCliCapture, undefined);
  assert.equal(later.status().captured, true);
  socket.dispatchEvent(new Event('close'));
  assert.equal(later.status().captured, false);
  later.dispose(); second.dispose();
});

test('page-side replace compares the current saved bytes before sending its write', async () => {
  const { Socket, capture, location } = provisioned();
  const bridge = capture();
  const socket = new Socket();
  provision(socket);
  const answer = (content) => {
    const read = socket.sent.at(-1);
    socket.reply({ type: 'fs/file/read', requestId: read.requestId, success: true,
      data: { path: read.data.path, encoding: 'base64', content } });
  };
  try {
    const refused = bridge.replace('code/src/App.tsx', 'b2xk', 'bmV3', 'r1', 'w1');
    answer('Y2hhbmdlZA==');
    assert.match((await refused).refused, /changed after the backup/);
    assert.equal(socket.sent.some(message => message.type === 'fs/file/write'), false);

    const written = bridge.replace('code/src/App.tsx', 'b2xk', 'bmV3', 'r2', 'w2');
    answer('b2xk');
    await new Promise(resolve => setImmediate(resolve));
    const write = socket.sent.at(-1);
    assert.deepEqual([write.type, write.requestId, write.data.content], ['fs/file/write', 'w2', 'bmV3']);
    socket.reply({ type: 'fs/file/write', requestId: 'w2', success: true, data: { path: 'code/src/App.tsx', size: 3 } });
    assert.equal((await written).reply.success, true);

    // Navigation between the comparison and the write sends nothing.
    const navigated = bridge.replace('code/src/App.tsx', 'b2xk', 'bmV3', 'r3', 'w3');
    location.href = 'https://www.figma.com/make/Other/File';
    answer('b2xk');
    assert.match((await navigated).refused, /not sent/);
    assert.equal(socket.sent.filter(message => message.type === 'fs/file/write').length, 1);
  } finally { bridge.dispose(); }
});

test('a provisioned socket stays pending until its workspace is acknowledged', () => {
  const { Socket, capture } = provisioned();
  const bridge = capture();
  try {
    const first = new Socket();
    first.send(JSON.stringify({ type: 'control/provision', data: { workspaceId: 'first' } }));
    assert.equal(bridge.status().captured, false);
    assert.equal(bridge.status().pending, true);
    assert.throws(() => bridge.request('fs/file/read', { path: 'code/a' }, 'a'), /unavailable/);
    // A rejected acknowledgement never makes the socket usable.
    first.reply({ type: 'control/workspace_create_ack', success: false });
    assert.equal(bridge.status().captured, false);
    // A newer provision replaces the pending one; only its acknowledgement counts.
    const second = new Socket();
    second.send(JSON.stringify({ type: 'control/provision', data: { workspaceId: 'second' } }));
    first.reply({ type: 'control/workspace_create_ack', success: true });
    assert.equal(bridge.status().captured, false);
    second.reply({ type: 'control/workspace_create_ack', success: true });
    assert.equal(bridge.status().captured, true);
    assert.equal(bridge.workspaceId, 'second');
    assert.equal(Socket.prototype.send.figmaCliCapture, undefined);
  } finally { bridge.dispose(); }
});
