const blob = new Blob(["const worker=function(){const e=[];let n=null,o=()=>{},s={};const t=\"undefined\"!=typeof WorkerGlobalScope&&self instanceof WorkerGlobalScope,r=\"undefined\"!=typeof SharedWorkerGlobalScope&&self instanceof SharedWorkerGlobalScope;return r?self.onconnect=function(n){const o=n.ports[0];e.push(o),o.onmessage=a,o.start(),c([\"_internal:connected\"])}:t&&(self.onmessage=a,c([\"_internal:connected\"])),{postToMain:e=>o=e,handleIncomingMessage:a,ready(){c([\"_internal:connected\"])}};function c(n){n=JSON.stringify(n),r?e.forEach((e=>e.postMessage(n))):t?self.postMessage(n):o({data:n})}function a(e){const[o,t]=JSON.parse(e.data);\"_config\"===o&&(s={...s,...t}),\"_connect\"===o&&async function(e){n&&(n.close(),await new Promise((e=>{n.onclose=()=>{e()}})));n=new WebSocket(s.url),n.onopen=()=>{n.send(JSON.stringify([\"_auth\",e]))},n.onmessage=e=>{const[n,o]=JSON.parse(e.data);return c(\"_acceptAuth\"===n?[\"_internal:socket-connect\",o]:[n,o])},n.onclose=e=>{c([\"_internal:socket-disconnected\",e]),n=null},n.onerror=e=>{console.error(\"Snub-Ws-Socket => Socket error:\",e)}}(t),\"_send\"===o&&n&&n.send(JSON.stringify(t))}}(\"undefined\"!=typeof self&&self);export default{postMessage:worker.handleIncomingMessage,postToMain:worker.postToMain,ready:worker.ready};"], { type: 'application/javascript' });
          var workerScriptUrl = URL.createObjectURL(blob);

const DEFAULT_CONFIG = {
  workerType: 'SHARED_WORKER', // 'SHARED_WORKER', 'WEB_WORKER', 'MAIN_THREAD'
  workerName: 'Snub-Ws-Client-Worker',
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
      const [key, value] = JSON.parse(event.data);
      if (key === '_internal:connected') {
        this.#worker.postMessage([
          '_config',
          {
            url: this.#config.url,
          },
        ]);
        this.#state = 'READY';
        this.connect(this.#pendingConnect);
        this.#pendingConnect = null;
      }
      if (key === '_internal:socket-disconnected') {
        this.#onclose(value);
      }
      if (key === '_internal:socket-connect') {
        this.#onopen(value);
      }
      if (key.startsWith('_internal:')) return;
      if (key.startsWith('_r:')) {
        const [resolve, reject, timeout] = this.#waitingReplies.get(key);
        if (resolve) {
          resolve(value);
          this.#waitingReplies.delete(key);
          clearTimeout(timeout);
        }
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
          module.default.postMessage({ data: JSON.stringify(msg) });
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
    worker._postMessage(JSON.stringify(message));
  };
}

function generateUID() {
  let firstPart = (Math.random() * 46656) | 0;
  let secondPart = (Math.random() * 46656) | 0;
  firstPart = ('000' + firstPart.toString(36)).slice(-3);
  secondPart = ('000' + secondPart.toString(36)).slice(-3);
  return firstPart + secondPart;
}

export { SnubWsClient as default };
//# sourceMappingURL=snub-ws-client.esm.js.map
