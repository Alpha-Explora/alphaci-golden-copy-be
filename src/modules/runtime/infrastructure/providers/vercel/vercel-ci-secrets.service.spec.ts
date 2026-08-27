import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';

import { VercelCiSecretsService } from './vercel-ci-secrets.service';

describe('VercelCiSecretsService', () => {
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

  const makeService = () =>
    new VercelCiSecretsService(
      githubService as never,
      providerConnectionsRepository as never,
      encryptionService as never,
      configService as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    configService.getOrThrow.mockReturnValue({
      envProvisioning: {
        flowciManaged: {
          vercelToken: 'flowci-vercel-token',
        },
      },
    });
    providerConnectionsRepository.findActiveProviderConnection.mockResolvedValue(
      {
        provider: 'vercel',
        encryptedToken: 'encrypted-vercel-token',
      },
    );
    encryptionService.decrypt.mockReturnValue('plain-vercel-token');
  });

  it('installs per-slot Vercel secrets for BYO CI-pushed targets', async () => {
    const service = makeService();

    const result = await service.installForTarget({
      githubAccessToken: 'github-token',
      repoFullName: 'owner/web',
      userId: 'user-1',
      providerConnectionId: 'connection-1',
      target: {
        id: 'target-1',
        projectId: 'project-1',
        slot: 'frontend',
        ownershipMode: 'byo',
        provider: 'vercel',
        providerConnectionId: 'connection-1',
        providerProjectId: 'prj_1',
        providerProjectName: 'web',
        repoFullName: 'owner/web',
        branchName: 'test',
        rootDirectory: null,
        buildCommand: null,
        startCommand: null,
        environmentMap: {},
        deploymentStrategy: 'vercel_ci_pushed',
        providerMetadata: { vercelOrgId: 'user_123' },
        status: 'active',
      },
    });

    expect(result.githubSecrets).toEqual({
      token: 'VERCEL_FRONTEND_TOKEN',
      orgId: 'VERCEL_FRONTEND_ORG_ID',
      projectId: 'VERCEL_FRONTEND_PROJECT_ID',
    });
    expect(githubService.setActionsSecretStrict).toHaveBeenCalledTimes(3);
    expect(githubService.setActionsSecretStrict).toHaveBeenCalledWith(
      'github-token',
      'owner',
      'web',
      'VERCEL_FRONTEND_TOKEN',
      'plain-vercel-token',
    );
    expect(githubService.setActionsSecretStrict).toHaveBeenCalledWith(
      'github-token',
      'owner',
      'web',
      'VERCEL_FRONTEND_ORG_ID',
      'user_123',
    );
    expect(githubService.setActionsSecretStrict).toHaveBeenCalledWith(
      'github-token',
      'owner',
      'web',
      'VERCEL_FRONTEND_PROJECT_ID',
      'prj_1',
    );
  });

  it('uses the ALPHACI-managed Vercel token for managed CI-pushed targets', async () => {
    const service = makeService();

    await service.installForTarget({
      githubAccessToken: 'github-token',
      repoFullName: 'owner/web',
      userId: 'user-1',
      providerConnectionId: null,
      target: {
        id: 'target-1',
        projectId: 'project-1',
        slot: 'frontend',
        ownershipMode: 'flowci_managed',
        provider: 'vercel',
        providerConnectionId: null,
        providerProjectId: 'prj_1',
        providerProjectName: 'web',
        repoFullName: 'owner/web',
        branchName: 'test',
        rootDirectory: null,
        buildCommand: null,
        startCommand: null,
        environmentMap: {},
        deploymentStrategy: 'vercel_ci_pushed',
        providerMetadata: { vercelOrgId: 'team_flowci' },
        status: 'active',
      },
    });

    expect(
      providerConnectionsRepository.findActiveProviderConnection,
    ).not.toHaveBeenCalled();
    expect(encryptionService.decrypt).not.toHaveBeenCalled();
    expect(githubService.setActionsSecretStrict).toHaveBeenCalledWith(
      'github-token',
      'owner',
      'web',
      'VERCEL_FRONTEND_TOKEN',
      'flowci-vercel-token',
    );
  });

  it('requires ALPHACI-managed Vercel token before installing managed secrets', async () => {
    configService.getOrThrow.mockReturnValue({
      envProvisioning: {
        flowciManaged: {
          vercelToken: '',
        },
      },
    });
    const service = makeService();

    await expect(
      service.installForTarget({
        githubAccessToken: 'github-token',
        repoFullName: 'owner/web',
        userId: 'user-1',
        providerConnectionId: null,
        target: {
          id: 'target-1',
          projectId: 'project-1',
          slot: 'frontend',
          ownershipMode: 'flowci_managed',
          provider: 'vercel',
          providerConnectionId: null,
          providerProjectId: 'prj_1',
          providerProjectName: 'web',
          repoFullName: 'owner/web',
          branchName: 'test',
          rootDirectory: null,
          buildCommand: null,
          startCommand: null,
          environmentMap: {},
          deploymentStrategy: 'vercel_ci_pushed',
          providerMetadata: { vercelOrgId: 'team_flowci' },
          status: 'active',
        },
      }),
    ).rejects.toThrow(InternalServerErrorException);
  });

  it('requires Vercel org metadata before installing secrets', async () => {
    const service = makeService();

    await expect(
      service.installForTarget({
        githubAccessToken: 'github-token',
        repoFullName: 'owner/web',
        userId: 'user-1',
        providerConnectionId: 'connection-1',
        target: {
          id: 'target-1',
          projectId: 'project-1',
          slot: 'frontend',
          ownershipMode: 'byo',
          provider: 'vercel',
          providerConnectionId: 'connection-1',
          providerProjectId: 'prj_1',
          providerProjectName: 'web',
          repoFullName: 'owner/web',
          branchName: 'test',
          rootDirectory: null,
          buildCommand: null,
          startCommand: null,
          environmentMap: {},
          deploymentStrategy: 'vercel_ci_pushed',
          providerMetadata: {},
          status: 'active',
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
