import { Controller, Get, Module, Req } from '@nestjs/common';
import { afterEach, describe, expect, test } from 'bun:test';
import { bootstrap, type TestApp } from './helpers.js';

type Echo = { ip?: string; ips: string[]; protocol: string; host: string };

@Controller()
class IpController {
  @Get('ip')
  ip(@Req() req: Echo): Echo {
    return { ip: req.ip, ips: req.ips, protocol: req.protocol, host: req.host };
  }
}

@Module({ controllers: [IpController] })
class IpModule {}

const forwarded = {
  'x-forwarded-for': '203.0.113.7',
  'x-forwarded-proto': 'https, http',
  'x-forwarded-host': 'api.example.com, proxy.local',
};

describe('trustProxy', () => {
  let app: TestApp;
  afterEach(() => app?.close());

  test('com trustProxy, lê o primeiro salto de x-forwarded-for e lista todos', async () => {
    app = await bootstrap(IpModule, { adapter: { trustProxy: true } });
    const res = await app.json<Echo>('/ip', {
      headers: { 'x-forwarded-for': '203.0.113.7,  10.0.0.1 ,10.0.0.2' },
    });
    expect(res.body.ip).toBe('203.0.113.7');
    expect(res.body.ips).toEqual(['203.0.113.7', '10.0.0.1', '10.0.0.2']);
  });

  test('com trustProxy e x-forwarded-for vazio, cai no endereço do socket', async () => {
    app = await bootstrap(IpModule, { adapter: { trustProxy: true } });
    const res = await app.json<Echo>('/ip', { headers: { 'x-forwarded-for': '' } });
    expect(res.body.ips).toEqual([]);
    expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/);
  });

  test('com trustProxy, req.protocol e req.host vêm do primeiro valor de X-Forwarded-*', async () => {
    app = await bootstrap(IpModule, { adapter: { trustProxy: true } });
    const res = await app.json<Echo>('/ip', { headers: forwarded });
    expect(res.body.protocol).toBe('https');
    expect(res.body.host).toBe('api.example.com');
  });

  test('sem trustProxy, ignora x-forwarded-for (não deixa o cliente forjar o IP)', async () => {
    app = await bootstrap(IpModule);
    const res = await app.json<Echo>('/ip', { headers: forwarded });
    expect(res.body.ips).toEqual([]);
    expect(res.body.ip).not.toBe('203.0.113.7');
  });

  test('sem trustProxy, req.protocol e req.host vêm da conexão, não de X-Forwarded-*', async () => {
    app = await bootstrap(IpModule);
    const res = await app.json<Echo>('/ip', { headers: forwarded });
    expect(res.body.protocol).toBe('http');
    expect(res.body.host).toBe(new URL(app.url).host);
  });
});
