import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import type { Server, ServerWebSocket, TLSOptions, WebSocketHandler } from 'bun';

export type FetchHandler = (
  request: Request,
  server: Server<unknown>,
) => Response | Promise<Response>;

/** Options forwarded to `Bun.serve()`. */
export interface BunServeOptions {
  /** Seconds a connection may sit idle before Bun closes it (max 255, 0 disables). Default 120. */
  idleTimeout?: number;
  /** Hard cap on request bodies, in bytes. Default 128 MiB (Bun's default). */
  maxRequestBodySize?: number;
  /** TLS options; set automatically from Nest's `httpsOptions`. */
  tls?: TLSOptions;
  reusePort?: boolean;
  development?: boolean;
  /** Max milliseconds a graceful `close()` waits for in-flight requests before forcing. Default 10000. */
  shutdownTimeout?: number;
}

/**
 * Takes WebSocket upgrades off the request path before Nest's router sees them.
 * Registered with `BunHttpServer.setUpgradeHook()`; `@nestbun/ws` installs one.
 */
export interface BunUpgradeHook {
  /**
   * Exact pathname whose requests always go to `fetch`, whatever the method. Without it,
   * only requests carrying `Upgrade: websocket` do.
   */
  path?: string;
  /**
   * `true` once `server.upgrade()` succeeded, a `Response` to answer with, or `undefined`
   * to hand the request to the router.
   */
  fetch(
    request: Request,
    server: Server<any>,
  ): Response | true | undefined | Promise<Response | true | undefined>;
  /** Passed to `Bun.serve({ websocket })`; it owns `ws.data`. */
  websocket: WebSocketHandler<any>;
}

export interface ServerAddress {
  address: string;
  family: 'IPv4' | 'IPv6';
  port: number;
}

// shortcut: swaps the prototype so core's `instanceof tls.Server` (getUrl https) passes; not a
// documented API. Upgrade: when core reads the protocol from the options, or Bun.serve can be
// wrapped by a real tls.Server. Covered by https.test.ts, which fails if this stops working.
function tlsServerPrototype(): object {
  const proto = Object.create(tls.Server.prototype);
  for (const name of Object.getOwnPropertyNames(BunHttpServer.prototype)) {
    if (name !== 'constructor') {
      Object.defineProperty(
        proto,
        name,
        Object.getOwnPropertyDescriptor(BunHttpServer.prototype, name)!,
      );
    }
  }
  return proto;
}

/**
 * Wraps `Bun.serve()` in the parts of the Node `net.Server` API that Nest's
 * core touches: `listen`, `close`, `address`, and the `'error'`/`'listening'`
 * events. `getHttpServer()` returns this.
 */
export class BunHttpServer extends EventEmitter {
  /** The live `Bun.serve()` instance once listening. */
  bun: Server<unknown> | null = null;
  private unixPath: string | null = null;
  private closing = false;
  /** Set once shutdown starts, graceful or forced; unlike `closing`, it never adds headers. */
  private draining = false;
  private upgradeHook: BunUpgradeHook | null = null;
  private readonly sockets = new Set<ServerWebSocket<any>>();

  constructor(
    private readonly fetchHandler: FetchHandler,
    private readonly options: BunServeOptions = {},
  ) {
    super();
    if (this.options.tls) Object.setPrototypeOf(this, tlsServerPrototype());
  }

  get listening(): boolean {
    return this.bun !== null;
  }

  /**
   * Installs the single upgrade hook. It must be set before `listen()`, which hands its
   * `websocket` handler to `Bun.serve`. Clearing it (`null`) is always allowed: new upgrades
   * then reach the router, while sockets already open keep their handler.
   */
  setUpgradeHook(hook: BunUpgradeHook | null): void {
    if (hook) {
      if (this.upgradeHook) throw new Error('An upgrade hook is already registered');
      if (this.bun) throw new Error('Register the upgrade hook before listen()');
    }
    this.upgradeHook = hook;
  }

  private hookFor(request: Request): BunUpgradeHook | null {
    const hook = this.upgradeHook;
    if (!hook || !this.bun) return null;
    if (hook.path !== undefined) return new URL(request.url).pathname === hook.path ? hook : null;
    return request.headers.get('upgrade')?.toLowerCase() === 'websocket' ? hook : null;
  }

  /** Tracks open sockets for shutdown; dispatches to the handler captured at `listen()`. */
  private dispatcher(handler: WebSocketHandler<any>): WebSocketHandler<any> {
    return {
      ...handler,
      open: (ws) => {
        this.sockets.add(ws);
        const opened = handler.open?.(ws);
        // An async hook may finish upgrading after shutdown swept the open sockets.
        if (this.draining) ws.close(1001, 'Server shutting down');
        return opened;
      },
      close: (ws, code, reason) => {
        this.sockets.delete(ws);
        return handler.close?.(ws, code, reason);
      },
    };
  }

  listen(port: number | string, hostname?: string, callback?: (err?: Error) => void): this {
    this.closing = false;
    this.draining = false;
    if (this.bun) {
      const err = new Error('Server is already listening');
      callback ? callback(err) : this.emit('error', err);
      return this;
    }
    const { shutdownTimeout: _shutdownTimeout, ...serveOptions } = this.options;
    const websocket = this.upgradeHook && this.dispatcher(this.upgradeHook.websocket);
    const base = {
      idleTimeout: 120,
      ...serveOptions,
      ...(websocket && { websocket }),
      fetch: async (request: Request, server: Server<unknown>) => {
        const hook = this.hookFor(request);
        if (hook) {
          const handled = await hook.fetch(request, server);
          // true: the upgrade went through and Bun must get `undefined` back.
          if (handled === true) return undefined;
          if (handled) return handled;
        }
        const response = await this.fetchHandler(request, server);
        // While draining, ask clients to drop their keep-alive connections.
        if (this.closing) {
          try {
            response.headers.set('connection', 'close');
          } catch {
            /* immutable headers */
          }
        }
        return response;
      },
      error: (error: Error) => {
        this.emit('clientError', error);
        return new Response('Internal Server Error', { status: 500 });
      },
    };
    try {
      if (typeof port === 'string' && !/^\d+$/.test(port)) {
        this.unixPath = port;
        this.bun = Bun.serve({ ...base, unix: port } as never);
      } else {
        this.bun = Bun.serve({ ...base, port: Number(port), hostname } as never);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (this.listenerCount('error') > 0) this.emit('error', err);
      else if (callback) callback(err);
      else throw err;
      return this;
    }
    this.emit('listening');
    callback?.();
    return this;
  }

  /** Node-compatible: `{ address, family, port }`, a path for unix sockets, or `null` when not listening. */
  address(): ServerAddress | string | null {
    if (!this.bun) return null;
    if (this.unixPath) return this.unixPath;
    const address = this.bun.hostname ?? '0.0.0.0';
    return { address, family: address.includes(':') ? 'IPv6' : 'IPv4', port: this.bun.port ?? 0 };
  }

  close(callback?: (err?: Error) => void): this;
  close(force: boolean, callback?: (err?: Error) => void): this;
  close(forceOrCb?: boolean | ((err?: Error) => void), maybeCb?: (err?: Error) => void): this {
    const force = typeof forceOrCb === 'boolean' ? forceOrCb : false;
    const callback = typeof forceOrCb === 'function' ? forceOrCb : maybeCb;
    if (!this.bun) {
      callback?.(new Error('Server is not running'));
      return this;
    }
    const server = this.bun;
    this.bun = null;
    this.unixPath = null;
    void this.shutdown(server, force).then(() => {
      this.emit('close');
      callback?.();
    });
    return this;
  }

  /**
   * Graceful by default: close WebSockets with 1001 and let them and in-flight requests
   * finish (up to `shutdownTimeout`),
   * then stop and drop every connection, including idle keep-alive ones.
   * Bun's `stop(false)` cannot be followed by `stop(true)`, so we wait first.
   * `force` skips the wait.
   */
  private async shutdown(server: Server<unknown>, force: boolean): Promise<void> {
    // 1001 "going away": stop(true) alone drops WebSockets with 1006 and no close frame.
    this.draining = true;
    for (const ws of this.sockets) ws.close(1001, 'Server shutting down');
    if (!force) {
      this.closing = true;
      const deadline = Date.now() + (this.options.shutdownTimeout ?? 10_000);
      while ((server.pendingRequests > 0 || this.sockets.size > 0) && Date.now() < deadline) {
        await Bun.sleep(5);
      }
    }
    await server.stop(true);
    this.sockets.clear();
  }

  /** Destroys in-flight connections (Node's `server.closeAllConnections()`). */
  closeAllConnections(): void {
    void this.bun?.stop(true);
  }

  /** Promise-friendly close used by the adapter. */
  stop(force = false): Promise<void> {
    return new Promise((resolve) => {
      if (!this.bun) return resolve();
      this.close(force, () => resolve());
    });
  }
}
