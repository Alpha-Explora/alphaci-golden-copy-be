import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { DatabaseService } from '#kernel/db/database.service';
import type { ManagedQuotaDefinition } from '#kernel/ports/usage-quota.port';
import { UsageQuotaService } from './usage-quota.service';

const makeDatabaseService = (query: jest.Mock, isEnabled = true) =>
  ({
    query,
    isEnabled: () => isEnabled,
  }) as unknown as DatabaseService;

const managedQuotaDefinitions: readonly ManagedQuotaDefinition[] = [
  {
    providerId: 'render',
    quotaCode: 'managed_render_services',
    fleetCapConfigKey: 'renderManagedFleetMax',
    providerLabel: 'Render',
    freeLimit: 1,
    proLimit: 10,
  },
  {
    providerId: 'vercel',
    quotaCode: 'managed_vercel_projects',
    fleetCapConfigKey: 'vercelManagedFleetMax',
    providerLabel: 'Vercel',
    freeLimit: 1,
    proLimit: 10,
  },
];

function registerManagedQuotas(service: UsageQuotaService): void {
  managedQuotaDefinitions.forEach((definition) =>
    service.registerManagedQuota(definition),
  );
}

describe('UsageQuotaService', () => {
  const configService = {
    getOrThrow: jest.fn(),
  };
  const capabilityResolver = { deployment: jest.fn() };
  let query: jest.Mock;
  let service: UsageQuotaService;

  beforeEach(() => {
    query = jest.fn();
    configService.getOrThrow.mockReturnValue({
      usageQuotas: { enabled: true },
    });
    capabilityResolver.deployment.mockReturnValue(
      new Set(['billing.usage-quotas']),
    );
    service = new UsageQuotaService(
      makeDatabaseService(query),
      configService as never,
      capabilityResolver as never,
    );
    registerManagedQuotas(service);
  });

  it('returns local usage counters and free plan limits', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ is_internal: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            projects: '2',
            deployment_targets: '2',
            env_keys: '4',
            workflow_prs: '1',
            managed_provider: 'render',
            managed_count: '1',
          },
          {
            projects: '2',
            deployment_targets: '2',
            env_keys: '4',
            workflow_prs: '1',
            managed_provider: 'vercel',
            managed_count: '0',
          },
        ],
      });

    await expect(service.getUsage('user-1')).resolves.toMatchObject({
      enabled: true,
      plan: 'free',
      items: expect.arrayContaining([
        expect.objectContaining({ code: 'projects', current: 2, limit: 3 }),
        expect.objectContaining({
          code: 'managed_render_services',
          current: 1,
          limit: 1,
          upgradeRequired: true,
        }),
      ]),
    });
  });

  it('treats pro_monthly subscriptions as pro quota plan', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ is_internal: false }] })
      .mockResolvedValueOnce({ rows: [{ plan_code: 'pro_monthly' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            projects: '4',
            deployment_targets: '6',
            env_keys: '26',
            workflow_prs: '6',
            managed_provider: 'render',
            managed_count: '2',
          },
          {
            projects: '4',
            deployment_targets: '6',
            env_keys: '26',
            workflow_prs: '6',
            managed_provider: 'vercel',
            managed_count: '2',
          },
        ],
      });

    await expect(service.getUsage('user-1')).resolves.toMatchObject({
      plan: 'pro',
      items: expect.arrayContaining([
        expect.objectContaining({ code: 'projects', current: 4, limit: 50 }),
      ]),
    });
  });

  it('blocks actions that would exceed enabled quotas', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ is_internal: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            projects: '3',
            deployment_targets: '0',
            env_keys: '0',
            workflow_prs: '0',
            managed_provider: 'render',
            managed_count: '0',
          },
        ],
      });

    await expect(
      service.assertWithinLimit('user-1', 'projects'),
    ).rejects.toThrow(BadRequestException);
  });

  it('exempts internal users from quota enforcement even when over the limit', async () => {
    // is_internal=true short-circuits before any plan/count lookup.
    query.mockResolvedValueOnce({ rows: [{ is_internal: true }] });

    await expect(
      service.assertWithinLimit('internal-user', 'projects'),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reports quotas as disabled and never upgrade-required for internal users', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ is_internal: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            projects: '99',
            deployment_targets: '99',
            env_keys: '99',
            workflow_prs: '99',
            managed_provider: 'render',
            managed_count: '99',
          },
        ],
      });

    const usage = await service.getUsage('internal-user');

    expect(usage.enabled).toBe(false);
    expect(usage.items.every((item) => item.upgradeRequired === false)).toBe(
      true,
    );
  });

  it('does not block actions when quotas are disabled', async () => {
    capabilityResolver.deployment.mockReturnValueOnce(new Set());

    await expect(
      service.assertWithinLimit('user-1', 'projects'),
    ).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  describe('assertManagedFleetCapacity', () => {
    const withFleetCap = (provider: 'render' | 'vercel', max: number) => {
      configService.getOrThrow.mockReturnValue({
        envProvisioning: {
          flowciManaged:
            provider === 'render'
              ? { renderManagedFleetMax: max }
              : { vercelManagedFleetMax: max },
        },
      });
    };

    it('rejects new managed targets once the platform fleet cap is reached', async () => {
      withFleetCap('render', 2);
      query.mockResolvedValueOnce({ rows: [{ count: '2' }] });

      await expect(
        service.assertManagedFleetCapacity({
          providerId: 'render',
          quotaCode: 'managed_render_services',
          fleetCapConfigKey: 'renderManagedFleetMax',
          providerLabel: 'Render',
        }),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('allows a managed target while under the fleet cap', async () => {
      withFleetCap('vercel', 5);
      query.mockResolvedValueOnce({ rows: [{ count: '1' }] });

      await expect(
        service.assertManagedFleetCapacity({
          providerId: 'vercel',
          quotaCode: 'managed_vercel_projects',
          fleetCapConfigKey: 'vercelManagedFleetMax',
          providerLabel: 'Vercel',
        }),
      ).resolves.toBeUndefined();
    });

    it('treats a cap of 0 as unlimited and never queries', async () => {
      withFleetCap('render', 0);

      await expect(
        service.assertManagedFleetCapacity({
          providerId: 'render',
          quotaCode: 'managed_render_services',
          fleetCapConfigKey: 'renderManagedFleetMax',
          providerLabel: 'Render',
        }),
      ).resolves.toBeUndefined();
      expect(query).not.toHaveBeenCalled();
    });

    it('is a no-op when the database is not configured', async () => {
      service = new UsageQuotaService(
        makeDatabaseService(query, false),
        configService as never,
        capabilityResolver as never,
      );
      registerManagedQuotas(service);

      await expect(
        service.assertManagedFleetCapacity({
          providerId: 'render',
          quotaCode: 'managed_render_services',
          fleetCapConfigKey: 'renderManagedFleetMax',
          providerLabel: 'Render',
        }),
      ).resolves.toBeUndefined();
      expect(query).not.toHaveBeenCalled();
    });
  });
});
