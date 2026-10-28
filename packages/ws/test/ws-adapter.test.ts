import { afterEach, beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { type CanActivate, Controller, Get, Module, UseGuards } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type WsResponse,
} from '@nestjs/websockets';
import { type Observable, of } from 'rxjs';
import type { BunWsClient, BunWsServer } from '../src/index.js';
import {
  bootstrapWs,
  closed,
  connect,
  coreWebsockets,
  nextMessage,
  request,
  until,
  type WsTestApp,
} from './helpers.js';

const tokens = new WeakMap<BunWsClient, string | null>();
// Token of every client that left. A global count would also catch sockets that earlier tests
// close in afterEach, which land inside the next test's window.
const disconnected: (string | null | undefined)[] = [];

class DenyGuard implements CanActivate {
  canActivate() {
    return false;
  }
}

@WebSocketGateway({ path: '/events' })
class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: BunWsServer;

  handleConnection(client: BunWsClient, upgrade: Request) {
    tokens.set(client, upgrade.headers.get('x-token'));
  }

  handleDisconnect(client: BunWsClient) {
    disconnected.push(tokens.get(client));
  }

  @SubscribeMessage('echo')
  echo(@MessageBody() data: unknown): WsResponse<unknown> {
    return { event: 'echo', data };
  }

  @SubscribeMessage('bigint')
  bigint() {
    return { event: 'bigint', data: 1n };
  }

  @SubscribeMessage('stream')
  stream(): Observable<WsResponse<number>> {
    return of({ event: 'stream', data: 1 }, { event: 'stream', data: 2 });
  }

  @SubscribeMessage('whoami')
  whoami(@ConnectedSocket() client: BunWsClient): WsResponse<string | null | undefined> {
    return { event: 'whoami', data: tokens.get(client) };
  }

  @SubscribeMessage('fail')
  fail() {
    throw new coreWebsockets.WsException('nope');
  }

  @UseGuards(DenyGuard)
  @SubscribeMessage('guarded')
  guarded() {
    return { event: 'guarded', data: 'never' };
  }

  @SubscribeMessage('join')
  join(@ConnectedSocket() client: BunWsClient, @MessageBody() room: string) {
    client.subscribe(room);
    return { event: 'joined', data: room };
  }

  @SubscribeMessage('shout')
  shout(@MessageBody() body: { room: string; text: string }) {
    this.server.publish(body.room, JSON.stringify({ event: 'shout', data: body.text }));
  }
}

@WebSocketGateway({ path: '/other' })
class OtherGateway {
  @SubscribeMessage('echo')
  echo(@MessageBody() data: unknown) {
    return { event: 'other', data };
  }

  @SubscribeMessage('join')
  join(@ConnectedSocket() client: BunWsClient, @MessageBody() room: string) {
    client.subscribe(room);
    return { event: 'joined', data: room };
  }
}

@WebSocketGateway()
class RootGateway {
  @SubscribeMessage('ping')
  ping() {
    return { event: 'pong', data: null };
  }
}

@Controller()
class HttpController {
  @Get('health')
  health() {
    return { ok: true };
  }
}

@Module({ controllers: [HttpController], providers: [EventsGateway, OtherGateway, RootGateway] })
class AppModule {}

describe('BunWsAdapter', () => {
  let t: WsTestApp;
  const open: WebSocket[] = [];
  const client = async (path: string, headers?: Record<string, string>) => {
    const ws = await connect(t.wsUrl(path), headers);
    open.push(ws);
    return ws;
  };

  beforeAll(async () => {
    t = await bootstrapWs(AppModule);
  });
  afterEach(() => {
    for (const ws of open.splice(0)) ws.close();
  });
  afterAll(() => t.close());

  it('answers { event, data } messages and keeps HTTP on the same port', async () => {
    const ws = await client('/events');
    expect(await request(ws, 'echo', { a: 1 })).toEqual({ event: 'echo', data: { a: 1 } });
    expect(await (await fetch(`${t.url}/health`)).json()).toEqual({ ok: true });
  });

  it('sends every value of an Observable', async () => {
    const ws = await client('/events');
    const replies: unknown[] = [];
    const both = new Promise<void>((resolve) => {
      ws.addEventListener('message', (e) => {
        replies.push(JSON.parse(String(e.data)));
        if (replies.length === 2) resolve();
      });
    });
    ws.send(JSON.stringify({ event: 'stream' }));
    await both;
    expect(replies).toEqual([
      { event: 'stream', data: 1 },
      { event: 'stream', data: 2 },
    ]);
  });

  it('ignores invalid JSON and unknown events, and the socket keeps working', async () => {
    const ws = await client('/events');
    ws.send('not json');
    ws.send(JSON.stringify({ event: 'nope', data: 1 }));
    expect(await request(ws, 'echo', 'still')).toEqual({ event: 'echo', data: 'still' });
  });

  it('drops a reply that cannot be serialized and keeps the socket working', async () => {
    const ws = await client('/events');
    ws.send(JSON.stringify({ event: 'bigint' }));
    expect(await request(ws, 'echo', 'after')).toEqual({ event: 'echo', data: 'after' });
  });

  it('routes by path: each gateway gets its own clients', async () => {
    const ws = await client('/other');
    expect(await request(ws, 'echo', 'x')).toEqual({ event: 'other', data: 'x' });
  });

  it('serves a gateway without a path on /', async () => {
    const ws = await client('/');
    expect(await request(ws, 'ping')).toEqual({ event: 'pong', data: null });
  });

  it('lets the router answer an upgrade on a path without a gateway', async () => {
    await expect(connect(t.wsUrl('/missing'))).rejects.toThrow();
    expect((await fetch(`${t.url}/missing`)).status).toBe(404);
  });

  it('passes the upgrade Request to handleConnection', async () => {
    const ws = await client('/events', { 'x-token': 'abc' });
    expect(await request(ws, 'whoami')).toEqual({ event: 'whoami', data: 'abc' });
  });

  it('calls handleDisconnect when a client leaves', async () => {
    const ws = await client('/events', { 'x-token': 'leaving' });
    const done = closed(ws);
    ws.close();
    await done;
    await until(() => disconnected.includes('leaving'));
    expect(disconnected.filter((token) => token === 'leaving')).toHaveLength(1);
  });

  it("sends a WsException's message to the client", async () => {
    const ws = await client('/events');
    expect(await request(ws, 'fail')).toEqual({
      event: 'exception',
      data: { status: 'error', message: 'nope', cause: { pattern: 'fail' } },
    });
  });

  it('runs guards on messages', async () => {
    const ws = await client('/events');
    expect(await request(ws, 'guarded')).toEqual({
      event: 'exception',
      data: { status: 'error', message: 'Forbidden resource', cause: { pattern: 'guarded' } },
    });
  });

  it('publishes to subscribed clients; topics are shared by every gateway', async () => {
    const listener = await client('/events');
    const sender = await client('/events');
    const elsewhere = await client('/other');
    await request(listener, 'join', 'room-1');
    await request(elsewhere, 'join', 'room-1');

    const heard = nextMessage(listener);
    const leaked = nextMessage(elsewhere);
    sender.send(JSON.stringify({ event: 'shout', data: { room: 'room-1', text: 'hi' } }));
    expect(await heard).toEqual({ event: 'shout', data: 'hi' });
    // Documented: Bun's topics belong to the server, not to a gateway.
    expect(await leaked).toEqual({ event: 'shout', data: 'hi' });
  });
});

describe('BunWsAdapter options and lifecycle', () => {
  it('uses a custom messageParser', async () => {
    const t = await bootstrapWs(AppModule, {
      messageParser: (raw) => {
        const [event = '', data] = String(raw).split(':');
        return { event, data };
      },
    });
    try {
      const ws = await connect(t.wsUrl('/events'));
      const reply = nextMessage(ws);
      ws.send('echo:hi');
      expect(await reply).toEqual({ event: 'echo', data: 'hi' });
      ws.close();
    } finally {
      await t.close();
    }
  });

  it('closes clients with 1001 on app.close()', async () => {
    const t = await bootstrapWs(AppModule);
    const ws = await connect(t.wsUrl('/events'));
    const code = closed(ws);
    await t.close();
    expect(await code).toBe(1001);
  });

  it('rejects a gateway on its own port and namespaces', async () => {
    @WebSocketGateway(4000)
    class PortGateway {}
    @Module({ providers: [PortGateway] })
    class PortModule {}
    await expect(bootstrapWs(PortModule)).rejects.toThrow('remove the port (4000)');

    @WebSocketGateway({ namespace: 'chat' })
    class NamespaceGateway {}
    @Module({ providers: [NamespaceGateway] })
    class NamespaceModule {}
    await expect(bootstrapWs(NamespaceModule)).rejects.toThrow('does not support namespaces');
  });
});
