import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/app.config';
import type {
  EnvOwnershipMode,
  RenderServiceType,
} from './deployments.types';

const FREE_SUPPORTED_SERVICE_TYPES: RenderServiceType[] = ['web_service'];

@Injectable()
export class RenderCostPolicyService {
  constructor(private readonly configService: ConfigService) {}

  resolveDefaults(input: {
    ownershipMode: EnvOwnershipMode;
    serviceType?: RenderServiceType | null | undefined;
    instanceType?: string | null | undefined;
    region?: string | null | undefined;
  }): { serviceType: RenderServiceType; instanceType: string; region: string } {
    const config = this.configService.getOrThrow<AppConfig>('app');
    const serviceType = input.serviceType ?? 'web_service';
    const instanceType =
      input.instanceType?.trim() ||
      config.envProvisioning.flowciManaged.renderDefaultInstanceType ||
      'free';
    const region =
      input.region?.trim() ||
      config.envProvisioning.flowciManaged.renderDefaultRegion ||
      'singapore';

    this.assertAllowed(serviceType, instanceType);

    return { serviceType, instanceType, region };
  }

  assertManagedAllowed(
    serviceType: RenderServiceType,
    instanceType: string,
  ): void {
    this.assertAllowed(serviceType, instanceType);
  }

  assertAllowed(serviceType: RenderServiceType, instanceType: string): void {
    const config = this.configService.getOrThrow<AppConfig>('app');
    const allowed = config.envProvisioning.flowciManaged
      .renderAllowedInstanceTypes ?? ['free'];
    const allowedFreeOnly = allowed.includes('free') ? ['free'] : allowed;
    if (!allowedFreeOnly.includes(instanceType)) {
      throw new BadRequestException(
        `Render targets must use the free instance type. Received '${instanceType}'.`,
      );
    }

    const freeLike = instanceType === 'free';
    if (freeLike && !FREE_SUPPORTED_SERVICE_TYPES.includes(serviceType)) {
      throw new BadRequestException(
        `Render targets on the free plan must use a web service. Received '${serviceType}'.`,
      );
    }

    if (
      !freeLike &&
      !config.envProvisioning.flowciManaged.renderAllowPaidManaged
    ) {
      throw new BadRequestException(
        'Managed paid Render provisioning is disabled. Use the free default or connect your own Render account.',
      );
    }
  }
}
