import {
  Body,
  Controller,
  Get,
  Ip,
  Module,
  Post,
  VERSION_NEUTRAL,
  VersioningType,
} from '@nestjs/common';
import { afterEach, describe, expect, test } from 'bun:test';
import { bootstrap, jsonInit, type TestApp } from './helpers.js';

@Controller({ path: 'items', version: '1' })
class ItemsV1Controller {
  @Get()
  list() {
    return { v: 1 };
  }
}

@Controller({ path: 'health', version: VERSION_NEUTRAL })
class HealthController {
  @Get()
  ok() {
    return { ok: true };
  }
}

@Controller('card')
class CardController {
  @Post('tokenize')
  tokenize(@Ip() ip: string, @Body() body: { data: string }) {
    return { ip, size: body.data.length };
  }
}

@Module({ controllers: [ItemsV1Controller, HealthController, CardController] })
class AppModule {}

const TEN_MIB = 10 * 1024 * 1024;

describe('adapter options combined as in a production app', () => {
  let app: TestApp;
  afterEach(() => app?.close());

  test('URI versioning under a global prefix: versioned, VERSION_NEUTRAL and unknown version', async () => {
    app = await bootstrap(AppModule, {
      configure: (a) => {
        a.setGlobalPrefix('api');
        a.enableVersioning({ type: VersioningType.URI });
      },
    });
    expect((await app.json('/api/v1/items')).body).toEqual({ v: 1 });
    expect((await app.json('/api/health')).body).toEqual({ ok: true });
    expect((await app.json('/api/v9/items')).status).toBe(404);
    expect((await app.json('/api/items')).status).toBe(404);
    expect((await app.json('/v1/items')).status).toBe(404);
  });

  test('@Ip() returns the first X-Forwarded-For hop with trustProxy', async () => {
    app = await bootstrap(AppModule, { adapter: { trustProxy: true } });
    const res = await app.json<{ ip: string }>(
      '/card/tokenize',
      jsonInit('POST', { data: 'x' }, { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }),
    );
    expect(res.body.ip).toBe('203.0.113.7');
  });

  test('@Ip() ignores a forged X-Forwarded-For without trustProxy', async () => {
    app = await bootstrap(AppModule);
    const res = await app.json<{ ip: string }>(
      '/card/tokenize',
      jsonInit('POST', { data: 'x' }, { 'x-forwarded-for': '203.0.113.7' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.ip).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
  });

  test('bodyLimit and serve.maxRequestBodySize at 10 MiB: under passes, over answers 413', async () => {
    app = await bootstrap(AppModule, {
      adapter: { bodyLimit: TEN_MIB, serve: { maxRequestBodySize: TEN_MIB } },
    });
    const under = await app.json<{ size: number }>(
      '/card/tokenize',
      jsonInit('POST', { data: 'x'.repeat(TEN_MIB - 1024) }),
    );
    expect(under.status).toBe(201);
    expect(under.body.size).toBe(TEN_MIB - 1024);

    const over = await app.fetch(
      '/card/tokenize',
      jsonInit('POST', { data: 'x'.repeat(TEN_MIB + 1024) }),
    );
    expect(over.status).toBe(413);
  });
});
