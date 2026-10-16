import { IoAdapter } from '@nestjs/platform-socket.io';
import { Server as Engine, type ServerOptions as EngineOptions } from '@socket.io/bun-engine';
import type { Server, WebSocketHandler } from 'bun';
import { Server as SocketIoServer, type ServerOptions } from 'socket.io';

/** The parts of `BunHttpServer` (from `@nestbun/platform`) this adapter uses. */
interface UpgradeCapableServer {
  setUpgradeHook(
    hook: {
      path?: string;
      fetch(
        request: Request,
        server: Server<any>,
      ): Response | true | undefined | Promise<Response | true | undefined>;
      websocket: WebSocketHandler<any>;
    } | null,
  ): void;
}

export interface BunIoAdapterOptions {
  /**
   * Base options of the `@socket.io/bun-engine` instance: `editResponseHeaders`,
   * `editHandshakeHeaders`, ... The `cors`, `pingInterval`, `pingTimeout`, `upgradeTimeout` and
   * `maxHttpBufferSize` of `@WebSocketGateway()` override it; the path always comes from the gateway.
   */
  engine?: Partial<Omit<EngineOptions, 'path'>>;
}

/** Gateway options that belong to the engine; `bind()` does not forward them from the Server. */
const ENGINE_KEYS = [
  'cors',
  'pingInterval',
  'pingTimeout',
  'upgradeTimeout',
  'maxHttpBufferSize',
] as const;

/** Options that would silently change meaning on bun-engine; fail loudly instead. */
function assertSupported(options: unknown, where: string): void {
  const { allowRequest, cors } = (options ?? {}) as { allowRequest?: unknown; cors?: unknown };
  if (allowRequest !== undefined) {
    throw new Error(
      `BunIoAdapter does not support "allowRequest" (${where}): bun-engine calls it with (request, server). Use a Socket.IO middleware (server.use) instead`,
    );
  }
  // bun-engine only checks that `origin` is truthy, so a function would allow every origin.
  if (typeof cors === 'function' || typeof (cors as { origin?: unknown })?.origin === 'function') {
    throw new Error(
      `BunIoAdapter does not support a function as "cors" or "cors.origin" (${where}): use true, a string, a RegExp or an array`,
    );
  }
}

/** `/ws` and `/ws/` are the same path; engine.io-client always asks for the trailing slash. */
const withTrailingSlash = (path: string) => `${path.replace(/\/$/, '')}/`;

/**
 * Socket.IO gateways on `Bun.serve`, on the HTTP port of `BunAdapter`. A drop-in for `IoAdapter`
 * from `@nestjs/platform-socket.io`, backed by `@socket.io/bun-engine`.
 *
 * ```ts
 * app.useWebSocketAdapter(new BunIoAdapter(app));
 * ```
 */
export class BunIoAdapter extends IoAdapter {
  private readonly http: unknown;
  private io: { path: string; server: SocketIoServer } | null = null;

  constructor(
    appOrHttpServer?: object,
    private readonly options: BunIoAdapterOptions = {},
  ) {
    super(appOrHttpServer);
    // AbstractWsAdapter tells the app from the server with `instanceof NestApplication`, which
    // fails when the package manager installed two copies of @nestjs/core; go by shape instead.
    const app = appOrHttpServer as { getHttpServer?: () => unknown } | undefined;
    this.http = typeof app?.getHttpServer === 'function' ? app.getHttpServer() : appOrHttpServer;
    assertSupported(options.engine, 'options.engine');
  }

  override createIOServer(port: number, options?: ServerOptions): SocketIoServer {
    if (port) {
      throw new Error(
        `BunIoAdapter serves gateways on the HTTP port; remove the port (${port}) from @WebSocketGateway()`,
      );
    }
    const http = this.http as Partial<UpgradeCapableServer> | undefined;
    if (typeof http?.setUpgradeHook !== 'function') {
      throw new Error('BunIoAdapter requires BunAdapter as the HTTP adapter of the app');
    }
    assertSupported(options, '@WebSocketGateway()');

    const path = withTrailingSlash(options?.path ?? '/socket.io');
    if (this.io) {
      if (this.io.path !== path) {
        throw new Error(
          `BunIoAdapter serves one Socket.IO path per app: "${this.io.path}" is taken, "${path}" was requested`,
        );
      }
      // Nest keys its servers by the raw path, so "/socket.io" and no path both land here.
      return this.io.server;
    }

    const engineOptions: Partial<EngineOptions> = { ...this.options.engine, path };
    const rest: Record<string, unknown> = { ...options };
    for (const key of ENGINE_KEYS) {
      if (rest[key] !== undefined) (engineOptions as Record<string, unknown>)[key] = rest[key];
      delete rest[key];
    }

    const engine = new Engine(engineOptions);
    // Bun hides the peer address once a request is upgraded, and the engine emits 'connection'
    // after the upgrade: read it in the hook and hand it over, so `handshake.address` works.
    const addresses = new WeakMap<Request, string>();
    engine.on('connection', (socket, request) => {
      const address = addresses.get(request);
      if (address) (socket as { remoteAddress?: string }).remoteAddress = address;
    });

    const server = new SocketIoServer(rest as Partial<ServerOptions>);
    server.bind(engine as never);
    this.io = { path, server };

    http.setUpgradeHook({
      path,
      fetch: (request, bun) => {
        // Only a handshake (no sid) creates a socket; other requests skip the lookup.
        if (!new URL(request.url).searchParams.has('sid')) {
          const address = bun.requestIP(request)?.address;
          if (address) addresses.set(request, address);
        }
        return engine.handleRequest(request, bun);
      },
      websocket: engine.handler().websocket as WebSocketHandler<any>,
    });
    return server;
  }

  /**
   * Nest calls this once per entry of its container, and two raw paths that normalize alike share
   * one Server, so it can run more than once for the same server. Everything here is idempotent.
   */
  override async close(server: SocketIoServer): Promise<void> {
    // A reconnect landing between here and the HTTP close would open a long-poll that holds the
    // shutdown until `shutdownTimeout`: stop routing to the engine first.
    (this.http as Partial<UpgradeCapableServer> | undefined)?.setUpgradeHook?.(null);
    // IoAdapter.close() returns early under forceCloseConnections when both `httpServer`s are
    // undefined (always, with bind), which would skip the close.
    if (typeof server.close === 'function') {
      await new Promise<void>((resolve) => void server.close(() => resolve()));
    }
  }

  override async dispose(): Promise<void> {
    (this.http as Partial<UpgradeCapableServer> | undefined)?.setUpgradeHook?.(null);
    this.io = null;
  }
}
