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
- Calling `connect()` from any tab closes the current socket and opens a new one. All tabs are affected.
- `onopen` and `onclose` fire in all tabs when the shared socket opens or closes.

If you need per-tab isolation use `workerType: 'WEB_WORKER'` — each tab gets its own socket.

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

---

### `client.send(event, payload)`

Fire-and-forget. Sends `[event, payload]` to the server with no reply.

```js
client.send('chat:message', { text: 'hello' });
```

---

### `client.fetch(event, payload)`

Sends a message and returns a `Promise` that resolves with the server's reply. Times out after `replyTimeout` ms.

```js
const result = await client.fetch('user:get', { id: 42 });
```

The server must call `reply(data)` from its event handler for the promise to resolve.

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
