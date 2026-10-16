import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BunAdapter, type NestBunApplication } from '@nestbun/platform';
import { createRequire } from 'node:module';
import { BunWsAdapter, type BunWsAdapterOptions } from '../src/index.js';

/**
 * `@nestjs/websockets` as `@nestjs/core` sees it. Bun's isolated linker installs two copies of
 * it (a peer cycle with core), and only core's copy makes `WsException` reach the client with
 * its message; apps fix that with `linker = "hoisted"`, see the package README.
 */
export const coreWebsockets = createRequire(Bun.resolveSync('@nestjs/core', import.meta.dir))(
  '@nestjs/websockets',
) as typeof import('@nestjs/websockets');

export interface WsTestApp {
  app: NestBunApplication;
  url: string;
  wsUrl: (path?: string) => string;
  close: () => Promise<void>;
}

export async function bootstrapWs(
  module: Type<unknown>,
  options: BunWsAdapterOptions = {},
): Promise<WsTestApp> {
  const app = await NestFactory.create<NestBunApplication>(module, new BunAdapter(), {
    logger: false,
  });
  app.useWebSocketAdapter(new BunWsAdapter(app, options));
  await app.listen(0);
  const url = await app.getUrl();
  return {
    app,
    url,
    wsUrl: (path = '/') => url.replace(/^http/, 'ws') + path,
    close: () => app.close(),
  };
}

/** Resolves with the open socket, or rejects if it closes or errors before opening. */
export function connect(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, headers ? ({ headers } as never) : undefined);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
    ws.addEventListener('close', (e) => reject(new Error(`closed before open (${e.code})`)), {
      once: true,
    });
  });
}

// `any` (not a generic) so replies can go straight into `toEqual(...)`.
export const nextMessage = (ws: WebSocket): Promise<any> =>
  new Promise((resolve) => {
    ws.addEventListener('message', (e) => resolve(JSON.parse(String(e.data))), { once: true });
  });

export const closed = (ws: WebSocket) =>
  new Promise<number>((resolve) => {
    ws.addEventListener('close', (e) => resolve(e.code), { once: true });
  });

/** Sends an `{ event, data }` frame and waits for the next reply. */
export async function request(ws: WebSocket, event: string, data?: unknown): Promise<any> {
  const reply = nextMessage(ws);
  ws.send(JSON.stringify({ event, data }));
  return reply;
}

/** Polls `condition` for up to 250 ms; server-side callbacks run a tick after the client sees it. */
export async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (condition()) return;
    await Bun.sleep(5);
  }
}
