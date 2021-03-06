function noop () {}

function Ws (url, opts) {
  opts = opts || {};

  var ws;
  var num = 0;
  var timer = 1;
  var $ = {};
  var max = opts.maxAttempts || Infinity;

  $.open = function () {
    ws = new WebSocket(url, opts.protocols || []);

    ws.onmessage = opts.onmessage || noop;

    ws.onopen = function (e) {
      (opts.onopen || noop)(e);
      num = 0;
    };

    ws.onclose = function (e) {
      e.code === 1e3 || e.code === 1001 || e.code === 1005 || $.reconnect(e);
      (opts.onclose || noop)(e);
    };

    ws.onerror = function (e) {
      (e && e.code === 'ECONNREFUSED') ? $.reconnect(e) : (opts.onerror || noop)(e);
    };
  };

  $.reconnect = function (e) {
    if (num++ < max) {
      timer = setTimeout(function () {
        (opts.onreconnect || noop)(e);
        $.open();
      }, (opts.timeout || 1e3) * num);
    } else {
      (opts.onmaximum || noop)(e);
    }
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
  };

  if (opts.autoConnect)
    $.open(); // init

  return $;
}

var config = {
  timeout: 5e3,
  maxAttempts: 10,
};
var currentWs;
var currentWsState = 'DISCONNECTED'; // DISCONNECTED > CONNECTING > WAITING_AUTH > CONNECTED

var replyQue = new Map();
var connectQue = [];

var threadPostMessage = _ => {};
var thread = {
  setPostMessage (fn) {
    threadPostMessage = fn;
  },
  get wsState () {
    return currentWsState;
  },
  set wsState (nv) {
    if (nv !== currentWs) {
      currentWsState = nv;
      this.postMessage('_snub_state', nv);
    }
  },
  async _config (configObj) {
    config = Object.assign(config, configObj);
  },
  async _connect (authObj) {
    if (config.debug)
      console.log('SnubSocket request connection...');
    if (currentWs && this.wsState !== 'DISCONNECTED') {
      this.postMessage('_snub_state', this.wsState);
      if (this.wsState === 'CONNECTED')
        this.postMessage('_snub_acceptauth');
      return;
    }
    if (config.debug)
      console.log('SnubSocket Connecting...');

    console.log('max attampes', config.maxAttempts);
    this.wsState = 'CONNECTING';
    currentWs = new Ws(config.socketPath, {
      autoConnect: true,
      timeout: config.timeout,
      maxAttempts: config.maxAttempts,
      onopen: e => {
        if (config.debug)
          console.log('SnubSocket Connected');
        this.wsState = 'WAITING_AUTH';
        currentWs.json(['_auth', authObj]);
      },
      onmessage: e => {
        try {
          var [key, value] = JSON.parse(e.data);
          if (key === '_acceptAuth') {
            this.wsState = 'CONNECTED';
            this.postMessage('_snub_acceptauth');

            while (connectQue.length > 0) {
              (async queItem => {
                var res = this._snubSend(queItem.obj);
                queItem.fn(res);
              })(connectQue.shift());
            }
            return;
          }

          if (key.startsWith('_reply:')) {
            var queItem = replyQue.get(key);
            if (queItem && queItem.fn) {
              replyQue.delete(key);
              return queItem.fn(value);
            }
          }

          this.postMessage('_snub_message', [key, value]);
        } catch (error) {
          this.postMessage('_snub_message', e.data);
        }
      },
      onreconnect: e => console.log('Reconnecting...', e),
      onmaximum: e => console.log('Stop Attempting!', e),
      onclose: e => {
        this.wsState = 'DISCONNECTED';
        if (config.debug)
          console.log('SnubSocket closed...');
        if (e.reason === 'AUTH_FAIL')
          return this.postMessage('_snub_denyauth');
        return this.postMessage('_snub_closed', {
          reason: e.reason,
          code: e.code
        });
      },
      onerror: e => console.log('Error:', e)
    });
  },
  _close () {
    if (!currentWs) return;
    currentWs.close();
  },
  _open () {
    if (!currentWs) return;
    currentWs.open();
  },
  _snubSend (snubSendObj) {
    if (this.wsState === 'DISCONNECTED') return;

    return new Promise(resolve => {
      if (this.wsState !== 'CONNECTED') {
        connectQue.push({
          obj: snubSendObj,
          fn: resolve
        });
      } else {
        var [key, value, noReply] = snubSendObj;
        var replyId = noReply === true ? undefined : this.__genReplyId(key);
        // put a reply job on the que
        if (replyId)
          replyQue.set(replyId, {
            ts: Date.now(),
            fn: resolve
          });
        currentWs.json([key, value, replyId]);
        if (!replyId)
          resolve();
      }
    });
  },
  async message (key, value) {
    key = key.replace(/^_snub_/, '_');
    if (typeof this[key] === 'function') {
      var res = this[key](value);
      return res;
    }
    console.error('unknown message for ' + key, this[key]);
    return 'unknown message for ' + key;
  },
  postMessage (key, value) {
    threadPostMessage([key, value]);
  },
  __genReplyId (prefix) {
    var firstPart = (Math.random() * 46656) | 0;
    var secondPart = (Math.random() * 46656) | 0;
    firstPart = ('000' + firstPart.toString(36)).slice(-3);
    secondPart = ('000' + secondPart.toString(36)).slice(-3);
    return '_reply:' + prefix + ':' + firstPart + secondPart;
  }
};

console.log('Init web-worker thread', self);

if (self.onconnect === null) {
  // Shared Worker
  var clients = [];

  self.addEventListener('connect', function (e) {
    var port = e.ports[0];
    console.log('connect', port);
    clients.push(port);
    port.addEventListener('message', onMsg);
    port.postMessage('_snubInitSharedWorker');
    port.start();
  }, false);

  thread.setPostMessage(msg => {
    clients.forEach(port => port.postMessage(msg));
  });
} else if (self.isInline) {
  // Inline Worker
  thread.setPostMessage(msg => { self.incPostMessage(msg); });
  self.postMessage = async msg => {
    var res = await thread.message(...msg);
    return res;
  };

  self.addEventListener = (event, fn) => {
    self.events.push({
      event,
      fn
    });
  };

  self.incPostMessage = (msg) => {
    self.events.forEach(e => {
      if (e.event === 'message')
        e.fn({ data: msg });
    });
  };
} else {
  // Web Worker
  self.addEventListener('message', onMsg);
  thread.setPostMessage(postMessage);
}

// got a message from main thread
// self.addEventListener('message', onMsg);

async function onMsg (event) {
  try {
    if (event.data) {
      var [key, value] = event.data;
      var res = await thread.message(key, value);
      // reply to message from main thread
      if (!event.ports.length) return;
      return event.ports[0].postMessage(res);
    }
    throw Error('Missing message payload');
  } catch (error) {
    console.error(error);
  }
}
