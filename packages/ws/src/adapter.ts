import { Logger, type WsMessageHandler } from '@nestjs/common';
import { normalizePath } from '@nestjs/common/utils/shared.utils.js';
import { AbstractWsAdapter } from '@nestjs/websockets';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import { EMPTY, type Observable, Subject, catchError, filter, mergeMap, takeUntil } from 'rxjs';

/** The parts of `BunHttpServer` (from `@nestbun/platform`) this adapter uses. */
interface UpgradeCapableServer {
  bun: Server<unknown> | null;
  setUpgradeHook(
    hook: {
      fetch(request: Request, server: Server<any>): Response | true | undefined;
      websocket: WebSocketHandler<any>;
    } | null,
  ): void;
}

export interface WsMessage {
  event: string;
  data: unknown;
}

export type MessageParser = (data: string | Buffer) => WsMessage | null | undefined;

/** Bun's per-server WebSocket settings, applied to every gateway. */
export type BunWebSocketOptions = Omit<
  WebSocketHandler<BunWsData>,
  'open' | 'message' | 'close' | 'drain' | 'ping' | 'pong'
>;

export interface BunWsAdapterOptions {
  /** Turns a raw frame into `{ event, data }`. Default: `JSON.parse`. */
  messageParser?: MessageParser;
  /** `maxPayloadLength`, `idleTimeout`, `backpressureLimit`, `sendPings`, ... */
  websocket?: BunWebSocketOptions;
}

/** Per-socket state, kept in `ws.data`. */
export interface BunWsData {
  /** The upgrade request; also the 2nd argument of `handleConnection`. */
  readonly request: Request;
  readonly server: BunWsServer;
  readonly messages: Subject<string | Buffer>;
  readonly closed: Subject<void>;
  readonly onClose: ((...args: unknown[]) => void)[];
}

/** What gateways receive as a client: Bun's own socket (`send`, `subscribe`, `publish`, ...). */
export type BunWsClient = ServerWebSocket<BunWsData>;

const defaultMessageParser: MessageParser = (data) => JSON.parse(data.toString()) as WsMessage;

/** One gateway path. Injected by `@WebSocketServer()`. */
export class BunWsServer {
  readonly clients = new Set<BunWsClient>();
  /** @internal */
  readonly connectionListeners: ((client: BunWsClient, request: Request) => void)[] = [];

  constructor(
    readonly path: string,
    private readonly http: UpgradeCapableServer,
  ) {}

  /**
   * Sends to every socket subscribed to `topic`. Topics belong to the whole `Bun.serve`
   * instance, so two gateways sharing a topic name reach each other's clients: prefix them.
   */
  publish(topic: string, data: string | Bun.BufferSource): number {
    if (!this.http.bun) {
      throw new Error('BunWsServer.publish() needs a listening server; call it after app.listen()');
    }
    return this.http.bun.publish(topic, data);
  }
}

/**
 * WebSocket gateways on `Bun.serve`, on the HTTP port of `BunAdapter`. A drop-in for
 * `WsAdapter` from `@nestjs/platform-ws`: `{ event, data }` messages, one path per gateway.
 *
 * ```ts
 * app.useWebSocketAdapter(new BunWsAdapter(app));
 * ```
 */
export class BunWsAdapter extends AbstractWsAdapter<any, any> {
  private readonly logger = new Logger(BunWsAdapter.name);
  private readonly http: unknown;
  private readonly messageParser: MessageParser;
  private readonly servers = new Map<string, BunWsServer>();
  private hooked = false;

  constructor(
    appOrHttpServer?: object,
    private readonly options: BunWsAdapterOptions = {},
  ) {
    super(appOrHttpServer);
    // AbstractWsAdapter tells the app from the server with `instanceof NestApplication`, which
    // fails when the package manager installed two copies of @nestjs/core; go by shape instead.
    const app = appOrHttpServer as { getHttpServer?: () => unknown } | undefined;
    this.http = typeof app?.getHttpServer === 'function' ? app.getHttpServer() : appOrHttpServer;
    this.messageParser = options.messageParser ?? defaultMessageParser;
  }

  create(port: number, options: { path?: string; namespace?: string } = {}): BunWsServer {
    if (options.namespace) {
      const error = new Error(
        '"BunWsAdapter" does not support namespaces. If you need namespaces in your project, consider using the "@nestjs/platform-socket.io" package instead.',
      );
      this.logger.error(error);
      throw error;
    }
    if (port) {
      throw new Error(
        `BunWsAdapter serves gateways on the HTTP port; remove the port (${port}) from @WebSocketGateway()`,
      );
    }
    const http = this.http as Partial<UpgradeCapableServer> | undefined;
    if (typeof http?.setUpgradeHook !== 'function') {
      throw new Error('BunWsAdapter requires BunAdapter as the HTTP adapter of the app');
    }
    const path = normalizePath(options.path);
    let server = this.servers.get(path);
    if (!server) {
      server = new BunWsServer(path, http as UpgradeCapableServer);
      this.servers.set(path, server);
    }
    if (!this.hooked) {
      (http as UpgradeCapableServer).setUpgradeHook(this.upgradeHook());
      this.hooked = true;
    }
    return server;
  }

  override bindClientConnect(server: BunWsServer, callback: Function): void {
    server.connectionListeners.push(callback as (client: BunWsClient, request: Request) => void);
  }

  override bindClientDisconnect(client: BunWsClient, callback: Function): void {
    client.data.onClose.push(callback as (...args: unknown[]) => void);
  }

  bindMessageHandlers(
    client: BunWsClient,
    handlers: WsMessageHandler[],
    transform: (data: any) => Observable<any>,
  ): void {
    const handlersMap = new Map(handlers.map((handler) => [handler.message, handler]));
    client.data.messages
      .pipe(
        mergeMap((raw) =>
          this.handleMessage(raw, handlersMap, transform).pipe(
            filter((result) => result !== undefined && result !== null),
            // Same as WsAdapter: a filter that rethrows is an app bug; log it, keep the stream.
            catchError((err) => {
              this.logger.error(err);
              return EMPTY;
            }),
          ),
        ),
        takeUntil(client.data.closed),
      )
      .subscribe((response) => {
        if (client.readyState !== WebSocket.OPEN) return;
        // An unserializable reply (cycle, BigInt, deep nesting) must drop only itself: an error
        // thrown in the observer would surface as an unhandled RxJS error and can kill the process.
        try {
          // shortcut: send() returns -1 (backpressure) or 0 (dropped) and is not handled; use the
          // websocket backpressureLimit/closeOnBackpressureLimit options, and add drain handling if
          // a gateway streams large volumes.
          client.send(JSON.stringify(response));
        } catch (err) {
          this.logger.error(err);
        }
      });
  }

  override async close(server: BunWsServer): Promise<void> {
    for (const client of server.clients) client.close(1001, 'Server shutting down');
    server.clients.clear();
  }

  override async dispose(): Promise<void> {
    if (this.hooked) (this.http as UpgradeCapableServer).setUpgradeHook(null);
    this.hooked = false;
    this.servers.clear();
  }

  private handleMessage(
    raw: string | Buffer,
    handlersMap: Map<string, WsMessageHandler>,
    transform: (data: any) => Observable<any>,
  ): Observable<any> {
    let message: WsMessage | null | undefined;
    try {
      message = this.messageParser(raw);
    } catch (err) {
      // The default parser throws on client input, which must not flood the logs; a custom
      // parser that throws is an app bug.
      if (this.messageParser !== defaultMessageParser) this.logger.error(err);
      return EMPTY;
    }
    const handler = message && handlersMap.get(message.event);
    if (!message || !handler) return EMPTY;
    try {
      return transform(handler.callback(message.data, message.event));
    } catch (err) {
      // A synchronous throw would tear down this client's stream; log it and keep the stream.
      this.logger.error(err);
      return EMPTY;
    }
  }

  private upgradeHook() {
    return {
      fetch: (request: Request, bun: Server<BunWsData>): Response | true | undefined => {
        const server = this.servers.get(new URL(request.url).pathname);
        // No gateway on this path: let Nest's router answer (usually 404).
        if (!server) return undefined;
        const data: BunWsData = {
          request,
          server,
          messages: new Subject(),
          closed: new Subject(),
          onClose: [],
        };
        return bun.upgrade(request, { data })
          ? true
          : new Response('WebSocket upgrade failed', { status: 400 });
      },
      websocket: {
        ...this.options.websocket,
        open: (ws: BunWsClient) => {
          ws.data.server.clients.add(ws);
          for (const listener of ws.data.server.connectionListeners) listener(ws, ws.data.request);
        },
        message: (ws: BunWsClient, message: string | Buffer) => ws.data.messages.next(message),
        close: (ws: BunWsClient, code: number, reason: string) => {
          ws.data.server.clients.delete(ws);
          ws.data.closed.next();
          ws.data.closed.complete();
          ws.data.messages.complete();
          for (const callback of ws.data.onClose) callback(code, reason);
        },
      } satisfies WebSocketHandler<BunWsData>,
    };
  }
}
