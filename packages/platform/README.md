# @nestbun/platform

Run [NestJS](https://nestjs.com) directly on [`Bun.serve()`](https://bun.com/docs/api/http). No Express, no `node:http`, no build step.

**Docs:** https://mguay22.github.io/nestbun/docs/getting-started/

```ts
import { NestFactory } from '@nestjs/core';
import { BunAdapter, type NestBunApplication } from '@nestbun/platform';

const app = await NestFactory.create<NestBunApplication>(AppModule, new BunAdapter());
await app.listen(3000);
```

That is the whole migration. Controllers, pipes, guards, interceptors, filters, middleware, `@Res()`, SSE, `StreamableFile`, cookies, CORS, versioning, static assets, `@nestjs/swagger`: all unchanged.

## Install

```bash
bun add @nestbun/platform
```

Requires Bun ≥ 1.4 and NestJS ≥ 12. In a monorepo, keep a `tsconfig.json` at the root: Bun resolves it from the working directory, and without `experimentalDecorators` it compiles TC39 decorators, which Nest cannot use.

## Why

- **Speed.** Same Nest app, same machine, same runtime, three adapters:

  | adapter | GET /users/:id | POST /users (JSON) |
  |---|---:|---:|
  | `@nestjs/platform-express` | 93k req/s | 72k req/s |
  | `@nestjs/platform-fastify` | 116k req/s | 92k req/s |
  | **`@nestbun/platform`** | **119k req/s** | **98k req/s** |

  Raw `Bun.serve` with no framework does 157k on the same test. Apple M-series laptop, 64 connections, 3s runs, load generator in a separate process. Reproduce with `bun run bench` in the repo.

- **Web standards.** Requests are Web `Request`s, responses become Web `Response`s, files go out via `Bun.file()` with zero-copy `sendfile`.
- **Testing without sockets.** `adapter.fetch(new Request(...))` runs a request through the full Nest pipeline in-process. No supertest, no port.

## What works

### NestJS features

| Feature | Status |
|---|---|
| Routing, params, wildcards, `@All`, HEAD → GET fallback | ✅ |
| `@Body` / `@Query` / `@Param` / `@Headers` / `@Ip` / `@Req` / `@Res` / `@Next` | ✅ |
| JSON + urlencoded parsing, `rawBody`, `bodyParser: false`, `useBodyParser('text' \| 'raw')`, 413 limits | ✅ |
| Exception filters, 404 / 500 shapes identical to Express | ✅ |
| Nest middleware (`MiddlewareConsumer`, `forRoutes`, `exclude`, method-scoped), `app.use()`, `next(err)` | ✅ |
| Global prefix with `exclude`; URI / header / media-type / custom versioning | ✅ |
| CORS (`app.enableCors`) | ✅ |
| `@Redirect`, `@Header`, `@HttpCode`, `res.cookie()` / `clearCookie()`, `setCookie` | ✅ |
| Server-Sent Events with disconnect detection | ✅ |
| `StreamableFile`, manual `res.write()` streaming | ✅ |
| Static assets with ETag / Last-Modified / 304 | ✅ |
| View engines: `ejs`, `hbs`, `pug`, custom `render()` | ✅ |
| `httpsOptions`, `forceCloseConnections`, `return503OnClosing`, graceful shutdown | ✅ |
| Unix socket listen | ✅ |
| Security hooks (`useSecurityHeaders`, `enableCsrfProtection`) | ✅ via `AbstractHttpAdapter` |
| `trustProxy` (`req.ip`, `req.ips`, `req.protocol`, `req.host` via `X-Forwarded-*`) | ✅ |
| WebSocket gateways | ✅ [`@nestbun/ws`](https://mguay22.github.io/nestbun/docs/websockets/) (`BunWsAdapter`: one path per gateway, `{ event, data }` messages, pub/sub rooms, `messageParser`) |
| Socket.IO gateways | ✅ [`@nestbun/socket.io`](https://mguay22.github.io/nestbun/docs/websockets/#socketio) (`BunIoAdapter`: namespaces, rooms, acks, middleware, `websocket` and `polling` on the HTTP port) |
| Multipart via the `@UploadedFile()` decorator | ⏳ planned |
| Multipart via `req.native.formData()` (Web `Request`, limit via `serve.maxRequestBodySize`) | ✅ |

### Ecosystem packages

| Package | Status |
|---|---|
| `@nestjs/testing` | ✅ `createNestApplication(new BunAdapter())` |
| `@nestjs/swagger` | ✅ UI, JSON, YAML and assets |
| `@nestjs/throttler` | ✅ `ThrottlerGuard`, `X-RateLimit-*` / `Retry-After` headers, `@SkipThrottle()` |
| `@nestjs/terminus` | ✅ `@HealthCheck()`: 200 when up, 503 with details when down |
| `@nestjs/passport` + `passport-jwt` | ✅ `AuthGuard('jwt')`, `req.user` |
| `helmet` | ✅ `app.use(helmet())` |
| `cookie-parser` | ✅ `app.use(cookieParser(secret))`, `req.cookies` / `req.signedCookies` |
| `cors` | ✅ used internally |
| `@nestjs/serve-static` | ⚠️ untested; use `useStaticAssets` |
| `@nestjs/platform-socket.io`, `@nestjs/platform-ws` | ❌ attach to a Node server (the adapter logs a warning when one does); use `BunWsAdapter` from `@nestbun/ws` and `BunIoAdapter` from `@nestbun/socket.io` instead |
| `supertest` | ❌ use `adapter.fetch()` |
| `multer` / `@nestjs/platform-express` interceptors | ❌ Express-only |
| Arbitrary Express middleware | ⚠️ see [Differences from Express](https://mguay22.github.io/nestbun/docs/differences-from-express/) |

## Options

```ts
new BunAdapter({
  trustProxy: true,          // honor X-Forwarded-For / -Proto / -Host
  bodyLimit: '1mb',          // default 100kb, same as Express
  serve: {                   // forwarded to Bun.serve()
    idleTimeout: 120,        // seconds, max 255
    maxRequestBodySize: 128 * 1024 * 1024,
    shutdownTimeout: 10_000, // ms to wait for in-flight requests on app.close()
    reusePort: true,
  },
});
```

## Testing without a port

```ts
const adapter = new BunAdapter();
const app = moduleRef.createNestApplication(adapter);
await app.init();

const res = await adapter.fetch(new Request('http://localhost/users/1'));
expect(res.status).toBe(200);
```

## Differences from Express you may notice

- Query strings use Express 5's simple parser: repeated keys become arrays, no `a[b]=c` nesting.
- Route registration order matters (first match wins), exactly as in Express. Declare `:id` routes after static siblings.
- `Buffer` return values are sent as `application/octet-stream` bytes rather than JSON-encoded.
- `Content-Type` strings get `charset=utf-8` when set through Nest or `res.set()`, but not through Node-level `res.setHeader()`, matching Express.

## How it works

`BunAdapter` extends Nest's `AbstractHttpAdapter`. Each `Bun.serve` request is wrapped in a `BunRequest` (a Node `Readable` with Express-shaped fields, computed lazily) and a `BunResponse` (a Node `Writable` that resolves into a Web `Response`). A small Express-style layer router built on `path-to-regexp` v8 runs middleware and routes in order. Because the response is a real `Writable`, Nest's own SSE stream and `StreamableFile` pipe into it unchanged; `end()` without a prior `write()` takes a buffered fast path, anything else becomes a `ReadableStream`.

## License

MIT
