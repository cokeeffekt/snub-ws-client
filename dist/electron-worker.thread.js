function noop() {}

function Ws (url, opts) {
  opts = opts || {};

  var ws;
  var num = 0;
  var timer = 1;
  var $ = {};
  var max = opts.maxAttempts || Infinity;

  $.open = function () {
    try {
      ws.close(1000);
      ws = undefined;
    } catch (error) {}
    ws = new WebSocket(url, opts.protocols || []);

    ws.onmessage = opts.onmessage || noop;

    var intTrack = setInterval((_) => {
      console.log(ws, ws.readyState);
    }, 5000);

    ws.onopen = function (e) {
      clearInterval(intTrack);
      (opts.onopen || noop)(e);
      num = 0;
    };

    ws.onclose = function (e) {
      clearInterval(intTrack);
      // https://github.com/Luka967/websocket-close-codes
      // https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent
      e.code === 1000 || e.code === 1001 || $.reconnect(e);
      if (e.code === 1000 && e.reason === 'IDLE_TIMEOUT') $.reconnect(e);
      (opts.onclose || noop)(e);
    };

    ws.onerror = function (e) {
      clearInterval(intTrack);
      e && e.code === 'ECONNREFUSED'
        ? $.reconnect(e)
        : (opts.onerror || noop)(e);
    };
  };

  $.reconnect = function (e) {
    if (num++ < max) {
      timer = setTimeout(
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
    timer = clearTimeout(timer);
    ws.close(x || 1e3, y);
    ws.onmessage = noop;
    ws.onopen = noop;
    ws.onclose = noop;
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

var jobs = new Map();
var thread = {
  get currentWs() {
    return currentWs;
  },
  initThreadClient() {
    console.log('Thread Client INIT');
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
    if (nv !== currentWs) {
      currentWsState = nv;
      this.postMessageToMainThread('_snub_state', nv);
    }
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
    currentWs = new Ws(config.socketPath, {
      autoConnect: true,
      timeout: config.timeout,
      maxAttempts: config.maxAttempts,
      onopen: (e) => {
        if (config.debug) console.log('SnubSocket Connected');
        this.wsState = 'WAITING_AUTH';
        currentWs.json(['_auth', authObj]);
      },
      onmessage: (e) => {
        try {
          var [key, value] = JSON.parse(e.data);
          // handle the auth check
          if (key === '_acceptAuth') {
            this.wsState = 'CONNECTED';
            currentSocketId = value;
            this.postMessageToMainThread('_snub_acceptauth', currentSocketId);

            while (connectQue.length > 0) {
              (async (queItem) => {
                var res = this._snubSend(queItem.obj);
                queItem.fn(res);
              })(connectQue.shift());
            }
            return;
          }

          if (key.startsWith('_reply:')) {
            console.log('got reply', key);
            // _snub_awaited_reply
            var queItem = replyQue.get(key);
            if (queItem && queItem.fn) {
              replyQue.delete(key);
              return this.postMessageToMainThread('_snub_awaited_reply', [
                key,
                value,
              ]);
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
        this.wsState = 'DISCONNECTED';
        if (config.debug) console.log('SnubSocket closed...', e.code, e.reason);
        if (e.reason === 'AUTH_FAIL')
          this.postMessageToMainThread('_snub_denyauth');
        return this.postMessageToMainThread('_snub_closed', {
          reason: e.reason,
          code: e.code,
        });
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
        console.log('build reply worker thread', key, value, noReply);
        var replyId = noReply === true ? undefined : noReply;
        // put a reply job on the que
        if (replyId)
          replyQue.set(replyId, {
            ts: Date.now(),
            fn: resolve,
          });
        currentWs.json([key, value, replyId]);
        if (!replyId) resolve();
      }
    });
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
    console.log('post to main thread', key, value);
    var nextRaw = listenRawFn(key, value);
    var next;
    if (key === '_snub_message') next = listenFn(...value);
    if (nextRaw !== false && next !== false) threadPostMessage([key, value]);
  },
  // __genReplyId(prefix) {
  //   var firstPart = (Math.random() * 46656) | 0;
  //   var secondPart = (Math.random() * 46656) | 0;
  //   firstPart = ('000' + firstPart.toString(36)).slice(-3);
  //   secondPart = ('000' + secondPart.toString(36)).slice(-3);
  //   return (
  //     '_reply:' +
  //     prefix +
  //     ':' +
  //     hashCode(currentSocketId) +
  //     '-' +
  //     firstPart +
  //     secondPart
  //   );
  // },
};

// function hashCode(s) {
//   for (var h = 0, i = 0; i < s.length; h &= h) h = 31 * h + s.charCodeAt(i++);
//   return Math.abs(h).toString(36);
// }

const WebSocket$1 = require('ws');
global.WebSocket = WebSocket$1;

var clients = [];
const { ipcMain } = require('electron');
ipcMain.on('_snub_ipc_message', async (event, payload) => {
  var client = event.sender;
  if (!clients.includes(client)) clients.push(client);
  var [key, value, awaitReply] = payload;
  var res = await thread.message(key, value);
  if (awaitReply)
    client.send('_snub_ipc_message', ['_snub_awaited_reply', [awaitReply, res]]);
});

thread.setPostMessage(msg => {
  clients.forEach(client => {
    try {
      client.send('_snub_ipc_message', msg);
    } catch (error) {
      var idx = clients.findIndex(c => c === client);
      clients.splice(idx, 1);
    }
  });
});
thread.initThreadClient();
