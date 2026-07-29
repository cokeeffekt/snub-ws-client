const WORKER_SOURCE = "const worker=function(){const e=[];let n,o,t=null,r=null,s=Promise.resolve(),a=()=>{},c={};const l=\"undefined\"!=typeof WorkerGlobalScope&&self instanceof WorkerGlobalScope,i=\"undefined\"!=typeof SharedWorkerGlobalScope&&self instanceof SharedWorkerGlobalScope;return i?self.onconnect=function(n){const o=n.ports[0];e.push(o),o.onmessage=d,o.start(),f([\"_internal:connected\"])}:l&&(self.onmessage=d,f([\"_internal:connected\"])),{postToMain:e=>a=e,handleIncomingMessage:d,ready(){f([\"_internal:connected\"])}};function f(n,o){if(n=stringifyJson(n),o)try{o.postMessage(n)}catch(n){const t=e.indexOf(o);t>-1&&e.splice(t,1)}else if(i)for(let o=e.length-1;o>=0;o--)try{e[o].postMessage(n)}catch(n){e.splice(o,1)}else l?self.postMessage(n):a({data:n})}function d(e){const[n,o]=parseJson(e.data),r=i?e.target:null;\"_config\"===n&&(c={...c,...o},c.httpUrl=c.url.replace(/^ws/,\"http\")),\"_connect\"===n&&p(o,r),\"_reconnect\"===n&&p(o,r,!0),\"_close\"===n&&t&&t.close(...o),\"_send\"===n&&t&&t.send(stringifyJson(o))}function p(e,a,l){return s=s.then((()=>async function(e,s,a){a&&void 0===e&&(e=n);const l=stringifyJson(e??null),i=t&&(0===t.readyState||1===t.readyState);if(!a&&i&&l===r)return void(void 0!==o&&f([\"_internal:socket-connect\",o],s));if(t){const e=t;await new Promise((n=>{if(3===e.readyState)return n();e.addEventListener(\"close\",n,{once:!0}),e.close()}))}r=l,n=e,o=void 0;const d=new WebSocket(c.url);t=d,d.onopen=()=>{d.send(stringifyJson([\"_auth\",e]))},d.onmessage=e=>{const[n,t]=parseJson(e.data);return\"_acceptAuth\"===n?(o=t,f([\"_internal:socket-connect\",t])):\"_offload\"===n?(async()=>{const e=new AbortController,n=setTimeout((()=>e.abort()),3e4);try{const n=await fetch(c.httpUrl+`?offload=${t}`,{signal:e.signal});if(!n.ok)throw new Error(`offload fetch failed: ${n.status}`);let o=await n.text();o=parseJson(o),f([...o])}catch(e){console.error(\"Snub-Ws-Socket => Offload error:\",e)}finally{clearTimeout(n)}})():f([n,t])},d.onclose=e=>{f([\"_internal:socket-disconnected\",{code:e.code,reason:e.reason}]),t===d&&(t=null,r=null,o=void 0)},d.onerror=()=>{f([\"_internal:socket-error\",{message:\"WebSocket error\",timestamp:Date.now()}])}}(e,a,l))).catch((e=>{console.error(\"Snub-Ws-Socket => Connect error:\",e)})),s}}(\"undefined\"!=typeof self&&self);export default{postMessage:worker.handleIncomingMessage,postToMain:worker.postToMain,ready:worker.ready};function stringifyJson(e){return JSON.stringify(e,((e,n)=>n instanceof Map?{dataType:\"Map\",value:Array.from(n.entries())}:n instanceof Set?{dataType:\"Set\",value:Array.from(n)}:n))}function parseJson(e){return JSON.parse(e,((e,n)=>n&&\"Map\"===n.dataType?new Map(n.value):n&&\"Set\"===n.dataType?new Set(n.value):n))}";
          let blobUrl = null;
          function workerBlobUrl() {
            if (!blobUrl) {
              const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
              blobUrl = URL.createObjectURL(blob);
            }
            return blobUrl;
          }

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
class SnubWsClient {
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
        }        const [resolve, reject, timeout] = findReply;
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

export { SnubWsClient as default };
//# sourceMappingURL=snub-ws-client.esm.js.map
