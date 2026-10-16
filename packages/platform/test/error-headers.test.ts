import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  type ArgumentsHost,
  Catch,
  type CanActivate,
  Controller,
  type ExceptionFilter,
  type ExecutionContext,
  Get,
  HttpException,
  HttpStatus,
  Injectable,
  Module,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { bootstrap, type TestApp } from './helpers.js';

@Injectable()
class RateLimitGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const res = context.switchToHttp().getResponse();
    res.setHeader('Retry-After', '30');
    res.setHeader('Cache-Control', 'no-store');
    throw new HttpException('slow down', HttpStatus.TOO_MANY_REQUESTS);
  }
}

@Catch(HttpException)
class NoStoreFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    res.setHeader('Cache-Control', 'no-store');
    res.status(exception.getStatus()).json({ error: exception.message });
  }
}

@Controller('errors')
class ErrorsController {
  @UseGuards(RateLimitGuard)
  @Get('guard')
  guarded() {
    return { ok: true };
  }

  @UseFilters(NoStoreFilter)
  @Get('filter')
  filtered() {
    throw new HttpException('nope', HttpStatus.CONFLICT);
  }
}

@Module({ controllers: [ErrorsController], providers: [RateLimitGuard] })
class ErrorsModule {}

describe('headers on error responses', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await bootstrap(ErrorsModule);
  });
  afterAll(() => t.close());

  it('keeps headers set before an exception reaches the default filter', async () => {
    const res = await t.json('/errors/guard');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps headers set by a custom exception filter', async () => {
    const res = await t.json('/errors/filter');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'nope' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
