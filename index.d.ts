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
   */
  connect(auth?: unknown): void;

  /** Fire-and-forget. Sends `[event, payload]` to the server with no reply. */
  send(event: string, payload?: unknown): void;

  /**
   * Sends a message and returns a Promise that resolves with the server's reply.
   * Rejects with `Error('Timeout')` if no reply arrives within `replyTimeout` ms.
   * The server handler must call `reply(data)` for the promise to resolve.
   */
  fetch<T = unknown>(event: string, payload?: unknown): Promise<T>;

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

  /** Called when the socket emits an error. Fires just before onclose in most cases. */
  onerror(fn: () => void): void;
}
