import thread from './thread.js';
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
