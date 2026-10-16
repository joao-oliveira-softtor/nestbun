# @nestbun/socket.io

NestJS Socket.IO gateways on `Bun.serve`, on the same port as the HTTP app. It is the counterpart of `@nestjs/platform-socket.io` for [`@nestbun/platform`](https://www.npmjs.com/package/@nestbun/platform), built on [`@socket.io/bun-engine`](https://github.com/socketio/bun-engine): gateways, namespaces, rooms, acknowledgements, `@SubscribeMessage()`, guards, pipes, interceptors and exception filters work unchanged.

```bash
bun add @nestbun/socket.io @nestjs/websockets @nestjs/platform-socket.io socket.io
```

```ts
import { NestFactory } from '@nestjs/core';
import { BunAdapter, type NestBunApplication } from '@nestbun/platform';
import { BunIoAdapter } from '@nestbun/socket.io';
import { AppModule } from './app.module.js';

const app = await NestFactory.create<NestBunApplication>(AppModule, new BunAdapter());
app.useWebSocketAdapter(new BunIoAdapter(app));
await app.listen(3000);
```

```ts
import { MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';

@WebSocketGateway({ namespace: 'chat', cors: { origin: true } })
export class ChatGateway {
  @SubscribeMessage('echo')
  echo(@MessageBody() data: unknown) {
    return data; // sent back as the acknowledgement
  }
}
```

## Behavior

- Clients connect to the HTTP port, with `websocket` and `polling` transports and the polling → websocket upgrade. Everything else on the port is still answered by Nest's router.
- `app.close()` stops routing to the engine, disconnects every socket with `"server shutting down"` and then closes the HTTP server, so a client in long-polling does not hold the shutdown.
- `handshake.address` is the TCP peer, like `socket.remoteAddress` on `node:http`. It ignores `trustProxy`: read `x-forwarded-for` yourself if you are behind a proxy.
- Engine options set on `@WebSocketGateway()` (`cors`, `pingInterval`, `pingTimeout`, `upgradeTimeout`, `maxHttpBufferSize`) go to the engine. To set the others, such as `editResponseHeaders` and `editHandshakeHeaders`, pass them to the adapter: `new BunIoAdapter(app, { engine: { editResponseHeaders } })`. The gateway options win over the adapter's. All gateways share one engine, so these options come from the **first gateway registered**: the same options on later gateways are ignored.

## Differences from `IoAdapter`

- **One Socket.IO path per app.** Gateways with no `path`, `/socket.io` and `/socket.io/` share one server. A gateway with another path throws at startup. The path is served with a trailing slash, which is what `socket.io-client` asks for; a client created with `addTrailingSlash: false` gets a 404.
- **No separate port.** `@WebSocketGateway(4000)` throws; everything shares the HTTP port.
- **Unsupported options throw instead of changing meaning.** `allowRequest` (bun-engine calls it with `(request, server)`; use a middleware with `server.use()` instead) and a function as `cors` or `cors.origin` (bun-engine would allow every origin). `transports`, `allowUpgrades` and `serveClient` are ignored, and `/socket.io/socket.io.js` is not served.
- **CORS is static.** `origin: true`, a string, a RegExp or an array. A falsy `origin` answers `*`. `server.engine.on('headers', ...)` is accepted but never fires: use `editResponseHeaders`. As with every engine option, the first gateway registered defines it.
- **`handshake.url` is absolute** (`http://host/socket.io/?EIO=4...`).
- **Polling bodies** are limited by Bun's `maxRequestBodySize` (the `BunAdapter` option) before `maxHttpBufferSize` is checked.
- **`idleTimeout`** of `Bun.serve` must be at least `2 × pingInterval` (the default of 120 s covers the 25 s default), or long-polls are cut.
- It does not run together with `BunWsAdapter` from `@nestbun/ws`: both need the one upgrade hook of the HTTP server, and the second to register throws.
- `@socket.io/bun-engine` is pre-1.0 (`0.x`) and is pinned to an exact version here.

## Security

- Authenticate in a middleware (`server.use()` in `afterInit`) or in `handleConnection`, reading `client.handshake.auth` or `client.handshake.headers`. A middleware that calls `next(new Error(...))` rejects the connection before it reaches the gateway.
- Set `cors.origin` to your own origins on a public socket instead of `true`.
- Messages are limited by `maxHttpBufferSize` (1 MB by default); lower it on a public socket.

## `WsException` arrives as "Internal server error"

With Bun's default **isolated** linker, `@nestjs/core` and `@nestjs/websockets` declare each other as peers, and Bun installs two copies of `@nestjs/websockets`. A `WsException` your code imports then comes from a different copy than the one Nest checks against, and the client gets `Internal server error` instead of your message. This happens with any Nest WebSocket adapter, not only this one. Install with the hoisted linker:

```toml
# bunfig.toml
[install]
linker = "hoisted"
```

## License

MIT
