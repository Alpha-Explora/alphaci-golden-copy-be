import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import {
  SESSION_USER_LOOKUP,
  type SessionUserLookup,
} from '#kernel/auth/session-user-lookup.contract';
import {
  TENANT_CONTEXT,
  TENANT_CONTEXT_RESOLVER,
  type TenantContextPort,
  type TenantContextResolverPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { SKIP_TENANT_CONTEXT } from '#kernel/tenancy/skip-tenant-context.decorator.js';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    @Inject(SESSION_USER_LOOKUP)
    private readonly sessionUserLookup: SessionUserLookup,
    @Optional()
    @Inject(TENANT_CONTEXT_RESOLVER)
    private readonly tenantContextResolver?: TenantContextResolverPort,
    @Optional()
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext?: TenantContextPort,
    @Optional()
    private readonly reflector?: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    // Guards run before every protected request. Reset any context inherited
    // from a previous async execution before authenticating this one; the
    // resolver will install a fresh membership-validated subject below.
    this.tenantContext?.clear();

    if (!request.session?.user && !request.session?.userId) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!request.session.user && request.session.userId) {
      const user = await this.sessionUserLookup.findSessionUser(
        request.session.userId,
      );

      if (!user) {
        throw new UnauthorizedException('Authentication required');
      }

      request.session.user = user;
      request.session.userId = user.id;
    }

    const skipTenantContext =
      this.reflector?.getAllAndOverride<boolean>(SKIP_TENANT_CONTEXT, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;

    if (
      !skipTenantContext &&
      this.tenantContextResolver &&
      this.tenantContext
    ) {
      const sessionUser = request.session.user;
      if (!sessionUser) {
        throw new UnauthorizedException('Authentication required');
      }
      try {
        const context = await this.tenantContextResolver.resolveForSession(
          sessionUser.id,
          request.session.tenantId,
        );
        this.tenantContext.set(context);
        // This remains a selector for the next request; authorization is
        // revalidated against the membership table every time.
        request.session.tenantId = context.tenantId;
      } catch (error) {
        this.tenantContext.clear();
        throw error;
      }
    }

    return true;
  }
}
