var StaticServer = require('static-server');
var server = new StaticServer({
  rootPath: './',
  port: 1337,
});

server.start(function () {
  console.log('Server listening to', server.port);
});

const Snub = require('snub');

var snub = new Snub({
  host: 'localhost',
  password: null,
  db: 6,
  timeout: 10000
});

const SnubWS = require('snub-ws');

const snubws = new SnubWS({
  debug: true,
  port: 1338,
  multiLogin: false,
  auth: 'authme',
  timeout: 10000,
  authTimeout: 10000,
  throttle: [50, 5000]
});

snub.use(snubws);

snub.on('ws:authme', async (auth, reply) => {
  console.log('authme', auth, auth.auth === '123abc');
  if (auth.auth === '123abc') reply(true);
  reply(false);
});

snub.on('ws:test_with_reply', async (event, reply) => {
  // console.log('test_with_reply', event);
  reply('ok');
});

snub.on('ws:test_no_reply', event => {
  // console.log('test_with_reply', event);
});

setInterval(_ => {
  snub.poly('ws:send-all', ['pinger', Date.now()]).send();
}, 15000);
