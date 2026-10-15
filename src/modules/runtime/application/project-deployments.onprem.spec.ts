import { ConfigService } from '@nestjs/config';
import { ProjectDeploymentsService } from './project-deployments.service';
import { DeploymentHistorySourceRegistry } from '../core/deployment-history-source.registry';
import type { DeploymentTargetsRepository } from '../infrastructure/repositories/deployment-targets.repository';
import type { ProviderClientRegistryPort } from './ports/provider-client-registry.port';
import type { CapabilityResolverPort } from '#kernel/composition/capability-resolver.port';
import type { RuntimeEnvProviderClient } from './ports/runtime-env-provider.client';

describe('Host-delivered deployment history', () => {
  const target = {
    id: 'target',
    projectId: 'project',
    provider: 'onprem-compose',
  };
  const read = jest.fn();
  const getClient = jest.fn<RuntimeEnvProviderClient, [string]>(() => {
    throw new Error('No provider client registered');
  });
  const targets = {
    listDeploymentTargets: jest.fn().mockResolvedValue([target]),
  };
  const config = new ConfigService({
    app: { deploymentHistory: { enabled: true, liveProvidersEnabled: true } },
  });

  function service() {
    return new ProjectDeploymentsService(
      targets as unknown as DeploymentTargetsRepository,
      undefined,
      config,
      { getClient } as unknown as ProviderClientRegistryPort,
      undefined,
      undefined,
      undefined,
      {
        deployment: () => new Set(['runtime.deployment-history']),
      } as unknown as CapabilityResolverPort,
      new DeploymentHistorySourceRegistry([
        { provider: 'onprem-compose', read },
      ]),
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    read.mockResolvedValue([]);
  });

  it('returns live empty history without consulting a cloud client', async () => {
    const result = await service().listDeployments({
      projectId: 'project',
      userId: 'viewer',
      repoFullName: 'org/repo',
    });
    expect(result).toMatchObject({
      mode: 'live',
      deployments: [],
      providerError: null,
    });
    expect(read).toHaveBeenCalledWith(target, 'viewer');
    expect(getClient).not.toHaveBeenCalled();
  });

  it('reports unavailable history when the registry fails', async () => {
    read.mockRejectedValue(new Error('database unavailable'));
    const result = await service().listDeployments({
      projectId: 'project',
      userId: 'viewer',
      repoFullName: 'org/repo',
    });
    expect(result.mode).toBe('unavailable');
    expect(result.deployments).toEqual([]);
    expect(result.providerError).toContain('Onprem compose');
  });

  it('keeps cloud authentication when mixed with registry history', async () => {
    const getDeployHistory = jest.fn().mockResolvedValue([]);
    getClient.mockReturnValueOnce({
      provider: 'render',
      getDeployHistory,
    } as unknown as RuntimeEnvProviderClient);
    config.set(
      'app.envProvisioning.flowciManaged.renderToken',
      'test-render-token',
    );
    targets.listDeploymentTargets.mockResolvedValueOnce([
      target,
      {
        id: 'cloud',
        provider: 'render',
        providerProjectId: 'srv-1',
        ownershipMode: 'flowci_managed',
      },
    ]);
    const result = await service().listDeployments({
      projectId: 'project',
      userId: 'viewer',
      repoFullName: 'org/repo',
    });
    expect(result.mode).toBe('live');
    expect(read).toHaveBeenCalledTimes(1);
    expect(getDeployHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'test-render-token',
        targetId: 'srv-1',
      }),
    );
  });
});
