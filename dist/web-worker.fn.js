export default function(self) {
function noop() {
  console.log('noop');
}

function Ws (url, opts) {
  opts = opts || {};

  var ws;
  var num = 0;
  var $ = {
    hash: Math.random(),
  };
  var max = opts.maxAttempts || Infinity;
  $.open = function () {
    try {
      ws.close(1000);
      ws = undefined;
    } catch (error) {}
    ws = new WebSocket(url, opts.protocols || []);
    $.ws = ws;

    ws.onmessage = opts.onmessage || noop;

    ws.onopen = function (e) {
      console.log('ws-open');
      (opts.onopen || noop)(e);
      num = 0;
    };

    ws.onclose = function (e) {
      if (e.code === 1005) return;
      // https://github.com/Luka967/websocket-close-codes
      // https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent
      e.code === 1000 || e.code === 1001 || $.reconnect(e);
      if (e.code === 1000 && e.reason === 'IDLE_TIMEOUT') $.reconnect(e);
      (opts.onclose || noop)(e);
    };

    ws.onerror = function (e) {
      e && e.code === 'ECONNREFUSED'
        ? $.reconnect(e)
        : (opts.onerror || noop)(e);
    };
  };

  $.reconnect = function (e) {
    if (num++ < max) {
      setTimeout(
        function () {
          (opts.onreconnect || noop)(e);
          $.open();
        },
        num === 1 ? 1 : (opts.timeout || 500) * (num - 1)
      );
    } else {
      (opts.onmaximum || noop)(e);
    }
  };

  $.readyState = function () {
    return ws.readyState;
  };

  $.json = function (x) {
    ws.send(JSON.stringify(x));
  };

  $.send = function (x) {
    ws.send(x);
  };

  $.close = function (x, y) {
    ws.close(x || 1e3, y);
    ws.onmessage = noop;
    ws.onopen = noop;
    ws.onerror = noop;
  };

  if (opts.autoConnect) $.open(); // init

  return $;
}

var config = {
  timeout: 500,
  maxAttempts: 10,
};
var currentWs;
var currentSocketId;
var currentWsState = 'DISCONNECTED'; // DISCONNECTED > CONNECTING > WAITING_AUTH > CONNECTED

var replyQue = new Map();
var connectQue = [];

var threadPostMessage = (_) => {};
var listenRawFn = (_) => {};
var listenFn = (_) => {};
var pingCheck = (_) => {};

var jobs = new Map();
var thread = {
  selfCheck() {
    if (!currentWs || !currentWsState) return;
    if (currentWsState === 'CONNECTED' && currentWs.readyState() !== 1)
      currentWs.reconnect();
  },
  get currentWs() {
    return currentWs;
  },
  initThreadClient() {
    console.log('Thread Client INIT!!');
    // new clients will need to know about the existing connection.
    this.postMessageToMainThread('_snub_state', this.wsState);
    if (this.wsState === 'CONNECTED')
      this.postMessageToMainThread('_snub_acceptauth', currentSocketId);
  },
  setPostMessage(fn) {
    threadPostMessage = fn;
  },
  get wsState() {
    return currentWsState;
  },
  set wsState(nv) {
    if (nv === currentWsState) return;
    currentWsState = nv;
    this.postMessageToMainThread('_snub_state', nv);
  },
  async _config(configObj) {
    config = Object.assign(config, configObj);
  },
  async _connect(authObj) {
    if (config.debug) console.log('SnubSocket request connection...');
    if (currentWs && currentWs.readyState() > 1) this.wsState = 'DISCONNECTED';
    if (currentWs && this.wsState !== 'DISCONNECTED') {
      this.postMessageToMainThread('_snub_state', this.wsState);
      if (this.wsState === 'CONNECTED')
        this.postMessageToMainThread('_snub_acceptauth', currentSocketId);
      return;
    }

    if (config.debug) console.log('SnubSocket Connecting...');

    if (config.debug) console.log('max attempts.', config.maxAttempts);
    this.wsState = 'CONNECTING';
    try {
      currentWs.close(1000);
    } catch (error) {}
    if (config.debug) console.log('NEW SOCKET', authObj);
    try {
      console.log(this.wsState, currentWs.readyState());
    } catch (error) {}
    currentWs = new Ws(config.socketPath, {
      autoConnect: true,
      timeout: config.timeout,
      maxAttempts: config.maxAttempts,
      onopen: (e) => {
        if (config.debug) console.log('SnubSocket Connected');
        this.wsState = 'WAITING_AUTH';
        // currentWs.authCache = JSON.stringify(currentWs.authObj);
        currentWs.json(['_auth', authObj]);
      },
      onmessage: (e) => {
        try {
          var [key, value] = JSON.parse(e.data);
          // handle the auth check
          if (key === '_ping') return currentWs.json(['_pong']);
          if (key === '_pong') return pingCheck();
          if (key === '_acceptAuth') {
            this.wsState = 'CONNECTED';
            this.chacheAuthObj = authObj;
            this.authedSocket = true;
            currentSocketId = value;
            this.postMessageToMainThread('_snub_acceptauth', currentSocketId);

            while (connectQue.length > 0) {
              (async (queItem) => {
                var res = await this._snubSend(queItem.obj);
                queItem.fn(res);
              })(connectQue.shift());
            }
            return;
          }

          if (key.startsWith('_reply:')) {
            var queItem = replyQue.get(key);
            if (queItem && queItem.fn) {
              replyQue.delete(key);
              return this.replyMessageToMainThread(key, value);
            }
          }

          this.postMessageToMainThread('_snub_message', [key, value]);
        } catch (error) {
          this.postMessageToMainThread('_snub_message', e.data);
        }
      },
      onreconnect: (e) => console.log('Reconnecting...', e),
      onmaximum: (e) => console.log('Stop Attempting!', e),
      onclose: (e) => {
        if (e.target !== currentWs.ws) return;
        this.wsState = 'DISCONNECTED';
        if (config.debug) console.log('SnubSocket closed...', e.code, e.reason);
        if (e.reason === 'AUTH_FAIL')
          this.postMessageToMainThread('_snub_denyauth');
        if (this.authedSocket === true)
          this.postMessageToMainThread('_snub_closed', {
            reason: e.reason,
            code: e.code,
          });
        this.authedSocket = false;
      },
      onerror: (e) => console.warn('Error:', e),
    });
  },
  _close(payload = []) {
    if (!currentWs) return;
    if (config.debug) console.log('Close sent from client', ...payload);
    currentWs.close(...payload);
  },
  _open() {
    if (!currentWs) return;
    currentWs.open();
  },
  _snubSend(snubSendObj, noReply) {
    if (!currentWs) return;
    if (currentWs.readyState() > 1 && this.wsState !== 'DISCONNECTED') {
      currentWs.reconnect();
      this.wsState = 'CONNECTING';
    }

    if (this.wsState === 'DISCONNECTED') return;

    return new Promise((resolve) => {
      if (this.wsState !== 'CONNECTED') {
        connectQue.push({
          obj: snubSendObj,
          fn: resolve,
        });
      } else {
        var [key, value] = snubSendObj;
        var replyId = noReply === true ? undefined : noReply;
        // put a reply job on the que
        if (replyId)
          replyQue.set(replyId, {
            ts: Date.now(),
            fn: resolve,
          });
        currentWs.json([key, value, replyId]);
        // console.log('__debug_snubSend', [key, value, replyId]);
        this.postMessageToMainThread('__debug_snubSend', [key, value, replyId]);
        if (!replyId) resolve();
      }
    });
  },
  async _snubSocketCheck(obj, reply) {
    var checkObj = {
      ws: currentWs.readyState(),
      state: this.wsState,
    };
    this.replyMessageToMainThread(reply, checkObj);
    if (obj === 'dc') currentWs.close(3333);
    if (obj === 'rc') currentWs.reconnect();
    if (obj || !currentWs || !currentWsState) return;
    if (currentWsState === 'CONNECTED' && currentWs.readyState() !== 1)
      currentWs.reconnect();
  },
  async _pingCheck(obj, reply) {
    currentWs.json(['_ping']);
    pingCheck = (_) => {
      this.replyMessageToMainThread(reply, true);
    };
  },
  async _snubWorkerCheck(obj, reply) {
    this.replyMessageToMainThread(reply, true);
  },
  async _snubCreateJob(obj) {
    var { name, fn } = obj;
    // eslint-disable-next-line
    var fn = new Function('return ' + fn)();
    jobs.set(name, fn);
    return name;
  },
  async _snubRunJob(obj) {
    var { name, args } = obj;
    var res = await jobs.get(name)(...args);
    return res;
  },
  async message(key, value, noReply) {
    key = key.replace(/^_snub_/, '_');
    if (typeof this[key] === 'function') {
      var res = await this[key](value, noReply);
      return res;
    }
    console.error('unknown message for ' + key, this[key]);
    return 'unknown message for ' + key;
  },
  listenRaw(fn) {
    listenRawFn = fn;
  },
  listen(fn) {
    listenFn = fn;
  },
  // post message back to main thread
  postMessageToMainThread(key, value) {
    var nextRaw = listenRawFn(key, value);
    var next;
    if (key === '_snub_message') next = listenFn(...value);
    if (nextRaw !== false && next !== false) threadPostMessage([key, value]);
  },
  replyMessageToMainThread(key, value) {
    return this.postMessageToMainThread('_snub_awaited_reply', [key, value]);
  },
};

console.log('Init Snub Worker Thread', self);
self.thread = thread;

self.checkInterval = setInterval((_) => {
  if (thread && thread.selfCheck) thread.selfCheck();
}, 3000);

if (self.onconnect === null) {
  // Shared Worker
  var clients = [];

  self.addEventListener(
    'connect',
    function (e) {
      var port = e.ports[0];
      clients.push(port);
      port.addEventListener('message', onMsg);
      port.start();
    },
    false
  );

  thread.setPostMessage((msg) => {
    clients.forEach((port) => port.postMessage(msg));
  });
} else if (self.isInline) {
  // Inline Worker
  thread.setPostMessage((msg) => {
    self.events.forEach((e) => {
      if (e.event === 'message') e.fn({ data: msg });
    });
  });
  self.postMessage = async (msg) => {
    var res = await thread.message(...msg);
    return res;
  };

  self.addEventListener = (event, fn) => {
    self.events.push({
      event,
      fn,
    });
  };
} else {
  // Web Worker
  self.addEventListener('message', onMsg);
  thread.setPostMessage(postMessage);
}

self.listenRaw = thread.listenRaw;
self.listen = thread.listen;

// handle message from main thread
async function onMsg(event) {
  try {
    if (event.data) {
      var [key, value, noReply] = event.data;
      var res = await thread.message(key, value, noReply);
      return;
    }
    throw Error('Missing message payload');
  } catch (error) {
    console.error(error);
  }
}
thread.initThreadClient();

// example raw listeners
// self.listen((key, value) => {
//   console.log('%LSN%', key, value);
//   if (key === 'pinger')
//     return false;
// });

// self.listenRaw((key, value) => {
//   console.log('%RAW%', key, value);
// });
}
