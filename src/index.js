import workerScriptUrl from './worker.js'; // Will be a data URL if inlined

const DEFAULT_CONFIG = {
  workerType: 'SHARED_WORKER', // 'SHARED_WORKER', 'WEB_WORKER', 'MAIN_THREAD'
  workerName: 'Snub-Ws-Client-Worker',
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

  // Event handlers
  #onmessage = () => {};
  #onopen = () => {};
  #onclose = () => {};

  constructor(config) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
    // start the worker
    this.#worker = this.#startWorker();
    JSONifyWorker(this.#worker); // JSONify the worker
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
        if (this.#pendingConnect) this.connect(this.#pendingConnect);
        this.#pendingConnect = null;
      }
      if (key === '_internal:socket-disconnected') {
        this.#onclose(value);
      }
      if (key === '_internal:socket-connect') {
        this.#onopen(value);
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
  fetch(event, payload) {
    return new Promise((resolve, reject) => {
      const uid = '_r:' + generateUID();
      const timeout = setTimeout(() => {
        reject(new Error('Timeout'));
        this.#waitingReplies.delete(uid);
      }, this.#config.replyTimeout);
      this.#waitingReplies.set(uid, [resolve, reject, timeout]);
      this.#worker.postMessage(['_send', [event, payload, uid]]);
    });
  }

  connect(auth) {
    if (this.#state === 'READY') {
      this.#worker.postMessage(['_connect', auth]);
    } else {
      this.#pendingConnect = auth;
    }
  }

  close(code, reason) {
    this.#worker.postMessage(['_close', [code, reason]]);
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

  // Private functions
  #startWorker() {
    // Check if SharedWorker is supported
    if (
      typeof SharedWorker !== 'undefined' &&
      !['WEB_WORKER', 'MAIN_THREAD'].includes(this.#config.workerType)
    ) {
      try {
        const sharedWorker = new SharedWorkerWrapper(workerScriptUrl, {
          type: 'module',
          name: this.#config.workerName,
        });
        this.#workerType = 'sharedWorker';
        return sharedWorker;
      } catch (e) {}
    }

    // Check if Web Worker is supported
    if (
      typeof Worker !== 'undefined' &&
      !['MAIN_THREAD'].includes(this.#config.workerType)
    ) {
      try {
        const webWorker = new Worker(workerScriptUrl, {
          type: 'module',
          name: this.#config.workerName,
        });
        this.#workerType = 'webWorker';
        return webWorker;
      } catch (e) {}
    }

    // Fallback to running in the main thread
    this.#workerType = 'mainThread';

    const mainThreadWorker = {
      postMessage: function (message) {},
      onmessage: function (event) {},
    };
    // Load the worker script in the main thread
    import(workerScriptUrl)
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

function generateUID() {
  let firstPart = (Math.random() * 46656) | 0;
  let secondPart = (Math.random() * 46656) | 0;
  firstPart = ('000' + firstPart.toString(36)).slice(-3);
  secondPart = ('000' + secondPart.toString(36)).slice(-3);
  return firstPart + secondPart;
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
