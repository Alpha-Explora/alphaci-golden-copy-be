import { BadRequestException } from '@nestjs/common';

import { TenantProvisioningService } from './tenant-provisioning.service.js';
import type { TenantProvisioningRepository } from '../contracts/tenant-provisioning.contract.js';

const validInput = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  name: 'Example tenant',
  slug: 'example-tenant',
  kind: 'customer' as const,
  deploymentMode: 'hosted' as const,
  initialMembership: {
    userId: '22222222-2222-4222-8222-222222222222',
    role: 'owner' as const,
  },
};

function makeRepository(): jest.Mocked<TenantProvisioningRepository> {
  return {
    findActiveTenants: jest.fn().mockResolvedValue([]),
    findActiveMembershipsForUser: jest.fn(),
    provisionTenant: jest.fn().mockResolvedValue({
      id: validInput.tenantId,
      slug: validInput.slug,
      name: validInput.name,
      kind: validInput.kind,
      status: 'active',
    }),
    backfillWorkspaceScope: jest.fn().mockResolvedValue({
      tenantId: validInput.tenantId,
      dryRun: true,
      workspacesSelected: 1,
      projectsSelected: 1,
      workspacesWouldChange: 1,
      projectsWouldChange: 1,
      workspacesUpdated: 0,
      projectsUpdated: 0,
      workflowGenerationsSelected: 1,
      providerConnectionsSelected: 1,
      ciRunReportsSelected: 0,
      workflowGenerationsWouldChange: 1,
      providerConnectionsWouldChange: 1,
      ciRunReportsWouldChange: 0,
      workflowGenerationsUpdated: 0,
      providerConnectionsUpdated: 0,
      ciRunReportsUpdated: 0,
    }),
  };
}

describe('TenantProvisioningService', () => {
  it('requires an operator-supplied tenant and membership UUID', async () => {
    const repository = makeRepository();
    const service = new TenantProvisioningService(repository);

    await expect(
      service.provisionTenant({
        ...validInput,
        tenantId: 'generated-by-database',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(repository.provisionTenant).not.toHaveBeenCalled();
  });

  it('enforces one active tenant in Enterprise mode before writing', async () => {
    const repository = makeRepository();
    repository.findActiveTenants.mockResolvedValue([
      {
        id: '33333333-3333-4333-8333-333333333333',
        slug: 'existing',
        name: 'Existing',
        kind: 'enterprise',
        status: 'active',
      },
    ]);
    const service = new TenantProvisioningService(repository);

    await expect(
      service.provisionTenant({ ...validInput, deploymentMode: 'enterprise' }),
    ).rejects.toThrow(BadRequestException);
    expect(repository.provisionTenant).not.toHaveBeenCalled();
  });

  it('passes explicit dry-run scope selection, including account-owned rows, without guessing ownership', async () => {
    const repository = makeRepository();
    const service = new TenantProvisioningService(repository);

    const summary = await service.backfillWorkspaceScope({
      tenantId: validInput.tenantId,
      deploymentMode: 'hosted',
      selection: {
        kind: 'explicit-ids',
        workspaceIds: ['44444444-4444-4444-8444-444444444444'],
        projectIds: ['55555555-5555-4555-8555-555555555555'],
        workflowGenerationIds: ['66666666-6666-4666-8666-666666666666'],
        providerConnectionIds: ['77777777-7777-4777-8777-777777777777'],
      },
      dryRun: true,
    });

    expect(summary).toEqual({
      tenantId: validInput.tenantId,
      dryRun: true,
      workspacesSelected: 1,
      projectsSelected: 1,
      workspacesWouldChange: 1,
      projectsWouldChange: 1,
      workspacesUpdated: 0,
      projectsUpdated: 0,
      workflowGenerationsSelected: 1,
      providerConnectionsSelected: 1,
      ciRunReportsSelected: 0,
      workflowGenerationsWouldChange: 1,
      providerConnectionsWouldChange: 1,
      ciRunReportsWouldChange: 0,
      workflowGenerationsUpdated: 0,
      providerConnectionsUpdated: 0,
      ciRunReportsUpdated: 0,
    });

    expect(repository.backfillWorkspaceScope).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        selection: {
          kind: 'explicit-ids',
          workspaceIds: ['44444444-4444-4444-8444-444444444444'],
          projectIds: ['55555555-5555-4555-8555-555555555555'],
          workflowGenerationIds: ['66666666-6666-4666-8666-666666666666'],
          providerConnectionIds: ['77777777-7777-4777-8777-777777777777'],
        },
      }),
    );
  });

  it('refuses a backfill with no explicit row ids', async () => {
    const repository = makeRepository();
    const service = new TenantProvisioningService(repository);

    await expect(
      service.backfillWorkspaceScope({
        tenantId: validInput.tenantId,
        deploymentMode: 'enterprise',
        selection: { kind: 'explicit-ids', workspaceIds: [], projectIds: [] },
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('accepts explicit provider and workflow history ids without guessing ownership', async () => {
    const repository = makeRepository();
    const service = new TenantProvisioningService(repository);

    await service.backfillWorkspaceScope({
      tenantId: validInput.tenantId,
      deploymentMode: 'hosted',
      selection: {
        kind: 'explicit-ids',
        workspaceIds: [],
        projectIds: [],
        workflowGenerationIds: ['66666666-6666-4666-8666-666666666666'],
        providerConnectionIds: ['77777777-7777-4777-8777-777777777777'],
      },
      dryRun: true,
    });

    expect(repository.backfillWorkspaceScope).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: expect.objectContaining({
          workflowGenerationIds: ['66666666-6666-4666-8666-666666666666'],
          providerConnectionIds: ['77777777-7777-4777-8777-777777777777'],
        }),
      }),
    );
  });

  it('requires an Enterprise backfill target to be the only active tenant', async () => {
    const repository = makeRepository();
    repository.findActiveTenants.mockResolvedValue([
      {
        id: '33333333-3333-4333-8333-333333333333',
        slug: 'other',
        name: 'Other',
        kind: 'enterprise',
        status: 'active',
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        slug: 'another',
        name: 'Another',
        kind: 'enterprise',
        status: 'active',
      },
    ]);

    const service = new TenantProvisioningService(repository);

    await expect(
      service.backfillWorkspaceScope({
        tenantId: validInput.tenantId,
        deploymentMode: 'enterprise',
        selection: {
          kind: 'explicit-ids',
          workspaceIds: ['55555555-5555-4555-8555-555555555555'],
          projectIds: [],
        },
      }),
    ).rejects.toThrow(
      'Enterprise deployment must have exactly one active tenant',
    );
    expect(repository.backfillWorkspaceScope).not.toHaveBeenCalled();
  });

  it('rejects malformed explicit scope identifiers before reaching the database', async () => {
    const repository = makeRepository();
    const service = new TenantProvisioningService(repository);

    await expect(
      service.backfillWorkspaceScope({
        tenantId: validInput.tenantId,
        deploymentMode: 'hosted',
        selection: {
          kind: 'explicit-ids',
          workspaceIds: ['not-a-uuid'],
          projectIds: [],
        },
      }),
    ).rejects.toThrow('workspaceIds must contain only UUIDs');
    expect(repository.backfillWorkspaceScope).not.toHaveBeenCalled();
  });
});
