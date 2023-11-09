(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
  typeof define === 'function' && define.amd ? define(factory) :
  (global = global || self, global.snubWsClient = factory());
}(this, (function () { 'use strict';

  function index (config) {
    config = Object.assign(
      {
        debug: true,
        threadType: 'shared',
        worker: 'web-worker.thread.js',
        onmessage: (_) => {},
        onconnect: (_) => {},
        onstatechange: (_) => {},
        onauthenticated: (_) => {},
        onclose: (_) => {},
        ondenyauth: (_) => {},
        onerror: (_) => {},
        ondebug: (_) => {},
        workerOptions: {
          name: 'Snub-Ws-Worker',
          type: 'classic', // use module for web modules
        },
      },
      config
    );

    console.log('SNUB-WS-CONFIG', config);
    var mainThreadReplyQue = new Map();
    var preConnectQue = [];
    window.snubmainThreadReplyQue = mainThreadReplyQue;

    if (config.threadType === 'shared' && typeof SharedWorker === 'undefined')
      config.threadType = 'web';

    if (config.threadType === 'web' && typeof Worker === 'undefined')
      config.threadType = 'inline';

    if (config.debug)
      console.log(
        [
          'Init snub-ws-client',
          config.threadType,
          String(config.worker).substring(0, 20),
        ].join(':')
      );

    var scWorker;
    if (config.threadType === 'web') {
      scWorker = new Worker(config.worker, config.workerOptions);
    }

    if (config.threadType === 'shared') {
      var scWorkerShared = new SharedWorker(config.worker, config.workerOptions);
      scWorker = scWorkerShared.port;
    }

    if (config.threadType === 'inline') {
      var request = new XMLHttpRequest();
      request.open('GET', config.worker, false);
      request.send(null);

      if (request.status === 200) {
        scWorker = {
          isInline: true,
          events: [],
        };
        doEval(scWorker, request.responseText);
      }
    }

    if (config.threadType === 'inline-raw' && typeof config.worker === 'string') {
      scWorker = {
        isInline: true,
        events: [],
      };
      doEval(scWorker, config.worker);
    }

    if (
      config.threadType === 'inline-fn' &&
      typeof config.worker === 'function'
    ) {
      scWorker = {
        isInline: true,
        events: [],
      };
      config.worker(scWorker);
    }

    // eslint-disable-next-line
    var socketState = 'DISCONNECTED';
    var socketId;
    // handle msg from worker thread
    scWorker.addEventListener('message', (event) => {
      var [key, value] = event.data;
      // console.log('message from worker thread', event);

      if (key === '_snub_state') {
        var oldState = socketState;
        socketState = value;
        if (oldState === socketState) return;
        config.onstatechange(value);

        if (socketState !== oldState && socketState === 'CONNECTED')
          while (preConnectQue.length > 0) {
            (async (queItem) => {
              queItem.fn();
            })(preConnectQue.shift());
          }
      }
      if (key === '_snub_awaited_reply') {
        var [awaitReplyKey, ival] = value;
        var queItem = mainThreadReplyQue.get(awaitReplyKey);
        if (queItem && queItem.fn) {
          mainThreadReplyQue.delete(awaitReplyKey);
          return queItem.fn(ival);
        }
      }

      if (key === '_snub_message') config.onmessage(value);
      if (key.startsWith('__debug_')) config.ondebug(key, value);

      if (key === '_snub_acceptauth') {
        socketId = value;
        config.onauthenticated(value);
        config.onconnect();
      }

      if (key === '_snub_denyauth') config.ondenyauth();

      if (key === '_snub_closed') config.onclose(value);
    });

    if (scWorker.start) scWorker.start();

    // tell the worker about the config
    scWorker.postMessage(['_snub_config', JSON.parse(JSON.stringify(config))]);

    return {
      get socketPath() {
        return config.socketPath;
      },
      set socketPath(nv) {
        if (config.socketPath === nv) return;
        config.socketPath = nv;
        scWorker.postMessage([
          '_snub_config',
          JSON.parse(JSON.stringify(config)),
        ]);
      },
      get state() {
        return socketState;
      },
      get socketId() {
        return socketId;
      },
      // on message from the worker thread
      set onmessage(nv) {
        config.onmessage = nv;
      },
      get onmessage() {
        return config.onmessage;
      },
      set onconnect(nv) {
        config.onconnect = nv;
      },
      get onconnect() {
        return config.onconnect;
      },
      set onstatechange(nv) {
        config.onstatechange = nv;
      },
      get onstatechange() {
        return config.onstatechange;
      },
      set onauthenticated(nv) {
        config.onauthenticated = nv;
      },
      get onauthenticated() {
        return config.onauthenticated;
      },
      set onclose(nv) {
        config.onclose = nv;
      },
      get onclose() {
        return config.onclose;
      },
      set ondenyauth(nv) {
        config.ondenyauth = nv;
      },
      get ondenyauth() {
        return config.ondenyauth;
      },
      set onerror(nv) {
        config.onerror = nv;
      },
      get onerror() {
        return config.onerror;
      },
      connect(authObj) {
        this.postToWorkerThread('_snub_connect', authObj);
      },
      close(code, reason) {
        this.postToWorkerThread('_snub_close', [code, reason]);
      },
      open() {
        this.postToWorkerThread('_snub_open');
      },
      async send(key, value, noReply) {
        if (socketState !== 'CONNECTED') {
          return new Promise((resolve) => {
            preConnectQue.push({
              fn: async (d) => {
                resolve(await this.send(key, value, noReply));
              },
            });
          });
        }
        config.ondebug('__debug_postToWorker_snubSend', [key, value, noReply]);
        var res = await this.postToWorkerThread('_snubSend', [
          key,
          value,
          noReply,
        ]);
        return res;
      },
      async socketCheck(forceReconnect) {
        var res = await this.postToWorkerThread(
          '_snubSocketCheck',
          forceReconnect
        );
        return res;
      },
      async workerCheck() {
        var res = false;
        (async (_) => {
          res = await this.postToWorkerThread('_snubWorkerCheck');
        })();
        await ((_) => {
          return new Promise((resolve) => setTimeout(resolve, 200));
        })();
        return res;
      },
      async pingCheck() {
        var res = false;
        (async (_) => {
          res = await this.postToWorkerThread('_snubWorkerCheck');
        })();
        await ((_) => {
          return new Promise((resolve) => setTimeout(resolve, 2000));
        })();
        return res;
      },
      async createJob(name, fn) {
        fn = fn.toString();
        var res = await this.postToWorkerThread('_snubCreateJob', { name, fn });
        var self = this;
        if (res === name)
          return async function () {
            var ran = await self.postToWorkerThread('_snubRunJob', {
              name,
              args: Array.from(arguments),
            });
            return ran;
          };
      },
      // post a messages to the worker thread;
      postToWorkerThread(key, value) {
        if (
          [
            '_snubSocketCheck',
            '_snubCreateJob',
            '_snubRunJob',
            '_snubWorkerCheck',
          ].includes(key)
        ) {
          var noReply = __genReplyId(key, socketId);
          scWorker.postMessage([key, value, noReply]);
          return new Promise((resolve) => {
            mainThreadReplyQue.set(noReply, {
              fn: resolve,
            });
          });
        }
        if (key !== '_snubSend') return scWorker.postMessage([key, value]);
        var [ikey, ivalue, noReply] = value;
        if (noReply === true) return scWorker.postMessage([key, value]);
        noReply = __genReplyId(ikey, socketId);
        scWorker.postMessage([key, value, noReply]);
        return new Promise((resolve) => {
          mainThreadReplyQue.set(noReply, {
            fn: resolve,
          });
        });
      },
    };
  }

  function doEval(self, _worker_file) {
    (function () {
      // eslint-disable-next-line
      eval(_worker_file);
    }.call(window));
  }
  var replyIdCount = 0;
  function __genReplyId(prefix, sockid = 'init') {
    replyIdCount++;
    return `_reply:${prefix}:${sockid}:${replyIdCount}`;
  }

  return index;

})));
