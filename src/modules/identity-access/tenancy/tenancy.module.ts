import { Global, Module } from '@nestjs/common';

import { DatabaseModule } from '#kernel/db/database.module.js';
import {
  TENANT_CONTEXT,
  TENANT_CONTEXT_RESOLVER,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextStore } from '#kernel/tenancy/tenant-context.js';
import { TenantContextService } from './application/tenant-context.service.js';
import { TenantProvisioningService } from './application/tenant-provisioning.service.js';
import { TENANCY_REPOSITORY } from './contracts/tenant-provisioning.contract.js';
import { TenancyRepository } from './infrastructure/tenancy.repository.js';

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [
    TenancyRepository,
    TenantProvisioningService,
    TenantContextService,
    TenantContextStore,
    { provide: TENANCY_REPOSITORY, useExisting: TenancyRepository },
    { provide: TENANT_CONTEXT_RESOLVER, useExisting: TenantContextService },
    { provide: TENANT_CONTEXT, useExisting: TenantContextStore },
  ],
  exports: [
    TenancyRepository,
    TenantProvisioningService,
    TenantContextService,
    TENANCY_REPOSITORY,
    TENANT_CONTEXT_RESOLVER,
    TENANT_CONTEXT,
  ],
})
export class TenancyModule {}
