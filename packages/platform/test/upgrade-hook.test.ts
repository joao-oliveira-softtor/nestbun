import { afterEach, describe, expect, it } from 'bun:test';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocketHandler } from 'bun';
import {
  BunAdapter,
  type BunHttpServer,
  type BunUpgradeHook,
  type NestBunApplication,
} from '../src/index.js';
import { bootstrap, type TestApp } from './helpers.js';

@Controller()
class RootController {
  @Get()
  root() {
    return { router: true };
  }

  @Get('slow')
  async slow() {
    await Bun.sleep(300);
    return { slow: true };
  }
}
@Module({ controllers: [RootController] })
class RootModule {}

const echo: WebSocketHandler<undefined> = {
  message: (ws, message) => void ws.send(`echo:${message}`),
};

const upgrading = (extra: Partial<BunUpgradeHook> = {}): BunUpgradeHook => ({
  fetch: (req, server) =>
    server.upgrade(req) ? true : new Response('no upgrade', { status: 400 }),
  websocket: echo,
  ...extra,
});

const serverOf = (adapter: BunAdapter) => adapter.getHttpServer() as BunHttpServer;
const wsUrl = (t: TestApp, path = '/') => t.url.replace(/^http/, 'ws') + path;

/** Resolves with the open socket, or rejects if it closes or errors before opening. */
function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
    ws.addEventListener('close', (e) => reject(new Error(`closed before open (${e.code})`)), {
      once: true,
    });
  });
}

const nextMessage = (ws: WebSocket) =>
  new Promise<string>((resolve) => {
    ws.addEventListener('message', (e) => resolve(String(e.data)), { once: true });
  });

const closed = (ws: WebSocket) =>
  new Promise<number>((resolve) => {
    ws.addEventListener('close', (e) => resolve(e.code), { once: true });
  });

describe('BunHttpServer upgrade hook', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close().catch(() => {});
    t = undefined;
  });

  it('without a hook, an upgrade request reaches the router and HTTP is unchanged', async () => {
    t = await bootstrap(RootModule);
    await expect(connect(wsUrl(t))).rejects.toThrow();
    expect((await t.json('/')).body).toEqual({ router: true });
  });

  it('upgrades when the hook returns true and dispatches to its websocket handler', async () => {
    t = await bootstrap(RootModule, {
      configure: (_app, adapter) => serverOf(adapter).setUpgradeHook(upgrading()),
    });
    const ws = await connect(wsUrl(t));
    const reply = nextMessage(ws);
    ws.send('hi');
    expect(await reply).toBe('echo:hi');
    expect((await t.json('/')).body).toEqual({ router: true });
    ws.close();
  });

  it('answers with the Response the hook returns, and falls through on undefined', async () => {
    t = await bootstrap(RootModule, {
      configure: (_app, adapter) =>
        serverOf(adapter).setUpgradeHook({
          fetch: (req) =>
            new URL(req.url).pathname === '/denied'
              ? new Response('denied', { status: 403 })
              : undefined,
          websocket: echo,
        }),
    });
    await expect(connect(wsUrl(t, '/denied'))).rejects.toThrow();
    // undefined: the router answers (a plain GET without Upgrade never reaches the hook).
    await expect(connect(wsUrl(t, '/'))).rejects.toThrow();
    expect((await t.json('/')).body).toEqual({ router: true });
  });

  it('with path, sends every request on that pathname to the hook, Upgrade or not', async () => {
    t = await bootstrap(RootModule, {
      configure: (_app, adapter) =>
        serverOf(adapter).setUpgradeHook(
          upgrading({
            path: '/hooked',
            fetch: (req, server) =>
              req.headers.get('upgrade') ? (server.upgrade(req), true) : new Response('polling'),
          }),
        ),
    });
    expect(await (await t.fetch('/hooked')).text()).toBe('polling');
    expect((await t.json('/')).body).toEqual({ router: true });
    const ws = await connect(wsUrl(t, '/hooked'));
    const reply = nextMessage(ws);
    ws.send('x');
    expect(await reply).toBe('echo:x');
    ws.close();
  });

  it('works over a unix socket', async () => {
    const socketPath = join(await mkdtemp(join(tmpdir(), 'nestbun-ws-')), 'app.sock');
    const adapter = new BunAdapter();
    const app = await NestFactory.create<NestBunApplication>(RootModule, adapter, {
      logger: false,
    });
    serverOf(adapter).setUpgradeHook(upgrading());
    await app.listen(socketPath);
    try {
      const ws = await connect(`ws+unix://${socketPath}`);
      const reply = nextMessage(ws);
      ws.send('unix');
      expect(await reply).toBe('echo:unix');
      ws.close();
    } finally {
      await app.close();
    }
  });

  it('rejects a second hook and a hook set after listen, but allows clearing it', async () => {
    t = await bootstrap(RootModule, {
      configure: (_app, adapter) => serverOf(adapter).setUpgradeHook(upgrading()),
    });
    const server = serverOf(t.adapter);
    expect(() => server.setUpgradeHook(upgrading())).toThrow('already registered');

    const ws = await connect(wsUrl(t));
    server.setUpgradeHook(null);
    expect(() => server.setUpgradeHook(upgrading())).toThrow('before listen()');

    // The open socket keeps its handler; new upgrades now reach the router.
    const reply = nextMessage(ws);
    ws.send('still');
    expect(await reply).toBe('echo:still');
    await expect(connect(wsUrl(t))).rejects.toThrow();
    ws.close();
  });

  it('closes open sockets with 1001 on a graceful app.close()', async () => {
    t = await bootstrap(RootModule, {
      configure: (_app, adapter) => serverOf(adapter).setUpgradeHook(upgrading()),
    });
    const ws = await connect(wsUrl(t));
    const code = closed(ws);
    await t.close();
    t = undefined;
    expect(await code).toBe(1001);
  });

  it('does not wait for sockets with forceCloseConnections', async () => {
    t = await bootstrap(RootModule, {
      app: { forceCloseConnections: true },
      adapter: { serve: { shutdownTimeout: 5_000 } },
      configure: (_app, adapter) => serverOf(adapter).setUpgradeHook(upgrading()),
    });
    const ws = await connect(wsUrl(t));
    const code = closed(ws);
    const started = Date.now();
    await t.close();
    t = undefined;
    expect(Date.now() - started).toBeLessThan(1_000);
    // The client hears about it a tick later; 1001 is not guaranteed when stopping at once.
    expect([1001, 1006]).toContain(await code);
  });

  it('refuses new upgrades while a graceful close drains', async () => {
    t = await bootstrap(RootModule, {
      configure: (_app, adapter) => serverOf(adapter).setUpgradeHook(upgrading()),
    });
    const slow = t.fetch('/slow');
    await Bun.sleep(20);
    const closing = t.close();
    await expect(connect(wsUrl(t))).rejects.toThrow();
    expect((await (await slow).json()) as unknown).toEqual({ slow: true });
    await closing;
    t = undefined;
  });

  it('closes a socket that an async hook upgrades after shutdown began', async () => {
    t = await bootstrap(RootModule, {
      adapter: { serve: { shutdownTimeout: 5_000 } },
      configure: (_app, adapter) =>
        serverOf(adapter).setUpgradeHook(
          upgrading({
            fetch: async (req, server) => {
              await Bun.sleep(150);
              return server.upgrade(req) ? true : new Response('late', { status: 400 });
            },
          }),
        ),
    });
    const ws = new WebSocket(wsUrl(t));
    const code = closed(ws);
    await Bun.sleep(30); // the hook is now sleeping inside fetch
    const started = Date.now();
    await t.close();
    t = undefined;
    // Without the late close the drain would wait out the whole 5 s shutdownTimeout.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect([1001, 1006]).toContain(await code);
  });
});
