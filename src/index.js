import { workerBlobUrl } from './worker.js'; // Blob fallback, built lazily

// Resolved once, at module evaluation time, and deliberately not lazily: in the
// iife/cjs builds rollup compiles `import.meta.url` down to
// `document.currentScript.src`, which is only readable while this script is
// being evaluated. Reading it later yields null.
// The string literal must stay a literal — bundlers pattern-match
// `new URL('...', import.meta.url)` to relocate the worker asset.
const BUNDLED_WORKER_URL = (() => {
  try {
    return new URL('./snub-ws-client.worker.js', import.meta.url).href;
  } catch (e) {
    return null; // no import.meta and no currentScript to resolve against
  }
})();

const DEFAULT_CONFIG = {
  workerType: 'SHARED_WORKER', // 'SHARED_WORKER', 'WEB_WORKER', 'MAIN_THREAD'
  workerName: 'Snub-Ws-Client-Worker',
  workerUrl: null, // explicit URL of snub-ws-client.worker.js; wins if set
  url: 'ws://localhost:8080',
  replyTimeout: 10000,
};
export default class SnubWsClient {
  #workerType = null;
  #worker = null;
  #config = DEFAULT_CONFIG;
  #state = 'init';
  #pendingConnect = null;
  #waitingReplies = new Map();
  #scriptUrl = null;
  #usingBlob = false;

  // Event handlers
  #onmessage = () => {};
  #onopen = () => {};
  #onclose = () => {};
  #onerror = () => {};

  constructor(config) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
    // start the worker
    this.#attachWorker(this.#startWorker());
  }

  #attachWorker(worker) {
    this.#worker = worker;
    JSONifyWorker(this.#worker); // JSONify the worker
    // A worker script that fails to load (missing file, blocked by CSP) reports
    // asynchronously, so the try/catch in #startWorker cannot see it. If that
    // happens before the worker handshake, rebuild from the inlined blob so a
    // misplaced worker file degrades to today's behaviour instead of a client
    // that never reaches READY.
    this.#worker.onerror = (err) => {
      if (this.#state !== 'init' || this.#usingBlob)
        return console.error('SnubWsClient: worker error', err);
      console.warn(
        'SnubWsClient: worker script "' +
          this.#scriptUrl +
          '" failed to load, falling back to the inlined blob worker — cross-tab sharing is disabled. Serve snub-ws-client.worker.js and set `workerUrl`.'
      );
      try {
        this.#worker.terminate?.();
      } catch (e) {}
      this.#attachWorker(this.#startWorker(true));
    };
    this.#worker.onmessage = (event) => {
      const [key, value] = parseJson(event.data);
      if (key === '_internal:connected') {
        this.#worker.postMessage([
          '_config',
          {
            url: this.#config.url,
          },
        ]);
        this.#state = 'READY';
        // Wrapped in an array so a queued connect() with no auth at all still
        // replays — the bare value would be falsy and get dropped.
        if (this.#pendingConnect) this.connect(this.#pendingConnect[0]);
        this.#pendingConnect = null;
      }
      if (key === '_internal:socket-disconnected') {
        this.#onclose(value);
      }
      if (key === '_internal:socket-connect') {
        this.#onopen(value);
      }
      if (key === '_internal:socket-error') {
        this.#onerror(value);
      }
      const [prefix, uid, type] = key.split(':');
      if (prefix === '_internal') return;

      if (prefix === '_r') {
        const findReply = this.#waitingReplies.get(
          prefix + ':' + uid
        );
        if (!findReply) {
          console.warn('Reply not found:', key, value); // dont know what this is about, keeping an eye on it.
          return;
        };
        const [resolve, reject, timeout] = findReply;
        clearTimeout(timeout);
        this.#waitingReplies.delete(prefix + ':' + uid);
        if (type === 'error' && reject) return reject(value);
        if (resolve) return resolve(value);
        return;
      }
      this.#onmessage(key, value);
    };
  }

  send(event, payload) {
    this.#worker.postMessage(['_send', [event, payload]]);
  }
  fetch(event, payload, opts) {
    const timeoutMs = opts?.timeout ?? this.#config.replyTimeout;
    return new Promise((resolve, reject) => {
      const uid = '_r:' + generateUID();
      const timeout = setTimeout(() => {
        reject(new Error('Timeout'));
        this.#waitingReplies.delete(uid);
      }, timeoutMs);
      this.#waitingReplies.set(uid, [resolve, reject, timeout]);
      this.#worker.postMessage(['_send', [event, payload, uid]]);
    });
  }

  connect(auth) {
    if (this.#state === 'READY') {
      this.#worker.postMessage(['_connect', auth]);
    } else {
      this.#pendingConnect = [auth];
    }
  }

  // Forces a fresh socket even when one is already open with this auth. Before
  // the worker is ready there is nothing to reset, so it degrades to connect().
  reconnect(auth) {
    if (this.#state !== 'READY') {
      this.#pendingConnect = [auth];
      return;
    }
    // A trailing undefined would serialize to null, which the worker cannot
    // tell apart from "connect with no auth" — omit it instead, so the worker
    // knows to reuse the auth already in play.
    this.#worker.postMessage(
      auth === undefined ? ['_reconnect'] : ['_reconnect', auth]
    );
  }

  close(code, reason) {
    this.#worker.postMessage(['_close', [code, reason].filter((v) => v !== undefined)]);
  }

  get state() {
    return this.#state;
  }

  onopen(fn) {
    this.#onopen = fn;
  }
  onmessage(fn) {
    this.#onmessage = fn;
  }

  onclose(fn) {
    this.#onclose = fn;
  }

  onerror(fn) {
    this.#onerror = fn;
  }

  /**
   * Resolution order for the worker script URL:
   *   1. `config.workerUrl` — consumer controls hosting, sharing works
   *   2. the worker file shipped next to this bundle — zero config, shares
   *   3. an inlined blob: URL — always loads, but is unique per document, so
   *      every tab gets its own SharedWorker and sharing is lost
   * The URL must be same-origin with the page; browsers reject a cross-origin
   * worker script outright, so a CDN-hosted worker cannot be used.
   */
  #resolveWorkerUrl(forceBlob) {
    if (forceBlob) return workerBlobUrl();

    const explicit = this.#config.workerUrl;
    if (explicit) {
      if (!isSameOrigin(explicit))
        console.warn(
          'SnubWsClient: workerUrl "' +
            explicit +
            '" is not same-origin with this page; browsers reject cross-origin worker scripts.'
        );
      return explicit;
    }

    if (BUNDLED_WORKER_URL && isSameOrigin(BUNDLED_WORKER_URL))
      return BUNDLED_WORKER_URL;

    if (this.#config.workerType === 'SHARED_WORKER')
      console.warn(
        'SnubWsClient: no same-origin worker URL could be resolved, using an inlined blob worker — each tab gets its own worker and its own socket, so cross-tab sharing is disabled. Serve snub-ws-client.worker.js from your own origin and pass it as `workerUrl`.'
      );

    return workerBlobUrl();
  }

  // Private functions
  #startWorker(forceBlob = false) {
    const requested = this.#config.workerType;
    const workerScriptUrl = this.#resolveWorkerUrl(forceBlob);
    this.#scriptUrl = workerScriptUrl;
    this.#usingBlob = workerScriptUrl.startsWith('blob:');

    // SharedWorker — one socket shared across all tabs on the same origin
    if (requested !== 'WEB_WORKER' && requested !== 'MAIN_THREAD') {
      if (typeof SharedWorker !== 'undefined') {
        try {
          const sharedWorker = new SharedWorkerWrapper(workerScriptUrl, {
            type: 'module',
            name: this.#config.workerName,
          });
          this.#workerType = 'sharedWorker';
          return sharedWorker;
        } catch (e) {}
      }
      if (requested === 'SHARED_WORKER')
        console.warn('SnubWsClient: SharedWorker not available, falling back to WebWorker');
    }

    // WebWorker — one socket per tab
    if (requested !== 'MAIN_THREAD') {
      if (typeof Worker !== 'undefined') {
        try {
          const webWorker = new Worker(workerScriptUrl, {
            type: 'module',
            name: this.#config.workerName,
          });
          this.#workerType = 'webWorker';
          return webWorker;
        } catch (e) {}
      }
      console.warn('SnubWsClient: WebWorker not available, falling back to main thread');
    }

    // Main thread fallback
    this.#workerType = 'mainThread';

    const mainThreadWorker = {
      postMessage: function (message) {},
      onmessage: function (event) {},
    };
    // Load the worker script in the main thread. Nothing is shared on this
    // path, so a failed load just retries against the inlined blob.
    import(workerScriptUrl)
      .catch((error) => {
        if (this.#usingBlob) throw error;
        console.warn(
          'SnubWsClient: worker script "' + workerScriptUrl + '" failed to load, falling back to the inlined blob worker',
          error
        );
        this.#usingBlob = true;
        return import(workerBlobUrl());
      })
      .then((module) => {
        mainThreadWorker.postMessage = (msg) => {
          module.default.postMessage({ data: stringifyJson(msg) });
        };
        mainThreadWorker.postToMain = module.default.postToMain((msg) => {
          mainThreadWorker.onmessage(msg);
        });
        module.default.ready();
      })
      .catch((error) => {
        console.error('Failed to load worker script:', error);
      });

    return mainThreadWorker;
  }
}

class SharedWorkerWrapper {
  constructor(url, options) {
    this.worker = new SharedWorker(url, options); // Load SharedWorker
    this.port = this.worker.port;

    // Start the port for communication
    this.port.start();

    // Proxy the onmessage event
    this.port.onmessage = (event) => {
      if (typeof this.onmessage === 'function') {
        this.onmessage(event); // Call the main thread's onmessage handler
      }
    };

    // Optional: Proxy onerror handling
    this.port.onerror = (error) => {
      if (typeof this.onerror === 'function') {
        this.onerror(error); // Call the main thread's onerror handler
      }
    };

    // A script that fails to load errors on the SharedWorker itself, not on the
    // port — without this a missing worker file is completely silent.
    this.worker.onerror = (error) => {
      if (typeof this.onerror === 'function') {
        this.onerror(error);
      }
    };
  }

  postMessage(message) {
    this.port.postMessage(message);
  }

  terminate() {
    this.port.close(); // Close the port to stop communication
  }
}

function JSONifyWorker(worker) {
  worker._postMessage = worker.postMessage;
  worker.postMessage = function (message) {
    worker._postMessage(stringifyJson(message));
  };
}

function isSameOrigin(url) {
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch (e) {
    return false; // no location (non-browser) or an unparsable URL
  }
}

function generateUID() {
  return crypto.randomUUID();
}

function stringifyJson(obj) {
  return JSON.stringify(obj, (key, value) => {
    if (value instanceof Map) {
      return {
        dataType: 'Map',
        value: Array.from(value.entries()), // Convert Map to array of key-value pairs
      };
    } else if (value instanceof Set) {
      return {
        dataType: 'Set',
        value: Array.from(value), // Convert Set to array
      };
    }
    return value;
  });
}

function parseJson(json) {
  return JSON.parse(json, (key, value) => {
    if (value && value.dataType === 'Map') {
      return new Map(value.value); // Convert array of key-value pairs back to Map
    } else if (value && value.dataType === 'Set') {
      return new Set(value.value); // Convert array back to Set
    }
    return value;
  });
}
