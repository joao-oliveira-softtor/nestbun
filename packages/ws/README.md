# @nestbun/ws

NestJS WebSocket gateways on `Bun.serve`, on the same port as the HTTP app. It is the counterpart of `@nestjs/platform-ws` for [`@nestbun/platform`](https://www.npmjs.com/package/@nestbun/platform): gateways, `@SubscribeMessage()`, guards, pipes, interceptors and exception filters work unchanged.

```bash
bun add @nestbun/ws @nestjs/websockets
```

```ts
import { NestFactory } from '@nestjs/core';
import { BunAdapter, type NestBunApplication } from '@nestbun/platform';
import { BunWsAdapter } from '@nestbun/ws';
import { AppModule } from './app.module.js';

const app = await NestFactory.create<NestBunApplication>(AppModule, new BunAdapter());
app.useWebSocketAdapter(new BunWsAdapter(app));
await app.listen(3000);
```

```ts
import { MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';

@WebSocketGateway({ path: '/events' })
export class EventsGateway {
  @SubscribeMessage('echo')
  echo(@MessageBody() data: unknown) {
    return { event: 'echo', data };
  }
}
```

## Behavior

- Messages are `{ "event": "...", "data": ... }` JSON frames, like `@nestjs/platform-ws`. A handler's return value (a `WsResponse`, a Promise or an Observable) is sent back as JSON. Invalid JSON and unknown events are ignored. Pass `messageParser` to read another format.
- Each gateway has a `path` (default `/`). An upgrade on a path without a gateway is answered by Nest's router, usually with a 404.
- The client a gateway receives is Bun's `ServerWebSocket`: `send`, `close`, `subscribe`, `publish`. `handleConnection(client, request)` gets the upgrade `Request` (headers, URL) as its second argument.
- `@WebSocketServer()` injects a `BunWsServer` with `path`, `clients` and `publish(topic, data)`, which needs a listening server.
- Rooms use Bun's pub/sub: `client.subscribe(topic)` and `server.publish(topic, data)`. **Topics are global to the `Bun.serve` instance**: two gateways that use the same topic name reach each other's clients, so prefix topics (for example with the gateway path). `client.publish()` does not deliver to the sender.
- `app.close()` closes every socket with code 1001 before the HTTP server stops.
- Bun's WebSocket settings go in `new BunWsAdapter(app, { websocket: { maxPayloadLength, idleTimeout, backpressureLimit, closeOnBackpressureLimit, sendPings, perMessageDeflate } })`. Defaults: 16 MiB per message, 120 s idle with pings on.

Not supported: gateways on their own port (`@WebSocketGateway(4000)` throws, everything shares the HTTP port), namespaces (use Socket.IO), acknowledgements (`@Ack()` is Socket.IO only), and backpressure handling beyond Bun's `backpressureLimit`. For Socket.IO on the same port, use [`@nestbun/socket.io`](https://www.npmjs.com/package/@nestbun/socket.io).

## Security

- Authenticate in `handleConnection(client, request)`: read the token from `request` (header, cookie or query) and `client.close(4401, 'Unauthorized')` when it is missing or invalid. If the check is async, messages that arrive before it finishes still reach handlers; guard message handlers too (for example with a guard).
- Browsers send cookies on cross-site WebSocket upgrades: when you authenticate with cookies, check `request.headers.get('origin')` against your allowed origins.
- Bun accepts messages up to 16 MiB by default; on a public socket lower it, e.g. `new BunWsAdapter(app, { websocket: { maxPayloadLength: 64 * 1024 } })`.

## `WsException` arrives as "Internal server error"

With Bun's default **isolated** linker, `@nestjs/core` and `@nestjs/websockets` declare each other as peers, and Bun installs two copies of `@nestjs/websockets`. A `WsException` your code imports then comes from a different copy than the one Nest checks against, and the client gets `{ "status": "error", "message": "Internal server error" }` instead of your message. This happens with any Nest WebSocket adapter, not only this one. Install with the hoisted linker:

```toml
# bunfig.toml
[install]
linker = "hoisted"
```

## License

MIT
