import { Controller, Get, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { NextFunction, Request, Response } from 'express';
import type { Express } from 'express-serve-static-core';
import type { Server } from 'http';

import {
  SESSION_USER_LOOKUP,
  type SessionUserLookup,
} from '#kernel/auth/session-user-lookup.contract.js';
import { CapabilityGuard } from '#kernel/composition/capability.guard.js';
import { CAPABILITY_RESOLVER } from '#kernel/composition/capability-resolver.port.js';
import { RequiresCapability } from '#kernel/composition/requires-capability.decorator.js';
import { SessionAuthGuard } from '#kernel/auth/session-auth.guard.js';
import {
  SUBSCRIPTION_ACCESS,
  type SubscriptionAccessPort,
} from '#kernel/auth/subscription-access.port.js';
import { SubscriptionGuard } from '#kernel/auth/subscription.guard.js';
import { DeploymentTargetsController } from './deployment-targets.controller.js';
import { EnvVarsController } from './env-vars.controller.js';
import { ProviderConnectionsController } from './provider-connections.controller.js';
import { CustomDomainsController } from './custom-domains.controller.js';

@Controller('guard-order-test')
@RequiresCapability('runtime.env-provisioning')
@UseGuards(SessionAuthGuard, CapabilityGuard, SubscriptionGuard)
class GuardOrderTestController {
  @Get()
  get() {
    return { ok: true };
  }
}

describe('runtime capability guard order', () => {
  it('runs authentication, capability composition, then subscription entitlement', () => {
    for (const controller of [
      DeploymentTargetsController,
      ProviderConnectionsController,
      EnvVarsController,
      CustomDomainsController,
    ]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([
        SessionAuthGuard,
        CapabilityGuard,
        SubscriptionGuard,
      ]);
    }
  });

  it('returns 404 before subscription lookup when composition is absent', async () => {
    const capabilityResolver = {
      for: jest.fn().mockReturnValue(new Set()),
      deployment: jest.fn(),
    };
    const subscriptionAccess = {
      getForUser: jest.fn(),
    } satisfies SubscriptionAccessPort;
    const module = await Test.createTestingModule({
      controllers: [GuardOrderTestController],
      providers: [
        Reflector,
        SessionAuthGuard,
        CapabilityGuard,
        SubscriptionGuard,
        {
          provide: SESSION_USER_LOOKUP,
          useValue: { findSessionUser: jest.fn() } satisfies SessionUserLookup,
        },
        {
          provide: CAPABILITY_RESOLVER,
          useValue: capabilityResolver,
        },
        {
          provide: SUBSCRIPTION_ACCESS,
          useValue: subscriptionAccess,
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    const expressApp = app.getHttpAdapter().getInstance() as Express;
    expressApp.use((req: Request, _res: Response, next: NextFunction) => {
      req.session = {
        user: {
          id: 'user-1',
          login: 'user-1',
          onboardingCompleted: true,
          isInternal: false,
        },
        tenantId: 'tenant-1',
      } as never;
      next();
    });
    await app.init();

    try {
      const response = await request(app.getHttpServer() as Server).get(
        '/guard-order-test',
      );

      expect(response.status).toBe(404);
      expect(capabilityResolver.for).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
      });
      expect(subscriptionAccess.getForUser).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('preserves Billing response when composition is present', async () => {
    const capabilityResolver = {
      for: jest.fn().mockReturnValue(new Set(['runtime.env-provisioning'])),
      deployment: jest.fn(),
    };
    const subscriptionAccess = {
      getForUser: jest.fn().mockResolvedValue({ status: 'inactive' }),
    } satisfies SubscriptionAccessPort;
    const module = await Test.createTestingModule({
      controllers: [GuardOrderTestController],
      providers: [
        Reflector,
        SessionAuthGuard,
        CapabilityGuard,
        SubscriptionGuard,
        {
          provide: SESSION_USER_LOOKUP,
          useValue: { findSessionUser: jest.fn() } satisfies SessionUserLookup,
        },
        {
          provide: CAPABILITY_RESOLVER,
          useValue: capabilityResolver,
        },
        {
          provide: SUBSCRIPTION_ACCESS,
          useValue: subscriptionAccess,
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    const expressApp = app.getHttpAdapter().getInstance() as Express;
    expressApp.use((req: Request, _res: Response, next: NextFunction) => {
      req.session = {
        user: {
          id: 'user-1',
          login: 'user-1',
          onboardingCompleted: true,
          isInternal: false,
        },
        tenantId: 'tenant-1',
      } as never;
      next();
    });
    await app.init();

    try {
      const response = await request(app.getHttpServer() as Server).get(
        '/guard-order-test',
      );

      expect(response.status).toBe(402);
      expect(subscriptionAccess.getForUser).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
