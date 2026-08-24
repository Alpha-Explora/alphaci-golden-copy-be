import { BadRequestException } from '@nestjs/common';

import type { DeploymentTargetSummary } from './deployments.types';
import { RenderCiSecretsService } from './render-ci-secrets.service';

describe('RenderCiSecretsService', () => {
  const githubService = {
    setActionsSecretStrict: jest.fn(),
  };
  const providerConnectionsRepository = {
    findActiveProviderConnection: jest.fn(),
  };
  const encryptionService = {
    decrypt: jest.fn(),
  };
  const configService = {
    getOrThrow: jest.fn(),
  };

  const baseTarget: DeploymentTargetSummary = {
    id: 'target-1',
    projectId: 'project-1',
    slot: 'backend',
    ownershipMode: 'flowci_managed',
    provider: 'render',
    providerConnectionId: null,
    providerProjectId: 'srv-1',
    providerProjectName: 'orders-api-uat',
    repoFullName: 'tone/orders-api',
    branchName: 'uat',
    rootDirectory: 'backend',
    buildCommand: null,
    startCommand: null,
    renderServiceType: 'web_service',
    renderInstanceType: 'free',
    renderRegion: 'singapore',
    renderEnvironmentName: 'uat',
    dockerContext: 'backend',
    dockerfilePath: 'backend/Dockerfile',
    imageUrl: null,
    environmentMap: {},
    deploymentStrategy: 'render_image_pushed',
    providerMetadata: {
      renderOwnerId: 'tea-flowci',
      renderRegistryCredentialId: 'crd-flowci',
    },
    status: 'active',
  };

  let service: RenderCiSecretsService;

  beforeEach(() => {
    jest.clearAllMocks();
    githubService.setActionsSecretStrict.mockResolvedValue(undefined);
    providerConnectionsRepository.findActiveProviderConnection.mockResolvedValue(
      {
        id: 'conn-1',
        provider: 'render',
        encryptedToken: 'encrypted-render-token',
        metadata: {
          ownerId: 'usr-render-owner',
        },
      },
    );
    encryptionService.decrypt.mockReturnValue('byo-render-token');
    configService.getOrThrow.mockReturnValue({
      envProvisioning: {
        flowciManaged: {
          renderToken: 'managed-render-token',
          renderOwnerId: 'tea-flowci',
        },
      },
    });

    service = new RenderCiSecretsService(
      githubService as never,
      providerConnectionsRepository as never,
      encryptionService as never,
      configService as never,
    );
  });

  it('installs Render API deployment secrets for managed image targets', async () => {
    const result = await service.installForTarget({
      githubAccessToken: 'gh-token',
      repoFullName: 'tone/orders-api',
      userId: 'user-1',
      providerConnectionId: null,
      target: baseTarget,
    });

    expect(result.githubSecrets).toEqual({
      apiKey: 'RENDER_BACKEND_UAT_API_KEY',
      serviceId: 'RENDER_BACKEND_UAT_SERVICE_ID',
      ownerId: 'RENDER_BACKEND_UAT_OWNER_ID',
      registryCredentialId: 'RENDER_BACKEND_UAT_REGISTRY_CREDENTIAL_ID',
      deployHookUrl: 'RENDER_DEPLOY_HOOK_URL_UAT',
      healthcheckUrl: 'RENDER_HEALTHCHECK_URL_UAT',
    });
    expect(githubService.setActionsSecretStrict).toHaveBeenCalledTimes(4);
    expect(githubService.setActionsSecretStrict).toHaveBeenNthCalledWith(
      1,
      'gh-token',
      'tone',
      'orders-api',
      'RENDER_BACKEND_UAT_API_KEY',
      'managed-render-token',
    );
    expect(githubService.setActionsSecretStrict).toHaveBeenNthCalledWith(
      2,
      'gh-token',
      'tone',
      'orders-api',
      'RENDER_BACKEND_UAT_SERVICE_ID',
      'srv-1',
    );
    expect(githubService.setActionsSecretStrict).toHaveBeenNthCalledWith(
      3,
      'gh-token',
      'tone',
      'orders-api',
      'RENDER_BACKEND_UAT_OWNER_ID',
      'tea-flowci',
    );
    expect(githubService.setActionsSecretStrict).toHaveBeenNthCalledWith(
      4,
      'gh-token',
      'tone',
      'orders-api',
      'RENDER_BACKEND_UAT_REGISTRY_CREDENTIAL_ID',
      'crd-flowci',
    );
  });

  it('uses BYO Render connection token and owner metadata for existing services', async () => {
    configService.getOrThrow.mockReturnValue({
      envProvisioning: {
        flowciManaged: {
          renderToken: 'managed-render-token',
          renderOwnerId: '',
        },
      },
    });

    await service.installForTarget({
      githubAccessToken: 'gh-token',
      repoFullName: 'tone/orders-api',
      userId: 'user-1',
      providerConnectionId: 'conn-1',
      target: {
        ...baseTarget,
        ownershipMode: 'byo',
        providerConnectionId: 'conn-1',
        deploymentStrategy: 'render_existing_service',
        providerMetadata: {},
      },
    });

    expect(encryptionService.decrypt).toHaveBeenCalledWith(
      'encrypted-render-token',
    );
    expect(githubService.setActionsSecretStrict).toHaveBeenCalledWith(
      'gh-token',
      'tone',
      'orders-api',
      'RENDER_BACKEND_UAT_API_KEY',
      'byo-render-token',
    );
    expect(githubService.setActionsSecretStrict).toHaveBeenCalledWith(
      'gh-token',
      'tone',
      'orders-api',
      'RENDER_BACKEND_UAT_OWNER_ID',
      'usr-render-owner',
    );
  });

  it('does not install secrets for native Render Git targets', async () => {
    const result = await service.installForTarget({
      githubAccessToken: 'gh-token',
      repoFullName: 'tone/orders-api',
      userId: 'user-1',
      providerConnectionId: null,
      target: {
        ...baseTarget,
        deploymentStrategy: 'render_git_connected',
      },
    });

    expect(result.githubSecrets.apiKey).toBe('RENDER_BACKEND_UAT_API_KEY');
    expect(githubService.setActionsSecretStrict).not.toHaveBeenCalled();
  });

  it('rejects invalid repository names before writing secrets', async () => {
    await expect(
      service.installForTarget({
        githubAccessToken: 'gh-token',
        repoFullName: 'invalid-repo',
        userId: 'user-1',
        providerConnectionId: null,
        target: baseTarget,
      }),
    ).rejects.toThrow(BadRequestException);

    expect(githubService.setActionsSecretStrict).not.toHaveBeenCalled();
  });
});
