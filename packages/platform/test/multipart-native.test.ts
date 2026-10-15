import { Controller, Module, Post, Req } from '@nestjs/common';
import { afterEach, describe, expect, test } from 'bun:test';
import { bootstrap, type TestApp } from './helpers.js';

let calls = 0;

@Controller()
class UploadController {
  @Post('upload')
  async upload(@Req() req: { native: Request }) {
    calls++;
    const form = await req.native.formData();
    const file = form.get('file') as File;
    return {
      name: file.name,
      type: file.type,
      size: file.size,
      text: await file.text(),
      note: form.get('note'),
    };
  }
}

@Module({ controllers: [UploadController] })
class UploadModule {}

function multipart(content: string) {
  const form = new FormData();
  form.append('file', new File([content], 'a.txt', { type: 'text/plain' }));
  form.append('note', 'olá');
  return { method: 'POST', body: form } satisfies RequestInit;
}

describe('multipart via req.native.formData()', () => {
  let app: TestApp;
  afterEach(() => app?.close());

  test('entrega arquivo e campos intactos', async () => {
    app = await bootstrap(UploadModule);
    const res = await app.json<Record<string, unknown>>('/upload', multipart('hello'));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      name: 'a.txt',
      // o Bun normaliza para "text/plain;charset=utf-8"
      type: expect.stringMatching(/^text\/plain/),
      size: 5,
      text: 'hello',
      note: 'olá',
    });
  });

  test('corpo acima de serve.maxRequestBodySize volta 413 sem o handler rodar', async () => {
    app = await bootstrap(UploadModule, { adapter: { serve: { maxRequestBodySize: 1024 } } });
    const before = calls;
    const res = await app.fetch('/upload', multipart('x'.repeat(4096)));
    expect(res.status).toBe(413);
    expect(calls).toBe(before);
  });
});
