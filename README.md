# snub-ws-client

Websocket client for snub-ws

Snub-Ws-Client no longer handles alot of the magic, it simply authenticated and gives you a socket connection to Snub-Ws it will not store credentials nor will it attemps recconnects, you will have to do that manually.

````javascript
import SnubWsClient from 'snub-ws-client';

snub.onopen((auth) => {
  // w/e
});
snub.onclose((event) => {
  // w/e
});
snub.onmessage((key, payload) => {
  // w/e
});
      ```
````
