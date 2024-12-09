const worker = (function (root) {
  // Store connected ports in case this is a SharedWorker
  const ports = [];
  let currentSocket = null;

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

  // Utility function to send a message in worker or main thread
  function postMessage(msg) {
    msg = stringifyJson(msg);
    if (isSharedWorkerContext) {
      // Post message to all connected ports
      ports.forEach((port) => port.postMessage(msg));
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
    if (event === '_config') {
      config = { ...config, ...payload };
    }
    if (event === '_connect') {
      connectSocket(payload);
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

  async function connectSocket(auth) {
    if (currentSocket) {
      // close socket and wait for the socket to close asychronously
      currentSocket.close();
      await new Promise((resolve) => {
        currentSocket.onclose = () => {
          resolve();
        };
      });
    }

    currentSocket = new WebSocket(config.url);

    currentSocket.onopen = () => {
      currentSocket.send(stringifyJson(['_auth', auth]));
    };
    currentSocket.onmessage = (event) => {
      const [key, payload] = parseJson(event.data);
      if (key === '_acceptAuth') {
        return postMessage(['_internal:socket-connect', payload]);
      }
      return postMessage([key, payload]);
    };
    currentSocket.onclose = (event) => {
      console.log(event);
      // https://github.com/Luka967/websocket-close-codes
      postMessage(['_internal:socket-disconnected', {
        code: event.code,
        reason: event.reason,
      }]);
      currentSocket = null;
    };
    currentSocket.onerror = (error) => {
      console.error('Snub-Ws-Socket => Socket error:', error);
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