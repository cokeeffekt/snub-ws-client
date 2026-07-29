const worker = (function (root) {
  // Store connected ports in case this is a SharedWorker
  const ports = [];
  let currentSocket = null;

  // Connection identity, used to keep connect() idempotent across tabs.
  // currentAuthKey is the serialized auth the live socket was opened with;
  // acceptPayload is the last `_acceptAuth` body, replayed to a tab whose
  // connect() was a no-op so it still receives its onopen.
  let currentAuthKey = null;
  let currentAuthRaw;
  let acceptPayload;
  // Serializes connect attempts. Without it two tabs calling connect() at the
  // same moment both await the same closing socket, and the slower one orphans
  // the other's socket — still open, still receiving, no longer referenced.
  let connectQueue = Promise.resolve();

  let postToMain = () => {};
  let config = {};
  // Check if we are in a Worker context or the main thread
  const isWorkerContext =
    typeof WorkerGlobalScope !== 'undefined' &&
    self instanceof WorkerGlobalScope;
  const isSharedWorkerContext =
    typeof SharedWorkerGlobalScope !== 'undefined' &&
    self instanceof SharedWorkerGlobalScope;

  if (isSharedWorkerContext) {
    // Running in a SharedWorker context
    self.onconnect = function (e) {
      const port = e.ports[0];
      ports.push(port);

      port.onmessage = handleIncomingMessage;
      port.start();
      postMessage(['_internal:connected']);
    };
  } else if (isWorkerContext) {
    // Running in a Worker context
    self.onmessage = handleIncomingMessage;
    postMessage(['_internal:connected']);
  }

  return {
    postToMain: (fn) => (postToMain = fn), // set the postMessage function for the main thread
    handleIncomingMessage,
    ready() {
      postMessage(['_internal:connected']);
    },
  };

  // Utility function to send a message in worker or main thread.
  // `target`, when given, is the single port the message goes to instead of
  // every connected tab.
  function postMessage(msg, target) {
    msg = stringifyJson(msg);
    if (target) {
      try {
        target.postMessage(msg);
      } catch (_) {
        const i = ports.indexOf(target);
        if (i > -1) ports.splice(i, 1);
      }
      return;
    }
    if (isSharedWorkerContext) {
      // Post message to all connected ports, pruning any that have closed
      for (let i = ports.length - 1; i >= 0; i--) {
        try {
          ports[i].postMessage(msg);
        } catch (_) {
          ports.splice(i, 1);
        }
      }
    } else if (isWorkerContext) {
      // Post message to the main script
      self.postMessage(msg);
    } else {
      // Call the main thread handler
      postToMain({ data: msg });
    }
  }

  // Common functionality that runs in both the workers and main thread
  function handleIncomingMessage(msg) {
    const [event, payload] = parseJson(msg.data);
    // In a SharedWorker the message event's target is the port it arrived on,
    // which is how a reply reaches only the tab that asked.
    const source = isSharedWorkerContext ? msg.target : null;
    if (event === '_config') {
      config = { ...config, ...payload };
      config.httpUrl = config.url.replace(/^ws/, 'http')
    }
    if (event === '_connect') {
      connectSocket(payload, source);
    }
    if (event === '_reconnect') {
      connectSocket(payload, source, true);
    }
    if (event === '_close') {
      if (currentSocket) {
        currentSocket.close(...payload);
      }
    }
    if (event === '_send') {
      if (currentSocket) {
        currentSocket.send(stringifyJson(payload));
      }
    }
  }

  // Every connect attempt goes through the queue, so the checks below always
  // see a settled socket rather than one another mid-handshake.
  function connectSocket(auth, source, force) {
    connectQueue = connectQueue
      .then(() => openSocket(auth, source, force))
      .catch((error) => {
        console.error('Snub-Ws-Socket => Connect error:', error);
      });
    return connectQueue;
  }

  async function openSocket(auth, source, force) {
    // `reconnect()` with no auth reuses the credentials already in play
    if (force && auth === undefined) auth = currentAuthRaw;
    const authKey = stringifyJson(auth ?? null);
    const live =
      currentSocket &&
      (currentSocket.readyState === 0 || currentSocket.readyState === 1);

    // Idempotent: re-connecting with the same auth over a live socket would
    // drop that socket for every other tab, so a remount or a route change
    // must not do it. The calling tab still needs its onopen, so replay the
    // accept payload to that tab alone — broadcasting would fire onopen again
    // everywhere. If the socket is still handshaking there is nothing to
    // replay; the pending `_acceptAuth` reaches every tab anyway.
    if (!force && live && authKey === currentAuthKey) {
      if (acceptPayload !== undefined)
        postMessage(['_internal:socket-connect', acceptPayload], source);
      return;
    }

    if (currentSocket) {
      // close socket and wait for the socket to close asychronously.
      // addEventListener rather than onclose: onclose is what reports the
      // disconnect to every tab, and clobbering it made resets invisible.
      const closing = currentSocket;
      await new Promise((resolve) => {
        if (closing.readyState === 3) return resolve(); // already CLOSED
        closing.addEventListener('close', resolve, { once: true });
        closing.close();
      });
    }

    currentAuthKey = authKey;
    currentAuthRaw = auth;
    acceptPayload = undefined;

    const socket = new WebSocket(config.url);
    currentSocket = socket;

    socket.onopen = () => {
      socket.send(stringifyJson(['_auth', auth]));
    };
    socket.onmessage = (event) => {
      const [key, payload] = parseJson(event.data);
      if (key === '_acceptAuth') {
        acceptPayload = payload;
        return postMessage(['_internal:socket-connect', payload]);
      }
      if (key === '_offload') {
        return (async () => {
          const controller = new AbortController();
          // 30s matches the server-side Redis TTL for offload payloads
          const timeout = setTimeout(() => controller.abort(), 30000);
          try {
            const result = await fetch(config.httpUrl + `?offload=${payload}`, { signal: controller.signal });
            if (!result.ok) throw new Error(`offload fetch failed: ${result.status}`);
            let data = await result.text();
            data = parseJson(data);
            postMessage([...data]);
          } catch (e) {
            console.error('Snub-Ws-Socket => Offload error:', e);
          } finally {
            clearTimeout(timeout);
          }
        })();
      }
      return postMessage([key, payload]);
    };
    socket.onclose = (event) => {
      // https://github.com/Luka967/websocket-close-codes
      postMessage(['_internal:socket-disconnected', {
        code: event.code,
        reason: event.reason,
      }]);
      // Identity-guarded: a socket that has already been replaced must not
      // clear the state belonging to the one that replaced it.
      if (currentSocket === socket) {
        currentSocket = null;
        currentAuthKey = null;
        acceptPayload = undefined;
      }
    };
    socket.onerror = () => {
      // Browser WebSocket error events carry no actionable detail by design,
      // so we forward a synthesized shape rather than an empty signal. Use
      // onclose's { code, reason } for the real reason a connection dropped.
      postMessage(['_internal:socket-error', {
        message: 'WebSocket error',
        timestamp: Date.now(),
      }]);
    };
  }
})(typeof self !== 'undefined' ? self : this);

export default {
  postMessage: worker.handleIncomingMessage,
  postToMain: worker.postToMain,
  ready: worker.ready,
};


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