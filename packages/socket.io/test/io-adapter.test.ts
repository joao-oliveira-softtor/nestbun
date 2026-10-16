import { afterEach, describe, expect, it } from 'bun:test';
import { Controller, Get, Module } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Server, Socket } from 'socket.io';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { bootstrapIo, connect, coreWebsockets, next, until, type IoTestApp } from './helpers.js';

const CORS = { origin: true, credentials: true };

@WebSocketGateway({ cors: CORS })
class RootGateway implements OnGatewayConnection {
  @WebSocketServer() server!: Server;

  handleConnection(client: Socket) {
    client.emit('hello', {
      auth: client.handshake.auth,
      header: client.handshake.headers['x-test'],
      address: client.handshake.address,
      transport: client.conn.transport.name,
    });
  }

  @SubscribeMessage('echo')
  echo(@MessageBody() data: unknown) {
    return data;
  }

  @SubscribeMessage('join')
  join(@ConnectedSocket() client: Socket, @MessageBody() room: string) {
    client.join(room);
    return { joined: room };
  }

  @SubscribeMessage('shout')
  shout(@MessageBody() body: { room: string; text: string }) {
    this.server.to(body.room).emit('shout', body.text);
  }
}

@WebSocketGateway({ namespace: 'chat', cors: CORS })
class ChatGateway {
  @SubscribeMessage('echo')
  echo(@MessageBody() data: unknown) {
    return { chat: data };
  }
}

let engineAtInit: unknown;

@WebSocketGateway({ namespace: 'secure', cors: CORS })
class SecureGateway implements OnGatewayConnection {
  afterInit(namespace: Namespace) {
    namespace.use((socket, done) =>
      socket.handshake.auth.token === 'ok' ? done() : done(new Error('denied')),
    );
    // The crm hooks the engine's 'headers' event here; bun-engine never emits it, but it must exist.
    engineAtInit = namespace.server.engine;
    namespace.server.engine.on('headers', () => {});
  }

  handleConnection(client: Socket) {
    client.use(([event], done) => (event === 'blocked' ? done(new Error('blocked')) : done()));
  }

  @SubscribeMessage('blocked')
  blocked() {
    return 'reached';
  }

  @SubscribeMessage('open')
  open() {
    return 'reached';
  }

  @SubscribeMessage('fail')
  fail() {
    throw new coreWebsockets.WsException('nope');
  }
}

@Controller('health')
class HealthController {
  @Get()
  health() {
    return { ok: true };
  }
}

@Module({ controllers: [HealthController], providers: [RootGateway, ChatGateway, SecureGateway] })
class AppModule {}

let t: IoTestApp;
const sockets: ClientSocket[] = [];
const open = async (...args: Parameters<typeof connect>) => {
  const socket = await connect(...args);
  sockets.push(socket);
  return socket;
};

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await t?.close();
});

describe('BunIoAdapter', () => {
  it('acks an event over websocket, over polling and across the polling → websocket upgrade', async () => {
    t = await bootstrapIo(AppModule);

    const ws = await open(t.url, { transports: ['websocket'] });
    expect(await ws.emitWithAck('echo', 'a')).toBe('a');

    const polling = await open(t.url, { transports: ['polling'] });
    expect(await polling.emitWithAck('echo', 'b')).toBe('b');
    expect(polling.io.engine.transport.name).toBe('polling');

    const upgrading = await open(t.url, { transports: ['polling', 'websocket'] });
    await until(() => upgrading.io.engine.transport.name === 'websocket');
    expect(upgrading.io.engine.transport.name).toBe('websocket');
    expect(await upgrading.emitWithAck('echo', 'c')).toBe('c');
  });

  it('serves namespaces and rooms from one engine', async () => {
    t = await bootstrapIo(AppModule);
    const root = await open(t.url, { transports: ['websocket'] });
    const chat = await open(`${t.url}/chat`, { transports: ['websocket'] });
    expect(await chat.emitWithAck('echo', 'x')).toEqual({ chat: 'x' });

    const other = await open(t.url, { transports: ['websocket'] });
    await root.emitWithAck('join', 'r1');
    const heard = next(root, 'shout');
    other.emit('shout', { room: 'r1', text: 'hi' });
    expect(await heard).toBe('hi');
  });

  for (const transport of ['websocket', 'polling'] as const) {
    it(`exposes the handshake auth, headers and peer address over ${transport}`, async () => {
      t = await bootstrapIo(AppModule, {}, { trustProxy: true });
      // The gateway emits 'hello' on connect: listen before connecting.
      const socket = io(t.url, {
        reconnection: false,
        forceNew: true,
        transports: [transport],
        auth: { token: 'tkn' },
        extraHeaders: { 'x-test': 'yes', 'x-forwarded-for': '203.0.113.9' },
      });
      sockets.push(socket);
      const data = await next(socket, 'hello');
      expect(data.auth).toEqual({ token: 'tkn' });
      expect(data.header).toBe('yes');
      expect(data.transport).toBe(transport);
      // The raw peer, not x-forwarded-for: the gateway reads that header itself.
      expect(data.address).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
    });
  }

  it('reflects the gateway cors on a polling handshake', async () => {
    t = await bootstrapIo(AppModule);
    const res = await fetch(`${t.url}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: 'https://app.example.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('answers the path with a trailing slash only, as engine.io-client asks for it', async () => {
    t = await bootstrapIo(AppModule);
    expect((await fetch(`${t.url}/socket.io/?EIO=4&transport=polling`)).status).toBe(200);
    expect((await fetch(`${t.url}/socket.io?EIO=4&transport=polling`)).status).toBe(404);
  });

  it('closes quickly with a long-polling client connected', async () => {
    t = await bootstrapIo(AppModule);
    const polling = await open(t.url, { transports: ['polling'] });
    expect(polling.connected).toBe(true);
    const started = performance.now();
    await t.close();
    expect(performance.now() - started).toBeLessThan(3000);
    t = undefined as never;
  });

  it('rejects a connection in a namespace middleware and runs per-socket middleware', async () => {
    t = await bootstrapIo(AppModule);
    await expect(connect(`${t.url}/secure`, { transports: ['websocket'] })).rejects.toThrow(
      'denied',
    );

    const socket = await open(`${t.url}/secure`, {
      transports: ['websocket'],
      auth: { token: 'ok' },
    });
    expect(await socket.emitWithAck('open')).toBe('reached');
    // The middleware swallows the event: no handler, no ack.
    await expect(socket.timeout(300).emitWithAck('blocked')).rejects.toThrow();
  });

  it('exposes the engine to afterInit and accepts its "headers" listener', async () => {
    t = await bootstrapIo(AppModule);
    expect(engineAtInit).toBeDefined();
  });

  it('delivers a WsException from a handler as an "exception" event', async () => {
    t = await bootstrapIo(AppModule);
    const socket = await open(`${t.url}/secure`, {
      transports: ['websocket'],
      auth: { token: 'ok' },
    });
    const exception = next(socket, 'exception');
    socket.emit('fail');
    // The exact message proves the filter recognised the WsException (one copy of @nestjs/websockets).
    expect(await exception).toMatchObject({ message: 'nope' });
  });

  it('keeps serving plain HTTP routes on the same port', async () => {
    t = await bootstrapIo(AppModule);
    const res = await fetch(`${t.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
