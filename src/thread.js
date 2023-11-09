import Ws from './web-socket';

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
export default {
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
    var self = this;
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
