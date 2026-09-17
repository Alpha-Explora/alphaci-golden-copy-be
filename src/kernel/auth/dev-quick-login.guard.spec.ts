import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { DevQuickLoginGuard } from '#kernel/auth/dev-quick-login.guard';

function makeConfigService(nodeEnv: string, enabled: boolean): ConfigService {
  return {
    get: jest.fn((key: string) => {
      if (key === 'NODE_ENV') {
        return nodeEnv;
      }
      if (key === 'app') {
        return { auth: { devQuickLoginEnabled: enabled } };
      }
      return undefined;
    }),
  } as unknown as ConfigService;
}

function makeContext(request: Partial<Request>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function makeLocalRequest(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    headers: {
      host: 'localhost:4000',
      origin: 'http://localhost:3000',
    },
    socket: { remoteAddress: '::1' } as unknown as Request['socket'],
    ...overrides,
  };
}

describe('DevQuickLoginGuard', () => {
  it('is disabled by default even in development', () => {
    const guard = new DevQuickLoginGuard(
      makeConfigService('development', false),
    );

    expect(() => guard.canActivate(makeContext(makeLocalRequest()))).toThrow(
      NotFoundException,
    );
  });

  it('hides the endpoint in production even if the flag is misconfigured', () => {
    const guard = new DevQuickLoginGuard(makeConfigService('production', true));

    expect(() => guard.canActivate(makeContext(makeLocalRequest()))).toThrow(
      NotFoundException,
    );
  });

  it('allows an explicitly enabled loopback request', () => {
    const guard = new DevQuickLoginGuard(
      makeConfigService('development', true),
    );

    expect(guard.canActivate(makeContext(makeLocalRequest()))).toBe(true);
  });

  it('rejects non-loopback clients', () => {
    const guard = new DevQuickLoginGuard(
      makeConfigService('development', true),
    );

    const request = makeLocalRequest({
      socket: {
        remoteAddress: '192.168.1.25',
      } as unknown as Request['socket'],
    });

    expect(() => guard.canActivate(makeContext(request))).toThrow(
      NotFoundException,
    );
  });

  it('rejects non-loopback browser origins', () => {
    const guard = new DevQuickLoginGuard(
      makeConfigService('development', true),
    );

    const request = makeLocalRequest({
      headers: {
        host: 'localhost:4000',
        origin: 'https://evil.example.com',
      },
    });

    expect(() => guard.canActivate(makeContext(request))).toThrow(
      NotFoundException,
    );
  });
});
