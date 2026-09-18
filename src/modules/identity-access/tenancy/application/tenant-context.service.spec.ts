import { ConflictException, UnauthorizedException } from '@nestjs/common';

import { TenantContextService } from './tenant-context.service.js';
import type { TenantProvisioningRepository } from '../contracts/tenant-provisioning.contract.js';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ONE = '11111111-1111-4111-8111-111111111111';
const TENANT_TWO = '33333333-3333-4333-8333-333333333333';

const tenant = (id: string) => ({
  id,
  slug: id,
  name: id,
  kind: 'customer' as const,
  status: 'active' as const,
});

const membership = (tenantId: string, userId = USER_ID) => ({
  tenantId,
  userId,
  role: 'member' as const,
  status: 'active' as const,
});

function makeRepository(): jest.Mocked<TenantProvisioningRepository> {
  return {
    findActiveTenants: jest.fn(),
    findActiveMembershipsForUser: jest.fn(),
    provisionTenant: jest.fn(),
    backfillWorkspaceScope: jest.fn(),
  };
}

function makeConfig(profile: 'hosted' | 'enterprise') {
  return {
    getOrThrow: jest.fn().mockReturnValue({ composition: { profile } }),
  } as never;
}

describe('TenantContextService', () => {
  it('resolves the only hosted membership without trusting a selector', async () => {
    const repository = makeRepository();
    repository.findActiveMembershipsForUser.mockResolvedValue([
      membership(TENANT_ONE),
    ]);
    const service = new TenantContextService(repository, makeConfig('hosted'));

    await expect(service.resolveForSession(USER_ID)).resolves.toEqual({
      tenantId: TENANT_ONE,
      userId: USER_ID,
      membershipRole: 'member',
      deploymentMode: 'hosted',
    });
    expect(repository.findActiveMembershipsForUser).toHaveBeenCalledWith(
      USER_ID,
      undefined,
    );
  });

  it('requires an explicit selection when hosted user has multiple memberships', async () => {
    const repository = makeRepository();
    repository.findActiveMembershipsForUser.mockResolvedValue([
      membership(TENANT_ONE),
      membership(TENANT_TWO),
    ]);
    const service = new TenantContextService(repository, makeConfig('hosted'));

    await expect(service.resolveForSession(USER_ID)).rejects.toThrow(
      ConflictException,
    );
  });

  it('validates a requested membership before returning context', async () => {
    const repository = makeRepository();
    repository.findActiveMembershipsForUser.mockResolvedValue([]);
    const service = new TenantContextService(repository, makeConfig('hosted'));

    await expect(
      service.resolveForSession(USER_ID, TENANT_TWO),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('resolves exactly one active tenant in an Enterprise database', async () => {
    const repository = makeRepository();
    repository.findActiveTenants.mockResolvedValue([tenant(TENANT_ONE)]);
    repository.findActiveMembershipsForUser.mockResolvedValue([
      membership(TENANT_ONE),
    ]);
    const service = new TenantContextService(
      repository,
      makeConfig('enterprise'),
    );

    await expect(service.resolveForSession(USER_ID)).resolves.toMatchObject({
      tenantId: TENANT_ONE,
      deploymentMode: 'enterprise',
    });
  });

  it('rejects an Enterprise database with zero or multiple active tenants', async () => {
    const repository = makeRepository();
    repository.findActiveTenants.mockResolvedValue([]);
    const service = new TenantContextService(
      repository,
      makeConfig('enterprise'),
    );

    await expect(service.resolveForSession(USER_ID)).rejects.toThrow(
      ConflictException,
    );
  });

  it('rejects a requested Enterprise tenant when the database is not single-tenant', async () => {
    const repository = makeRepository();
    repository.findActiveTenants.mockResolvedValue([
      tenant(TENANT_ONE),
      tenant(TENANT_TWO),
    ]);
    repository.findActiveMembershipsForUser.mockResolvedValue([
      membership(TENANT_TWO),
    ]);
    const service = new TenantContextService(
      repository,
      makeConfig('enterprise'),
    );

    await expect(
      service.resolveForSession(USER_ID, TENANT_TWO),
    ).rejects.toThrow(ConflictException);
    expect(repository.findActiveMembershipsForUser).not.toHaveBeenCalled();
  });
});
