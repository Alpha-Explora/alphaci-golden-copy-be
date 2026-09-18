import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config.types.js';
import {
  TENANCY_REPOSITORY,
  type TenantProvisioningRepository,
} from '../contracts/tenant-provisioning.contract.js';
import type {
  TenantContext,
  TenantContextResolverPort,
} from '#kernel/tenancy/tenant-context.port.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantContextService implements TenantContextResolverPort {
  constructor(
    @Inject(TENANCY_REPOSITORY)
    private readonly repository: TenantProvisioningRepository,
    private readonly configService: ConfigService,
  ) {}

  async resolveForSession(
    userId: string,
    requestedTenantId?: string,
  ): Promise<TenantContext> {
    const deploymentMode =
      this.configService.getOrThrow<AppConfig>('app').composition.profile;
    const requested = requestedTenantId?.trim() || undefined;

    if (!UUID_RE.test(userId)) {
      throw new UnauthorizedException('Authentication required');
    }
    if (requested && !UUID_RE.test(requested)) {
      throw new ConflictException('The selected tenant identifier is invalid');
    }

    const activeTenants =
      deploymentMode === 'enterprise'
        ? await this.repository.findActiveTenants()
        : undefined;

    if (activeTenants && activeTenants.length !== 1) {
      throw new ConflictException(
        'Enterprise deployment must have exactly one active tenant',
      );
    }

    if (requested && activeTenants && activeTenants[0]?.id !== requested) {
      throw new UnauthorizedException('Tenant access is not permitted');
    }

    const memberships = await this.repository.findActiveMembershipsForUser(
      userId,
      requested,
    );

    if (requested) {
      const membership = memberships.find(
        (candidate) => candidate.tenantId === requested,
      );
      if (!membership) {
        throw new UnauthorizedException('Tenant access is not permitted');
      }
      return this.toContext(userId, deploymentMode, membership);
    }

    if (deploymentMode === 'enterprise') {
      const activeTenant = activeTenants?.[0];
      if (!activeTenant) {
        throw new ConflictException(
          'Enterprise deployment must have exactly one active tenant',
        );
      }

      const membership = memberships.find(
        (candidate) => candidate.tenantId === activeTenant.id,
      );
      if (!membership) {
        throw new UnauthorizedException('Tenant access is not permitted');
      }
      return this.toContext(userId, deploymentMode, membership);
    }

    if (memberships.length === 0) {
      throw new UnauthorizedException('A tenant membership is required');
    }
    if (memberships.length > 1) {
      throw new ConflictException('Select an active tenant before continuing');
    }

    const membership = memberships[0];
    if (!membership) {
      throw new UnauthorizedException('A tenant membership is required');
    }

    return this.toContext(userId, deploymentMode, membership);
  }

  private toContext(
    userId: string,
    deploymentMode: TenantContext['deploymentMode'],
    membership: {
      tenantId: string;
      role: TenantContext['membershipRole'];
    },
  ): TenantContext {
    return {
      tenantId: membership.tenantId,
      userId,
      membershipRole: membership.role,
      deploymentMode,
    };
  }
}
