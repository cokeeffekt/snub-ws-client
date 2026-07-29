export interface SnubWsClientConfig {
  /** WebSocket server URL. Default: 'ws://localhost:8080' */
  url?: string;

  /**
   * Worker strategy.
   * - `'SHARED_WORKER'` — all tabs on the same origin share one socket (default)
   * - `'WEB_WORKER'`    — each tab gets its own socket
   * - `'MAIN_THREAD'`   — no worker, runs inline
   */
  workerType?: 'SHARED_WORKER' | 'WEB_WORKER' | 'MAIN_THREAD';

  /**
   * Name used to identify the SharedWorker.
   * Two SnubWsClient instances with the same name on the same origin will share
   * one worker and one socket. Default: 'Snub-Ws-Client-Worker'
   */
  workerName?: string;

  /**
   * URL of `snub-ws-client.worker.js`, served from your own origin.
   *
   * A SharedWorker is identified by its script URL, so tabs only share one
   * worker — and one socket — when this URL is stable. When it is not set the
   * client uses the worker file shipped next to the bundle, and falls back to
   * an inlined blob: URL, which is unique per document and therefore disables
   * cross-tab sharing.
   *
   * Must be same-origin with the page; browsers reject cross-origin worker
   * scripts, so a CDN-hosted worker will not load. Default: null
   */
  workerUrl?: string | null;

  /** Milliseconds before a fetch() reply times out. Default: 10000 */
  replyTimeout?: number;
}

export default class SnubWsClient {
  constructor(config?: SnubWsClientConfig);

  /**
   * Worker readiness state. `'init'` until the worker has started,
   * `'READY'` once it is running. Does not reflect socket connection status —
   * use onopen / onclose for that.
   */
  readonly state: 'init' | 'READY';

  /**
   * Opens the WebSocket connection and authenticates.
   * `auth` is sent to the server as the `_auth` payload.
   * Safe to call before the worker is ready — the call is queued automatically.
   *
   * Idempotent: if a socket is already live and `auth` is unchanged this is a
   * no-op and onopen fires again for the calling tab only, so a remount or a
   * route change cannot drop the socket other tabs are sharing. A *different*
   * `auth` does reset the shared socket. Use `reconnect()` to force one.
   */
  connect(auth?: unknown): void;

  /**
   * Closes any live socket and opens a fresh one, even when `auth` is
   * unchanged. Omit `auth` to reuse the credentials already in play.
   *
   * On a SharedWorker this affects every tab — they all see onclose then
   * onopen.
   */
  reconnect(auth?: unknown): void;

  /** Fire-and-forget. Sends `[event, payload]` to the server with no reply. */
  send(event: string, payload?: unknown): void;

  /**
   * Sends a message and returns a Promise that resolves with the server's reply.
   * Rejects with `Error('Timeout')` if no reply arrives in time.
   * The server handler must call `reply(data)` for the promise to resolve.
   *
   * @param opts.timeout Override the reply timeout (ms) for this call only.
   *   Defaults to the constructor's `replyTimeout`.
   */
  fetch<T = unknown>(
    event: string,
    payload?: unknown,
    opts?: { timeout?: number }
  ): Promise<T>;

  /**
   * Closes the socket.
   * `code` must be 1000 or in the range 3000–4999 per the WebSocket spec.
   */
  close(code?: number, reason?: string): void;

  /** Called when the server accepts authentication. Receives the `_acceptAuth` payload. */
  onopen(fn: (payload: unknown) => void): void;

  /** Called when the socket closes. */
  onclose(fn: (event: { code: number; reason: string }) => void): void;

  /** Called for every inbound message that is not an internal protocol event. */
  onmessage(fn: (event: string, payload: unknown) => void): void;

  /**
   * Called when the socket emits an error. Fires just before onclose in most cases.
   *
   * Signal-only: browser WebSocket error events carry no actionable detail, so
   * the callback receives a synthesized `{ message, timestamp }` rather than a
   * real error. Use `onclose`'s `{ code, reason }` for why a connection dropped.
   */
  onerror(fn: (err: { message: string; timestamp: number }) => void): void;
}
