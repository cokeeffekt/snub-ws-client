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
    msg = JSON.stringify(msg);
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
    const [event, payload] = JSON.parse(msg.data);
    if (event === '_config') {
      config = { ...config, ...payload };
    }
    if (event === '_connect') {
      connectSocket(payload);
    }
    if (event === '_send') {
      if (currentSocket) {
        currentSocket.send(JSON.stringify(payload));
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
      currentSocket.send(JSON.stringify(['_auth', auth]));
    };
    currentSocket.onmessage = (event) => {
      const [key, payload] = JSON.parse(event.data);
      if (key === '_acceptAuth') {
        return postMessage(['_internal:socket-connect', payload]);
      }
      return postMessage([key, payload]);
    };
    currentSocket.onclose = (event) => {
      postMessage(['_internal:socket-disconnected', event]);
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
