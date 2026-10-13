import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { MakeTransport } from '../src/make-transport.js';

async function fakeCDP(t, { targets, handle, hangDiscovery = false, upgrade = true } = {}) {
  const requests = [];
  const sockets = new Set();
  let port;
  const makeTarget = (key = 'ExactKey', extra = {}) => ({
    id: key,
    type: 'page',
    title: `Make ${key}`,
    url: `https://www.figma.com/make/${key}/Title`,
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${key}`,
    ...extra,
  });
  const server = createServer((req, res) => {
    if (hangDiscovery) return;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(targets ? targets(makeTarget, port) : [makeTarget()]));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    if (upgrade) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      if (handle) handle(ws, request);
      else ws.send(JSON.stringify({ id: request.id, result: { result: { value: 'value' } } }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = server.address().port;
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    const closed = new Promise((resolve) => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await closed;
  });
  return { port, requests, makeTarget };
}

function clientFor(t, port, timeoutMs = 500) {
  const client = new MakeTransport({ port, timeoutMs });
  t.after(() => client.close());
  return client;
}

test('discovers only Make page targets with exact Figma origins and local same-port WebSockets', async (t) => {
  const { port } = await fakeCDP(t, { targets: (make, p) => [
    make(),
    make('Design', { url: 'https://www.figma.com/design/Design/Test' }),
    make('Worker', { type: 'worker' }),
    make('Spoof', { url: 'https://www.figma.com.evil.test/make/Spoof/Test' }),
    make('Suffix', { url: 'https://evilfigma.com/make/Suffix/Test' }),
    make('HTTP', { url: 'http://www.figma.com/make/HTTP/Test' }),
    make('Credentials', { url: 'https://user@www.figma.com/make/Credentials/Test' }),
    make('Remote', { webSocketDebuggerUrl: `ws://example.com:${p}/devtools/page/Remote` }),
    make('WrongPort', { webSocketDebuggerUrl: `ws://127.0.0.1:${p === 65535 ? p - 1 : p + 1}/devtools/page/WrongPort` }),
    make('WSCredentials', { webSocketDebuggerUrl: `ws://user@127.0.0.1:${p}/devtools/page/WSCredentials` }),
  ] });
  const targets = await MakeTransport.listTargets({ port, timeoutMs: 500 });
  assert.deepEqual(targets.map((target) => target.fileKey), ['ExactKey']);
});

test('connects by exact key or canonical URL, never by a title or substring', async (t) => {
  const { port, requests } = await fakeCDP(t, { targets: (make) => [make('ExactKeyLong'), make()] });
  const client = clientFor(t, port);
  await client.connect('https://www.figma.com/make/ExactKey/Another-Title?node-id=1');
  assert.equal(client.target.fileKey, 'ExactKey');
  assert.equal(await client.evaluate('document.title'), 'value');
  assert.deepEqual(requests[0].params, { expression: 'document.title', returnByValue: true, awaitPromise: true });
  assert.equal(requests.length, 1, 'connection does not inject or invoke Plugin API code');
  client.close();
  await assert.rejects(client.connect('Exact'), /No open/);
  await assert.rejects(client.connect('Make ExactKey'), /exact Figma Make file key/);
  await assert.rejects(client.connect('https://evil.test/make/ExactKey'), /exact Figma Make file key/);
});

test('selects the requested project page by key when another project page is titled with its Files filename', async (t) => {
  const { port } = await fakeCDP(t, { targets: (make) => [
    make('OtherKey', { title: 'App.tsx – Figma Make' }),
    make('ExactKey', { title: 'App.tsx – Figma Make' }),
  ] });
  const client = clientFor(t, port);
  await client.connect('ExactKey');
  assert.equal(client.target.fileKey, 'ExactKey');
  assert.equal(client.target.url, 'https://www.figma.com/make/ExactKey/Title');
});

test('rejects duplicate tabs for the same file instead of choosing one', async (t) => {
  const { port, requests } = await fakeCDP(t, { targets: (make) => [make(), make('ExactKey', { id: 'duplicate' })] });
  await assert.rejects(clientFor(t, port).connect('ExactKey'), /Multiple open/);
  assert.equal(requests.length, 0);
});

test('correlates out-of-order responses and propagates protocol and evaluation errors', async (t) => {
  let first;
  const { port } = await fakeCDP(t, { handle: (ws, request) => {
    if (request.method === 'First') first = request;
    else if (request.method === 'Second') {
      ws.send(JSON.stringify({ id: request.id, result: 'second' }));
      ws.send(JSON.stringify({ id: first.id, result: 'first' }));
    } else if (request.method === 'Bad') ws.send(JSON.stringify({ id: request.id, error: { message: 'unsupported command' } }));
    else ws.send(JSON.stringify({ id: request.id, result: { exceptionDetails: { exception: { description: 'ReferenceError: missing' } } } }));
  } });
  const client = clientFor(t, port);
  await client.connect('ExactKey');
  assert.deepEqual(await Promise.all([client.send('First'), client.send('Second')]), ['first', 'second']);
  await assert.rejects(client.send('Bad'), /unsupported command/);
  await assert.rejects(client.evaluate('missing'), /ReferenceError: missing/);
});

test('times out a command exactly once without replaying it', async (t) => {
  const { port, requests } = await fakeCDP(t, { handle: () => {} });
  const client = clientFor(t, port);
  await client.connect('ExactKey');
  await assert.rejects(client.send('Runtime.evaluate', { expression: 'change()' }, { timeoutMs: 40 }), /not retried/);
  assert.equal(requests.length, 1);
  assert.equal(client._pending.size, 0);
});

test('delivers CDP events separately from responses and supports unsubscribe', async (t) => {
  const { port } = await fakeCDP(t, { handle: (ws, request) => {
    ws.send(JSON.stringify({ method: 'Runtime.executionContextsCleared', params: {} }));
    ws.send(JSON.stringify({ id: request.id, result: { ok: true } }));
  } });
  const client = clientFor(t, port);
  await client.connect('ExactKey');
  const events = [];
  const unsubscribe = client.onEvent((event) => events.push(event));
  client.onEvent(() => { throw new Error('consumer failure'); });
  assert.deepEqual(await client.send('Reload'), { ok: true });
  assert.deepEqual(events, [{ method: 'Runtime.executionContextsCleared', params: {} }]);
  unsubscribe();
  await client.send('ReloadAgain');
  assert.equal(events.length, 1);
});

test('rejects pending commands when the peer closes', async (t) => {
  const { port, requests } = await fakeCDP(t, { handle: (ws) => ws.close() });
  const client = clientFor(t, port);
  await client.connect('ExactKey');
  await assert.rejects(client.send('Wait'), /connection closed/);
  assert.equal(requests.length, 1);
  assert.equal(client._pending.size, 0);
});

test('explicit close rejects all pending commands and prevents further sends', async (t) => {
  const { port } = await fakeCDP(t, { handle: () => {} });
  const client = clientFor(t, port);
  await client.connect('ExactKey');
  const pending = [client.send('One'), client.send('Two')];
  const assertions = pending.map((promise) => assert.rejects(promise, /transport closed/));
  client.close();
  await Promise.all(assertions);
  await assert.rejects(client.send('Three'), /not connected/);
});

test('malformed messages fail pending commands instead of leaving them hanging', async (t) => {
  const { port } = await fakeCDP(t, { handle: (ws) => ws.send('{broken') });
  const client = clientFor(t, port);
  await client.connect('ExactKey');
  await assert.rejects(client.send('Wait'), /Invalid Make CDP response/);
});

test('bounds discovery and connection handshake time', async (t) => {
  const discovery = await fakeCDP(t, { hangDiscovery: true });
  await assert.rejects(MakeTransport.listTargets({ port: discovery.port, timeoutMs: 40 }), /timeout|timed out/i);
  const handshake = await fakeCDP(t, { upgrade: false });
  const client = clientFor(t, handshake.port);
  await assert.rejects(client.connect('ExactKey', { timeoutMs: 40 }), /timed out/);
});

test('close aborts an in-progress connection without opening a socket later', async (t) => {
  const { port } = await fakeCDP(t, { hangDiscovery: true });
  const client = clientFor(t, port);
  const connecting = client.connect('ExactKey');
  const rejected = assert.rejects(connecting, /transport closed/);
  client.close();
  await rejected;
  assert.equal(client.ws, null);
});
