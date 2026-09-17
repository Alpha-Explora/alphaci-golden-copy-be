import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import {
  CAPABILITY_RESOLVER,
  type CapabilityResolverPort,
} from './capability-resolver.port.js';
import { REQUIRED_CAPABILITIES } from './requires-capability.decorator.js';
import type { CapabilityKey } from './capability-types.js';

const CAPABILITY_NOT_AVAILABLE_MESSAGE =
  'Requested capability is not available';

@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CAPABILITY_RESOLVER)
    private readonly capabilityResolver: CapabilityResolverPort,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredCapabilities = this.reflector.getAllAndOverride<
      readonly CapabilityKey[] | undefined
    >(REQUIRED_CAPABILITIES, [context.getHandler(), context.getClass()]);

    if (!requiredCapabilities) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const tenantId = request.session?.tenantId;
    const capabilities = this.capabilityResolver.for(
      tenantId === undefined ? {} : { tenantId },
    );

    if (requiredCapabilities.every((key) => capabilities.has(key))) {
      return true;
    }

    throw new NotFoundException(CAPABILITY_NOT_AVAILABLE_MESSAGE);
  }
}
