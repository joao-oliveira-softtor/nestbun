import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BunAdapter, type BunAdapterOptions, type NestBunApplication } from '@nestbun/platform';
import { createRequire } from 'node:module';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import { BunIoAdapter, type BunIoAdapterOptions } from '../src/index.js';

/**
 * `@nestjs/websockets` as `@nestjs/core` sees it. Bun's isolated linker installs two copies of
 * it (a peer cycle with core), and only core's copy makes `WsException` reach the client with
 * its message; apps fix that with `linker = "hoisted"`, see the package README.
 */
export const coreWebsockets = createRequire(Bun.resolveSync('@nestjs/core', import.meta.dir))(
  '@nestjs/websockets',
) as typeof import('@nestjs/websockets');

export interface IoTestApp {
  app: NestBunApplication;
  url: string;
  close: () => Promise<void>;
}

export async function bootstrapIo(
  module: Type<unknown>,
  adapterOptions: BunIoAdapterOptions = {},
  platformOptions: BunAdapterOptions = {},
): Promise<IoTestApp> {
  const app = await NestFactory.create<NestBunApplication>(
    module,
    new BunAdapter(platformOptions),
    {
      logger: false,
    },
  );
  app.useWebSocketAdapter(new BunIoAdapter(app, adapterOptions));
  await app.listen(0);
  return { app, url: await app.getUrl(), close: () => app.close() };
}

/** Resolves with the connected socket, or rejects with the `connect_error`. No reconnection. */
export function connect(
  url: string,
  options: Partial<ManagerOptions & SocketOptions> = {},
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, { reconnection: false, forceNew: true, ...options });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => {
      socket.close();
      reject(err);
    });
  });
}

/** Resolves with the first argument of the next `event`. */
export const next = (socket: Socket, event: string): Promise<any> =>
  new Promise((resolve) => socket.once(event, resolve));

/** Polls `condition` for up to 250 ms; server-side callbacks run a tick after the client sees it. */
export async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (condition()) return;
    await Bun.sleep(5);
  }
}
