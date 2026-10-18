import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';

import { VercelCiSecretsService } from './vercel-ci-secrets.service';

describe('VercelCiSecretsService', () => {
  const githubService = {
    setActionsSecretStrict: jest.fn(),
    setActionsVariableStrict: jest.fn(),
    ensureDeploymentEnvironment: jest.fn(),
    dispatchWorkflow: jest.fn(),
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
  const vercelEnvClient = {
    ensureAutomationBypassSecret: jest.fn(),
    ensurePublicPreviews: jest.fn(),
  };

  const makeService = () =>
    new VercelCiSecretsService(
      githubService,
      providerConnectionsRepository as never,
      encryptionService as never,
      configService as never,
      vercelEnvClient as never,
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
    vercelEnvClient.ensureAutomationBypassSecret.mockResolvedValue(
      'bypass-secret-value',
    );
    vercelEnvClient.ensurePublicPreviews.mockResolvedValue('disabled');
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
      automationBypassSecret: 'VERCEL_FRONTEND_AUTOMATION_BYPASS_SECRET',
    });
    expect(githubService.setActionsSecretStrict).toHaveBeenCalledTimes(4);
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
    expect(githubService.setActionsSecretStrict).toHaveBeenCalledWith(
      'github-token',
      'owner',
      'web',
      'VERCEL_FRONTEND_AUTOMATION_BYPASS_SECRET',
      'bypass-secret-value',
    );
    expect(vercelEnvClient.ensureAutomationBypassSecret).toHaveBeenCalledWith({
      token: 'plain-vercel-token',
      targetId: 'prj_1',
    });
  });

  /*
   * Not every Vercel account can grant Protection Bypass for Automation (plan,
   * or a token without permission over it) — that must not cost the target
   * the rest of its Vercel secrets, which is why this is a best-effort step
   * and not a fourth setActionsSecretStrict call the caller must also mock.
   */
  it('installs the rest of the Vercel secrets when the bypass secret cannot be granted', async () => {
    vercelEnvClient.ensureAutomationBypassSecret.mockRejectedValue(
      new Error('Vercel refused to generate a Protection Bypass secret (403)'),
    );
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
    expect(result.githubSecrets.automationBypassSecret).toBeUndefined();
    // The other three secrets and the alias variable still installed.
    expect(githubService.setActionsSecretStrict).toHaveBeenCalledTimes(3);
    expect(githubService.setActionsVariableStrict).toHaveBeenCalledTimes(1);
  });

  it('scopes the bypass request to a BYO Vercel team, the same as its other calls', async () => {
    const service = makeService();

    await service.installForTarget({
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
        providerMetadata: {
          vercelOrgId: 'team_byo',
          vercelTeamId: 'team_byo',
          vercelTeamSlug: 'byo-team',
        },
        status: 'active',
      },
    });

    expect(vercelEnvClient.ensureAutomationBypassSecret).toHaveBeenCalledWith({
      token: 'plain-vercel-token',
      targetId: 'prj_1',
      vercelTeamId: 'team_byo',
      vercelTeamSlug: 'byo-team',
    });
  });

  /*
   * The alias stem, installed rather than asked for.
   *
   * A CI-pushed deploy has no predictable address: `vercel deploy` returns a
   * per-deployment hostname, and Vercel assigns the stable
   * `<project>-git-<branch>-<scope>` name only to deployments its own Git
   * integration created. The deploy job therefore aliases each preview to a
   * hostname derived from this one variable, and the platform already knows
   * the project name — so nobody should be pasting it back in by hand.
   *
   * One variable, not one per branch: the branch is a prefix on the stem.
   */
  it('publishes one alias variable derived from the Vercel project name', async () => {
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

    expect(githubService.setActionsVariableStrict).toHaveBeenCalledTimes(1);
    expect(githubService.setActionsVariableStrict).toHaveBeenCalledWith(
      'github-token',
      'owner',
      'web',
      'VERCEL_ALIAS',
      'web.vercel.app',
    );
    expect(result.githubVariables).toEqual({ alias: 'VERCEL_ALIAS' });
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

  describe('public previews', () => {
    const target = (ownershipMode: 'flowci_managed' | 'byo') => ({
      id: 'target-1',
      projectId: 'project-1',
      slot: 'frontend' as const,
      ownershipMode,
      provider: 'vercel',
      providerConnectionId: ownershipMode === 'byo' ? 'connection-1' : null,
      providerProjectId: 'prj_1',
      providerProjectName: 'web',
      repoFullName: 'owner/web',
      branchName: 'uat',
      rootDirectory: null,
      buildCommand: null,
      startCommand: null,
      environmentMap: {},
      deploymentStrategy: 'vercel_ci_pushed' as const,
      providerMetadata: {
        vercelOrgId: 'team_flowci',
        vercelTeamId: 'team_flowci',
        vercelTeamSlug: 'alphaci',
      },
      status: 'active' as const,
    });
    const install = (ownershipMode: 'flowci_managed' | 'byo') =>
      makeService().installForTarget({
        githubAccessToken: 'github-token',
        repoFullName: 'owner/web',
        userId: 'user-1',
        providerConnectionId: ownershipMode === 'byo' ? 'connection-1' : null,
        target: target(ownershipMode),
      });

    it('turns off Vercel Authentication on an ALPHACI-managed project, in its team', async () => {
      await install('flowci_managed');

      expect(vercelEnvClient.ensurePublicPreviews).toHaveBeenCalledWith({
        token: 'flowci-vercel-token',
        targetId: 'prj_1',
        vercelTeamId: 'team_flowci',
        vercelTeamSlug: 'alphaci',
      });
    });

    it('leaves a project the customer connected with their own Vercel account alone', async () => {
      await install('byo');

      expect(vercelEnvClient.ensurePublicPreviews).not.toHaveBeenCalled();
    });

    it('still installs every secret when Vercel refuses the change', async () => {
      vercelEnvClient.ensurePublicPreviews.mockRejectedValue(
        new Error('Vercel Authentication could not be turned off (403)'),
      );

      await expect(install('flowci_managed')).resolves.toEqual(
        expect.objectContaining({
          githubSecrets: expect.objectContaining({
            token: 'VERCEL_FRONTEND_TOKEN',
            automationBypassSecret: 'VERCEL_FRONTEND_AUTOMATION_BYPASS_SECRET',
          }) as Record<string, string>,
        }),
      );
    });
  });
});
