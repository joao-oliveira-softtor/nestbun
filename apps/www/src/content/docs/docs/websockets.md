---
title: WebSockets
description: WebSocket and Socket.IO gateways on Bun.serve with @nestbun/ws and @nestbun/socket.io, on the HTTP port.
---

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

Not supported: gateways on their own port (`@WebSocketGateway(4000)` throws, everything shares the HTTP port), namespaces (use Socket.IO), acknowledgements (`@Ack()` is Socket.IO only), and backpressure handling beyond Bun's `backpressureLimit`. For Socket.IO on the same port, see [Socket.IO](#socketio) below.

## Security

- Authenticate in `handleConnection(client, request)`: read the token from `request` (header, cookie or query) and `client.close(4401, 'Unauthorized')` when it is missing or invalid. If the check is async, messages that arrive before it finishes still reach handlers; guard message handlers too (for example with a guard).
- Browsers send cookies on cross-site WebSocket upgrades: when you authenticate with cookies, check `request.headers.get('origin')` against your allowed origins.
- Bun accepts messages up to 16 MiB by default; on a public socket lower it, e.g. `new BunWsAdapter(app, { websocket: { maxPayloadLength: 64 * 1024 } })`.

## `WsException` arrives as "Internal server error"

With Bun's default **isolated** linker, `@nestjs/core` and `@nestjs/websockets` declare each other as peers, and Bun installs two copies of `@nestjs/websockets`. A `WsException` your code imports then comes from a different copy than the one Nest checks against, and the client gets `{ "status": "error", "message": "Internal server error" }` instead of your message (with `@nestbun/socket.io`, an `exception` event with that message). This happens with any Nest WebSocket adapter, not only these. Install with the hoisted linker:

```toml
# bunfig.toml
[install]
linker = "hoisted"
```

## Socket.IO

`@nestbun/socket.io` serves Socket.IO gateways on the same port, through [`@socket.io/bun-engine`](https://github.com/socketio/bun-engine) and the same upgrade hook. It is the counterpart of `@nestjs/platform-socket.io`: namespaces, rooms, acknowledgements, `@SubscribeMessage()`, guards, pipes, interceptors and exception filters work unchanged, over `websocket` and `polling`.

```bash
bun add @nestbun/socket.io @nestjs/websockets @nestjs/platform-socket.io socket.io
```

```ts
import { BunIoAdapter } from '@nestbun/socket.io';

const app = await NestFactory.create<NestBunApplication>(AppModule, new BunAdapter());
app.useWebSocketAdapter(new BunIoAdapter(app));
await app.listen(3000);
```

```ts
@WebSocketGateway({ namespace: 'chat', cors: { origin: true } })
export class ChatGateway {
  @SubscribeMessage('echo')
  echo(@MessageBody() data: unknown) {
    return data; // sent back as the acknowledgement
  }
}
```

### Behavior

- Clients connect to the HTTP port. Everything else on it is still answered by Nest's router.
- `app.close()` stops routing to the engine, disconnects every socket with `"server shutting down"` and then closes the HTTP server, so a client in long-polling does not hold the shutdown.
- `handshake.address` is the TCP peer, like `socket.remoteAddress` on `node:http`. It ignores `trustProxy`: read `x-forwarded-for` yourself behind a proxy.
- Engine options set on `@WebSocketGateway()` (`cors`, `pingInterval`, `pingTimeout`, `upgradeTimeout`, `maxHttpBufferSize`) go to the engine. The others, such as `editResponseHeaders` and `editHandshakeHeaders`, go to the adapter: `new BunIoAdapter(app, { engine: { editResponseHeaders } })`. The gateway options win over the adapter's. All gateways share one engine, so these options come from the **first gateway registered**: the same options on later gateways are ignored.

### Differences from `IoAdapter`

- **One Socket.IO path per app.** Gateways with no `path`, `/socket.io` and `/socket.io/` share one server; another path throws at startup. The path is served with a trailing slash, which is what `socket.io-client` asks for: a client created with `addTrailingSlash: false` gets a 404.
- **No separate port.** `@WebSocketGateway(4000)` throws.
- **Unsupported options throw instead of changing meaning.** `allowRequest` (use a middleware with `server.use()`) and a function as `cors` or `cors.origin` (bun-engine would allow every origin). `transports`, `allowUpgrades` and `serveClient` are ignored, and `/socket.io/socket.io.js` is not served.
- **CORS is static**: `origin: true`, a string, a RegExp or an array. A falsy `origin` answers `*`. `server.engine.on('headers', ...)` is accepted but never fires: use `editResponseHeaders`. As with every engine option, the first gateway registered defines it.
- **`handshake.url` is absolute.** Polling bodies are limited by Bun's `maxRequestBodySize` (the `BunAdapter` option) before `maxHttpBufferSize` is checked.
- **`idleTimeout`** of `Bun.serve` must be at least `2 × pingInterval`; the default of 120 s covers the 25 s default.
- It does not run together with `BunWsAdapter`: both need the one upgrade hook of the HTTP server, and the second to register throws.
- `@socket.io/bun-engine` is pre-1.0 (`0.x`) and is pinned to an exact version.

### Security

- Authenticate in a middleware (`server.use()` in `afterInit`) or in `handleConnection`, reading `client.handshake.auth` or `client.handshake.headers`. A middleware that calls `next(new Error(...))` rejects the connection before it reaches the gateway.
- Set `cors.origin` to your own origins on a public socket instead of `true`, and lower `maxHttpBufferSize` (1 MB by default).
