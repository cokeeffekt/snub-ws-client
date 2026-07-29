# snub-ws-client

Browser WebSocket client for [snub-ws](https://github.com/cokeeffekt/snub-ws).

Handles authentication and gives you a live socket connection. Reconnection is intentionally left to your application — see [Reconnection](#reconnection).

---

## Install

```
npm install snub-ws-client
```

Or include the minified IIFE build directly in a page (exposes `SnubWsClient` as a global):

```html
<script src="dist/snub-ws-client.min.js"></script>
```

---

## Quick start

```js
import SnubWsClient from 'snub-ws-client';

const client = new SnubWsClient({ url: 'wss://example.com' });

client.onopen((acceptPayload) => {
  console.log('connected', acceptPayload);
});

client.onclose(({ code, reason }) => {
  console.log('closed', code, reason);
});

client.onmessage((event, payload) => {
  console.log(event, payload);
});

client.connect({ username: 'alice', password: 'secret' });
```

---

## Shared socket (important)

By default `SnubWsClient` runs inside a **SharedWorker**, meaning **all tabs from the same origin share a single WebSocket connection**. This reduces server-side connection count — one user, one socket, regardless of how many tabs they have open.

Consequences to be aware of:

- Every open tab receives every inbound message. Your `onmessage` handler fires in all tabs.
- `onopen` and `onclose` fire in all tabs when the shared socket opens or closes.
- `connect()` is idempotent. Calling it with the **same** auth while a socket is already live does not touch that socket — the calling tab just gets its `onopen` back. So a remount, a route change, or a second tab booting cannot drop the connection the other tabs are using.
- Calling `connect()` with **different** auth does close the shared socket and open a new one. Every tab sees `onclose` then `onopen`. Use `reconnect()` if you want that reset without changing auth.

If you need per-tab isolation use `workerType: 'WEB_WORKER'` — each tab gets its own socket.

### Sharing needs a stable worker URL

A SharedWorker is identified by the **URL of its script**, so tabs only share one worker — and one socket — when every tab passes the same URL. The client resolves that URL in this order:

1. **`workerUrl`** — an explicit URL. This is the documented way to get sharing; you control where the file is served from.
2. **The worker file shipped next to the bundle** — `new URL('./snub-ws-client.worker.js', import.meta.url)`. Zero config, and it shares. Reliable for the ESM build loaded from your own origin; the CJS build usually gets re-bundled by the consumer, in which case use `workerUrl`.
3. **An inlined `blob:` URL** — always loads, but a blob URL is unique per document, so every tab builds its own worker and its own socket. Sharing is silently lost, so the client warns when it lands here.

`npm install snub-ws-client` puts the file at `node_modules/snub-ws-client/dist/snub-ws-client.worker.js` (also reachable as `snub-ws-client/worker`). Copy it into whatever directory you serve static assets from and point `workerUrl` at it:

```js
new SnubWsClient({
  url: 'wss://example.com',
  workerUrl: '/static/snub-ws-client.worker.js',
});
```

**The worker URL must be same-origin with the page.** Browsers reject a cross-origin worker script outright, so the worker cannot be served from a CDN — even when the bundle itself is.

---

## Config

```js
new SnubWsClient({
  // WebSocket server URL
  url: 'wss://example.com',

  // Worker strategy: 'SHARED_WORKER' (default), 'WEB_WORKER', 'MAIN_THREAD'
  // SHARED_WORKER — all tabs share one socket (see above)
  // WEB_WORKER    — each tab has its own socket
  // MAIN_THREAD   — no worker, runs inline (fallback for restricted environments)
  workerType: 'SHARED_WORKER',

  // Name used to identify the SharedWorker. If you create two SnubWsClient
  // instances on the same origin they must have different names or they will
  // share the same worker and the same socket.
  workerName: 'Snub-Ws-Client-Worker',

  // URL of snub-ws-client.worker.js, served from your own origin. Required for
  // cross-tab sharing unless the bundle is loaded from your origin with the
  // worker file sitting next to it. Must be same-origin with the page.
  workerUrl: '/static/snub-ws-client.worker.js',

  // Milliseconds before a fetch() reply times out
  replyTimeout: 10000,
});
```

---

## API

### `client.connect(auth)`

Opens the WebSocket and authenticates. `auth` is passed as the `_auth` payload to the server.

```js
client.connect({ username: 'alice', password: 'secret' });
```

If called before the worker is ready it is queued and replayed automatically.

Idempotent: with a socket already live and the same `auth`, this is a no-op and `onopen` fires again for the calling tab only. Safe to call on every mount. A different `auth` reopens the socket — on a SharedWorker that affects every tab.

---

### `client.reconnect(auth?)`

Closes any live socket and opens a fresh one, even when `auth` has not changed. Omit `auth` to reuse the credentials already in play.

```js
client.reconnect(); // force a new socket with the same auth
```

On a SharedWorker every tab sees `onclose` then `onopen`.

---

### `client.send(event, payload)`

Fire-and-forget. Sends `[event, payload]` to the server with no reply.

```js
client.send('chat:message', { text: 'hello' });
```

---

### `client.fetch(event, payload, opts?)`

Sends a message and returns a `Promise` that resolves with the server's reply. Times out after `replyTimeout` ms (rejects with `Error('Timeout')`).

```js
const result = await client.fetch('user:get', { id: 42 });
```

The server must call `reply(data)` from its event handler for the promise to resolve.

Pass `opts.timeout` to override the reply timeout for a single call — useful for long-running operations (large syncs, builds) that exceed the global `replyTimeout`:

```js
const deck = await client.fetch('deck:build', { id }, { timeout: 60000 });
```

---

### `client.close(code?, reason?)`

Closes the socket. `code` must be `1000` or in the range `3000–4999` per the WebSocket spec.

```js
client.close(1000, 'user logged out');
client.close(); // clean close, no code
```

---

### `client.state`

Read-only string. `'init'` until the worker is ready, `'READY'` once the worker has started.

Note: this reflects worker readiness, not socket connection status. Use `onopen` / `onclose` for socket state.

---

### `client.onopen(fn)`

Called when the server accepts authentication. `fn` receives the `_acceptAuth` payload from the server.

```js
client.onopen((payload) => {
  console.log('auth accepted', payload);
});
```

---

### `client.onclose(fn)`

Called when the socket closes. `fn` receives `{ code, reason }`.

```js
client.onclose(({ code, reason }) => {
  console.log('socket closed', code, reason);
});
```

---

### `client.onmessage(fn)`

Called for every inbound message that is not an internal protocol event. `fn` receives `(event, payload)`.

```js
client.onmessage((event, payload) => {
  if (event === 'chat:message') renderMessage(payload);
});
```

---

### `client.onerror(fn)`

Called when the underlying socket emits an error. This is **signal-only**: browser `WebSocket` error events carry no actionable detail by design, so `fn` receives a synthesized `{ message, timestamp }` — not a real error object. For *why* a connection actually dropped, use the `{ code, reason }` from `onclose`, which fires right after.

```js
client.onerror(({ message, timestamp }) => {
  console.warn('socket error', message, timestamp);
});
```

---

## Reconnection

The client does not reconnect automatically. Implement reconnection in your `onclose` handler. A simple exponential backoff example:

```js
import SnubWsClient from 'snub-ws-client';

function createClient(auth) {
  const client = new SnubWsClient({ url: 'wss://example.com' });
  let attempt = 0;

  client.onopen(() => {
    attempt = 0; // reset backoff on successful connect
  });

  client.onclose(({ code, reason }) => {
    // 1000 = normal close, 4xxx = app-initiated (e.g. logged out) — don't reconnect
    if (code === 1000 || code >= 4000) return;

    const delay = Math.min(1000 * 2 ** attempt, 30000);
    attempt++;
    console.log(`reconnecting in ${delay}ms (attempt ${attempt})`);
    setTimeout(() => client.connect(auth), delay);
  });

  client.onmessage((event, payload) => {
    // handle messages
  });

  client.connect(auth);
  return client;
}

const client = createClient({ username: 'alice', password: 'secret' });
```

---

## Works with

- [snub-ws](https://github.com/cokeeffekt/snub-ws) — WebSocket server middleware
- [snub](https://github.com/cokeeffekt/snub) — the message bus both sides run on
