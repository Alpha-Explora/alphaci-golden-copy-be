import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';

import {
  TENANCY_REPOSITORY,
  type BackfillSummary,
  type BackfillWorkspaceScopeInput,
  type ProvisionTenantInput,
  type ProvisionedTenant,
  type TenantProvisioningRepository,
} from '../contracts/tenant-provisioning.contract.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantProvisioningService {
  constructor(
    @Inject(TENANCY_REPOSITORY)
    private readonly repository: TenantProvisioningRepository,
  ) {}

  async provisionTenant(
    input: ProvisionTenantInput,
  ): Promise<ProvisionedTenant> {
    this.assertUuid(input.tenantId, 'tenantId');
    this.assertUuid(input.initialMembership.userId, 'initialMembership.userId');
    this.assertText(input.slug, 'slug');
    this.assertText(input.name, 'name');

    if (input.deploymentMode === 'enterprise') {
      const activeTenants = await this.repository.findActiveTenants();
      if (activeTenants.some((tenant) => tenant.id !== input.tenantId)) {
        throw new BadRequestException(
          'An Enterprise database may contain only one active tenant',
        );
      }
    }

    const tenant = await this.repository.provisionTenant({
      ...input,
      slug: input.slug.trim().toLowerCase(),
      name: input.name.trim(),
    });

    return { ...tenant, deploymentMode: input.deploymentMode };
  }

  async backfillWorkspaceScope(
    input: BackfillWorkspaceScopeInput,
  ): Promise<BackfillSummary> {
    this.assertUuid(input.tenantId, 'tenantId');

    if (input.selection.kind === 'explicit-ids') {
      const hasSelectedRows = [
        input.selection.workspaceIds,
        input.selection.projectIds,
        input.selection.workflowGenerationIds ?? [],
        input.selection.providerConnectionIds ?? [],
        input.selection.ciRunReportIds ?? [],
      ].some((ids) => ids.length > 0);
      if (!hasSelectedRows) {
        throw new BadRequestException(
          'At least one explicit row id is required for a tenant backfill',
        );
      }
      this.assertUuidList(input.selection.workspaceIds, 'workspaceIds');
      this.assertUuidList(input.selection.projectIds, 'projectIds');
      this.assertUuidList(
        input.selection.workflowGenerationIds ?? [],
        'workflowGenerationIds',
      );
      this.assertUuidList(
        input.selection.providerConnectionIds ?? [],
        'providerConnectionIds',
      );
      this.assertUuidList(
        input.selection.ciRunReportIds ?? [],
        'ciRunReportIds',
      );
    }

    if (input.deploymentMode === 'enterprise') {
      const activeTenants = await this.repository.findActiveTenants();
      if (
        activeTenants.length !== 1 ||
        activeTenants[0]?.id !== input.tenantId
      ) {
        throw new ConflictException(
          'Enterprise deployment must have exactly one active tenant before backfill',
        );
      }
    }

    return this.repository.backfillWorkspaceScope(input);
  }

  private assertUuid(value: string, field: string): void {
    if (!UUID_RE.test(value.trim())) {
      throw new BadRequestException(`${field} must be a UUID`);
    }
  }

  private assertText(value: string, field: string): void {
    if (value.trim().length === 0) {
      throw new BadRequestException(`${field} is required`);
    }
  }

  private assertUuidList(values: readonly string[], field: string): void {
    for (const value of values) {
      if (!UUID_RE.test(value.trim())) {
        throw new BadRequestException(`${field} must contain only UUIDs`);
      }
    }
  }
}
