import { afterEach, describe, expect, it } from 'bun:test';
import { Module, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BunAdapter, type NestBunApplication } from '@nestbun/platform';
import {
  MessageBody,
  type OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { io } from 'socket.io-client';
import { BunIoAdapter } from '../src/index.js';
import { bootstrapIo, connect, until, type IoTestApp } from './helpers.js';

const gatewayModule = (...gateways: Type<unknown>[]) => {
  @Module({ providers: gateways })
  class TestModule {}
  return TestModule;
};

let t: IoTestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('BunIoAdapter options', () => {
  it('lets the gateway cors override the base engine options, and applies editResponseHeaders', async () => {
    @WebSocketGateway({ cors: { origin: true } })
    class G {}
    t = await bootstrapIo(gatewayModule(G), {
      engine: {
        cors: { origin: 'https://base.example' },
        editResponseHeaders: (headers) => headers.set('x-edited', 'yes'),
      },
    });
    const res = await fetch(`${t.url}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: 'https://app.example.com' },
    });
    // 'https://base.example' would be echoed back if the base won.
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(res.headers.get('x-edited')).toBe('yes');
  });

  it('serves a custom path, always with the trailing slash that engine.io-client sends', async () => {
    @WebSocketGateway({ path: '/ws' })
    class G {
      @SubscribeMessage('echo')
      echo(@MessageBody() data: unknown) {
        return data;
      }
    }
    t = await bootstrapIo(gatewayModule(G));
    const socket = io(t.url, { path: '/ws', transports: ['websocket'], reconnection: false });
    expect(await socket.emitWithAck('echo', 1)).toBe(1);
    socket.close();
    expect((await fetch(`${t.url}/ws/?EIO=4&transport=polling`)).status).toBe(200);
    expect((await fetch(`${t.url}/ws?EIO=4&transport=polling`)).status).toBe(404);
  });

  it('shares one server between a gateway with no path and one on "/socket.io"', async () => {
    @WebSocketGateway({ namespace: 'a' })
    class A {
      @SubscribeMessage('who')
      who() {
        return 'a';
      }
    }
    @WebSocketGateway({ namespace: 'b', path: '/socket.io' })
    class B {
      @SubscribeMessage('who')
      who() {
        return 'b';
      }
    }
    t = await bootstrapIo(gatewayModule(A, B));
    const a = await connect(`${t.url}/a`, { transports: ['websocket'] });
    const b = await connect(`${t.url}/b`, { transports: ['websocket'] });
    expect(await a.emitWithAck('who')).toBe('a');
    expect(await b.emitWithAck('who')).toBe('b');
    a.close();
    b.close();
  });

  it('disconnects clients with "server shutting down" on close, even with forceCloseConnections', async () => {
    const reasons: string[] = [];
    @WebSocketGateway()
    class G implements OnGatewayConnection {
      handleConnection(client: Socket) {
        client.on('disconnect', (reason) => reasons.push(reason));
      }
    }
    const app = await NestFactory.create<NestBunApplication>(gatewayModule(G), new BunAdapter(), {
      logger: false,
      forceCloseConnections: true,
    });
    app.useWebSocketAdapter(new BunIoAdapter(app));
    await app.listen(0);
    const socket = await connect(await app.getUrl(), { transports: ['websocket'] });
    await app.close();
    await until(() => reasons.length > 0);
    expect(reasons).toEqual(['server shutting down']);
    socket.close();
  });

  it('answers * for a falsy cors origin and does not serve the client bundle', async () => {
    @WebSocketGateway({ cors: { origin: false } })
    class G {}
    t = await bootstrapIo(gatewayModule(G));
    const res = await fetch(`${t.url}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: 'https://app.example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((await fetch(`${t.url}/socket.io/socket.io.js`)).status).toBe(404);
  });
});

describe('BunIoAdapter errors', () => {
  it('fails to start when another upgrade hook is already registered', async () => {
    @WebSocketGateway()
    class G {}
    const app = await NestFactory.create<NestBunApplication>(gatewayModule(G), new BunAdapter(), {
      logger: false,
    });
    (app.getHttpServer() as { setUpgradeHook(hook: unknown): void }).setUpgradeHook({
      fetch: () => undefined,
      websocket: { message() {} },
    });
    app.useWebSocketAdapter(new BunIoAdapter(app));
    await expect(app.listen(0)).rejects.toThrow('already registered');
  });
  it('rejects a port, a second path, allowRequest and a function cors.origin', async () => {
    @WebSocketGateway(4000)
    class Port {}
    await expect(bootstrapIo(gatewayModule(Port))).rejects.toThrow('remove the port (4000)');

    @WebSocketGateway({ path: '/a' })
    class A {}
    @WebSocketGateway({ path: '/b' })
    class B {}
    // Nest decides which gateway registers first; both paths are named either way.
    await expect(bootstrapIo(gatewayModule(A, B))).rejects.toThrow(
      /one Socket\.IO path per app: "\/[ab]\/" is taken, "\/[ab]\/" was requested/,
    );

    @WebSocketGateway({ allowRequest: () => undefined } as never)
    class Allow {}
    await expect(bootstrapIo(gatewayModule(Allow))).rejects.toThrow('"allowRequest"');

    @WebSocketGateway({ cors: { origin: () => true } } as never)
    class FnOrigin {}
    await expect(bootstrapIo(gatewayModule(FnOrigin))).rejects.toThrow('cors.origin');
  });

  it('rejects unsupported base engine options when constructed', () => {
    expect(() => new BunIoAdapter({}, { engine: { allowRequest: async () => {} } })).toThrow(
      '"allowRequest"',
    );
    expect(
      () => new BunIoAdapter({}, { engine: { cors: { origin: (() => true) as never } } }),
    ).toThrow('cors.origin');
  });

  it('requires BunAdapter as the HTTP adapter', () => {
    expect(() => new BunIoAdapter({}).createIOServer(0)).toThrow('requires BunAdapter');
  });
});
