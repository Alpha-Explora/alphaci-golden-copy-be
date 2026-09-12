import { Logger } from '@nestjs/common';

import { ProjectDeploymentProvisioningService } from './project-deployment-provisioning.service';
import { DeploymentProviderPolicyRegistry } from '../domain/deployment-provider.policy';
import { RenderDeploymentPolicy } from '../infrastructure/providers/render/render-deployment.policy';
import { VercelDeploymentPolicy } from '../infrastructure/providers/vercel/vercel-deployment.policy';
import type { RenderCostPolicyService } from '../infrastructure/providers/render/render-cost-policy.service';

describe('ProjectDeploymentProvisioningService', () => {
  const deploymentTargetsService = {
    createDeploymentTarget: jest.fn(),
    updateProviderMetadata: jest.fn(),
    recordTargetProvisioningFailure: jest.fn().mockResolvedValue(undefined),
  };
  const envVarsService = {
    provisionEnvVars: jest.fn(),
  };
  const vercelCiSecretsService = {
    supports: jest.fn(
      (target: { provider: string; deploymentStrategy: string }) =>
        target.provider === 'vercel' &&
        target.deploymentStrategy === 'vercel_ci_pushed',
    ),
    installForTarget: jest.fn(),
  };
  const ciSecretsInstallerRegistry = {
    get: jest.fn((provider: string) =>
      provider === 'vercel' ? vercelCiSecretsService : undefined,
    ),
  };
  const providerPolicyRegistry = new DeploymentProviderPolicyRegistry([
    new RenderDeploymentPolicy({} as RenderCostPolicyService),
    new VercelDeploymentPolicy(),
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
    deploymentTargetsService.createDeploymentTarget.mockResolvedValue({
      id: 'target-1',
      provider: 'render',
      providerProjectId: 'srv-1',
      providerProjectName: 'orders-api-test',
      branchName: 'uat',
    });
    envVarsService.provisionEnvVars.mockResolvedValue({
      provisioned: [{ key: 'DATABASE_URL', status: 'provisioned' }],
      failed: [],
    });
    vercelCiSecretsService.installForTarget.mockResolvedValue({
      githubSecrets: {
        token: 'VERCEL_FRONTEND_TOKEN',
        orgId: 'VERCEL_FRONTEND_ORG_ID',
        projectId: 'VERCEL_FRONTEND_PROJECT_ID',
      },
    });
  });

  it('creates provider targets and provisions env vars without storing values in the result', async () => {
    const service = new ProjectDeploymentProvisioningService(
      deploymentTargetsService as never,
      envVarsService as never,
      ciSecretsInstallerRegistry as never,
      providerPolicyRegistry,
    );

    const result = await service.provisionForProject({
      projectId: 'project-1',
      userId: 'user-1',
      repoFullName: 'tone/orders-api',
      request: {
        enabled: true,
        targets: [
          {
            slot: 'backend',
            provider: 'render',
            ownershipMode: 'flowci_managed',
            projectName: 'orders-api-uat',
            branchName: 'uat',
            rootDirectory: '.',
            buildCommand: 'npm ci && npm run build',
            startCommand: 'npm run start:prod',
            renderRuntime: 'python',
            env: [
              {
                lane: 'preview' as const,
                vars: [{ key: 'DATABASE_URL', value: 'postgres://secret' }],
              },
            ],
          },
        ],
      },
    });

    expect(
      deploymentTargetsService.createDeploymentTarget,
    ).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      expect.objectContaining({
        action: 'create',
        provider: 'render',
        renderRuntime: 'python',
        slot: 'backend',
      }),
    );
    expect(envVarsService.provisionEnvVars).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      {
        deploymentTargetId: 'target-1',
        lane: 'preview',
        gitBranch: 'uat',
        vars: [{ key: 'DATABASE_URL', value: 'postgres://secret' }],
      },
    );
    expect(JSON.stringify(result)).not.toContain('postgres://secret');
    expect(result.status).toBe('completed');
  });

  it('fans out variable group env vars and lets target-specific vars override them', async () => {
    const service = new ProjectDeploymentProvisioningService(
      deploymentTargetsService as never,
      envVarsService as never,
      ciSecretsInstallerRegistry as never,
      providerPolicyRegistry,
    );

    await service.provisionForProject({
      projectId: 'project-1',
      userId: 'user-1',
      repoFullName: 'tone/orders-api',
      request: {
        enabled: true,
        variableGroups: [
          {
            name: 'Shared API',
            provider: 'render',
            appliesTo: 'all',
            env: [
              {
                lane: 'preview' as const,
                vars: [
                  { key: 'API_URL', value: 'https://shared.example.com' },
                  { key: 'LOG_LEVEL', value: 'debug' },
                ],
              },
            ],
          },
        ],
        targets: [
          {
            slot: 'backend',
            provider: 'render',
            ownershipMode: 'flowci_managed',
            projectName: 'orders-api-uat',
            branchName: 'uat',
            env: [
              {
                lane: 'preview' as const,
                vars: [{ key: 'API_URL', value: 'https://branch.example.com' }],
              },
            ],
          },
        ],
      },
    });

    expect(envVarsService.provisionEnvVars).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      {
        deploymentTargetId: 'target-1',
        lane: 'preview',
        gitBranch: 'uat',
        vars: [
          { key: 'API_URL', value: 'https://branch.example.com' },
          { key: 'LOG_LEVEL', value: 'debug' },
        ],
      },
    );
  });

  it('can apply a variable group to a selected Vercel target branch', async () => {
    deploymentTargetsService.createDeploymentTarget
      .mockResolvedValueOnce({
        id: 'target-backend-uat',
        provider: 'render',
        providerProjectId: 'srv-1',
        providerProjectName: 'orders-api-uat',
        branchName: 'uat',
      })
      .mockResolvedValueOnce({
        id: 'target-backend-main',
        provider: 'render',
        providerProjectId: 'srv-2',
        providerProjectName: 'orders-api-main',
        branchName: 'main',
      })
      .mockResolvedValueOnce({
        id: 'target-frontend',
        provider: 'vercel',
        providerProjectId: 'prj_1',
        providerProjectName: 'orders-web-test',
        branchName: 'uat',
      });
    const service = new ProjectDeploymentProvisioningService(
      deploymentTargetsService as never,
      envVarsService as never,
      ciSecretsInstallerRegistry as never,
      providerPolicyRegistry,
    );

    await service.provisionForProject({
      projectId: 'project-1',
      userId: 'user-1',
      repoFullName: 'tone/orders',
      request: {
        enabled: true,
        variableGroups: [
          {
            name: 'Frontend public env',
            provider: 'vercel',
            appliesTo: 'selected',
            targetBranches: ['frontend:vercel:uat'],
            env: [
              {
                lane: 'preview' as const,
                vars: [
                  {
                    key: 'NEXT_PUBLIC_API_URL',
                    value: 'https://api.example.com',
                  },
                ],
              },
            ],
          },
        ],
        targets: [
          {
            slot: 'backend',
            provider: 'render',
            ownershipMode: 'flowci_managed',
            projectName: 'orders-api-uat',
            branchName: 'uat',
          },
          {
            slot: 'frontend',
            provider: 'vercel',
            ownershipMode: 'flowci_managed',
            projectName: 'orders-web-uat',
            branchName: 'uat',
          },
        ],
      },
    });

    // The user's variable group lands only on the selected frontend target;
    // any other calls are the automatic cross-service URL injection, which
    // must not repeat the user-provided key.
    expect(envVarsService.provisionEnvVars).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      {
        deploymentTargetId: 'target-frontend',
        lane: 'preview',
        gitBranch: 'uat',
        vars: [
          {
            key: 'NEXT_PUBLIC_API_URL',
            value: 'https://api.example.com',
          },
        ],
      },
    );
    const apiUrlValues = envVarsService.provisionEnvVars.mock.calls.flatMap(
      ([, , dto]: [
        string,
        string,
        { vars: Array<{ key: string; value: string }> },
      ]) =>
        dto.vars
          .filter((variable) => variable.key === 'NEXT_PUBLIC_API_URL')
          .map((variable) => variable.value),
    );
    expect(apiUrlValues).toEqual(['https://api.example.com']);
  });

  it('reports partial status when one requested target fails', async () => {
    deploymentTargetsService.createDeploymentTarget
      .mockResolvedValueOnce({
        id: 'target-1',
        provider: 'render',
        providerProjectId: 'srv-1',
        providerProjectName: 'orders-api-test',
      })
      .mockRejectedValueOnce(new Error('Bearer rnd_secret failed'));

    const service = new ProjectDeploymentProvisioningService(
      deploymentTargetsService as never,
      envVarsService as never,
      ciSecretsInstallerRegistry as never,
      providerPolicyRegistry,
    );

    const result = await service.provisionForProject({
      projectId: 'project-1',
      userId: 'user-1',
      repoFullName: 'tone/orders-api',
      request: {
        enabled: true,
        targets: [
          {
            slot: 'backend',
            provider: 'render',
            ownershipMode: 'flowci_managed',
            projectName: 'orders-api-test',
          },
          {
            slot: 'frontend',
            provider: 'vercel',
            ownershipMode: 'flowci_managed',
            projectName: 'orders-web-test',
          },
        ],
      },
    });

    expect(result.status).toBe('partial');
    expect(
      result.targets.find((target) => target.status === 'failed')?.errorSummary,
    ).toContain('Bearer [redacted]');
    expect(JSON.stringify(result)).not.toContain('rnd_secret');
  });

  it('installs GitHub Actions secrets for managed Vercel CI-pushed targets', async () => {
    deploymentTargetsService.createDeploymentTarget.mockResolvedValueOnce({
      id: 'target-1',
      projectId: 'project-1',
      slot: 'frontend',
      ownershipMode: 'flowci_managed',
      provider: 'vercel',
      providerConnectionId: null,
      providerProjectId: 'prj_1',
      providerProjectName: 'orders-ui-uat',
      repoFullName: 'tone/orders-ui',
      branchName: 'uat',
      rootDirectory: '.',
      buildCommand: 'npm run build',
      startCommand: null,
      environmentMap: {},
      deploymentStrategy: 'vercel_ci_pushed',
      providerMetadata: { vercelOrgId: 'team_flowci' },
      status: 'active',
    });
    deploymentTargetsService.updateProviderMetadata.mockResolvedValueOnce(
      undefined,
    );

    const service = new ProjectDeploymentProvisioningService(
      deploymentTargetsService as never,
      envVarsService as never,
      ciSecretsInstallerRegistry as never,
      providerPolicyRegistry,
    );

    const result = await service.provisionForProject({
      projectId: 'project-1',
      userId: 'user-1',
      repoFullName: 'tone/orders-ui',
      githubAccessToken: 'github-token',
      request: {
        enabled: true,
        targets: [
          {
            slot: 'frontend',
            provider: 'vercel',
            ownershipMode: 'flowci_managed',
            projectName: 'orders-ui-test',
            branchName: 'test',
            rootDirectory: '.',
            buildCommand: 'npm run build',
            env: [],
          },
        ],
      },
    });

    expect(vercelCiSecretsService.installForTarget).toHaveBeenCalledWith({
      githubAccessToken: 'github-token',
      repoFullName: 'tone/orders-ui',
      userId: 'user-1',
      providerConnectionId: null,
      target: expect.objectContaining({
        provider: 'vercel',
        ownershipMode: 'flowci_managed',
        deploymentStrategy: 'vercel_ci_pushed',
      }) as unknown,
    });
    expect(
      deploymentTargetsService.createDeploymentTarget,
    ).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      expect.objectContaining({
        branchName: 'uat',
        projectName: 'orders-ui-uat',
      }),
    );
    expect(
      deploymentTargetsService.updateProviderMetadata,
    ).toHaveBeenCalledWith('target-1', {
      vercelOrgId: 'team_flowci',
      githubSecrets: {
        token: 'VERCEL_FRONTEND_TOKEN',
        orgId: 'VERCEL_FRONTEND_ORG_ID',
        projectId: 'VERCEL_FRONTEND_PROJECT_ID',
      },
    });
    expect(result.targets[0]?.providerMetadata).toEqual({
      vercelOrgId: 'team_flowci',
      githubSecrets: {
        token: 'VERCEL_FRONTEND_TOKEN',
        orgId: 'VERCEL_FRONTEND_ORG_ID',
        projectId: 'VERCEL_FRONTEND_PROJECT_ID',
      },
    });
  });

  describe('cross-service URL injection', () => {
    const mockTargetsByProjectName = () => {
      deploymentTargetsService.createDeploymentTarget.mockImplementation(
        (
          _projectId: string,
          _userId: string,
          dto: { provider: string; projectName?: string },
        ) => {
          if (dto.provider === 'vercel') {
            return Promise.resolve({
              id: 'vercel-target',
              provider: 'vercel',
              providerProjectId: 'prj_123',
              providerProjectName: 'demo-frontend',
              deploymentStrategy: 'vercel_git_connected',
              // NOT NULL in the database, so a real summary always carries it;
              // the cross-link pass needs it to name a preview branch.
              branchName: 'uat',
              providerMetadata: {},
            });
          }
          return Promise.resolve({
            id: `render-${dto.projectName}`,
            provider: 'render',
            providerProjectId: `srv-${dto.projectName}`,
            providerProjectName: dto.projectName,
            deploymentStrategy: 'render_git_connected',
            branchName: dto.projectName?.endsWith('-main') ? 'main' : 'uat',
            renderEnvironmentName: dto.projectName?.endsWith('-main')
              ? 'production'
              : 'uat',
            providerMetadata: {
              renderServiceUrl: `https://${dto.projectName}.onrender.com`,
            },
          });
        },
      );
    };

    const fullStackRequest = () => ({
      enabled: true,
      targets: [
        {
          slot: 'backend' as const,
          provider: 'render' as const,
          ownershipMode: 'flowci_managed' as const,
          projectName: 'demo-backend',
        },
        {
          slot: 'frontend' as const,
          provider: 'vercel' as const,
          ownershipMode: 'flowci_managed' as const,
          projectName: 'demo-frontend',
        },
      ],
    });

    it('injects API URLs into the frontend and origins into the backend per environment', async () => {
      mockTargetsByProjectName();
      const service = new ProjectDeploymentProvisioningService(
        deploymentTargetsService as never,
        envVarsService as never,
        ciSecretsInstallerRegistry as never,
        providerPolicyRegistry,
      );

      await service.provisionForProject({
        projectId: 'project-1',
        userId: 'user-1',
        repoFullName: 'tone/demo',
        request: fullStackRequest(),
      });

      // Render fans out to uat and main; each backend service gets the
      // frontend origin for CORS.
      expect(envVarsService.provisionEnvVars).toHaveBeenCalledWith(
        'project-1',
        'user-1',
        {
          deploymentTargetId: 'render-demo-backend-uat',
          lane: 'preview',
          gitBranch: 'uat',
          vars: [
            { key: 'FRONTEND_URL', value: 'https://demo-frontend.vercel.app' },
            { key: 'CORS_ORIGINS', value: 'https://demo-frontend.vercel.app' },
          ],
        },
      );
      expect(envVarsService.provisionEnvVars).toHaveBeenCalledWith(
        'project-1',
        'user-1',
        {
          deploymentTargetId: 'render-demo-backend-main',
          lane: 'production',
          gitBranch: null,
          vars: [
            { key: 'FRONTEND_URL', value: 'https://demo-frontend.vercel.app' },
            { key: 'CORS_ORIGINS', value: 'https://demo-frontend.vercel.app' },
          ],
        },
      );

      // The single Vercel project serves both environments, each pointing at
      // the environment-matched backend service.
      expect(envVarsService.provisionEnvVars).toHaveBeenCalledWith(
        'project-1',
        'user-1',
        {
          deploymentTargetId: 'vercel-target',
          lane: 'preview',
          gitBranch: 'uat',
          vars: [
            {
              key: 'NEXT_PUBLIC_API_URL',
              value: 'https://demo-backend-uat.onrender.com',
            },
            {
              key: 'API_URL',
              value: 'https://demo-backend-uat.onrender.com',
            },
          ],
        },
      );
      expect(envVarsService.provisionEnvVars).toHaveBeenCalledWith(
        'project-1',
        'user-1',
        {
          deploymentTargetId: 'vercel-target',
          lane: 'production',
          gitBranch: null,
          vars: [
            {
              key: 'NEXT_PUBLIC_API_URL',
              value: 'https://demo-backend-main.onrender.com',
            },
            {
              key: 'API_URL',
              value: 'https://demo-backend-main.onrender.com',
            },
          ],
        },
      );
    });

    it('never overrides env keys the user provided themselves', async () => {
      mockTargetsByProjectName();
      const service = new ProjectDeploymentProvisioningService(
        deploymentTargetsService as never,
        envVarsService as never,
        ciSecretsInstallerRegistry as never,
        providerPolicyRegistry,
      );

      await service.provisionForProject({
        projectId: 'project-1',
        userId: 'user-1',
        repoFullName: 'tone/demo',
        request: {
          ...fullStackRequest(),
          sharedEnv: [
            {
              lane: 'preview' as const,
              vars: [{ key: 'CORS_ORIGINS', value: 'https://my-own.example' }],
            },
          ],
        },
      });

      const uatBackendCalls = envVarsService.provisionEnvVars.mock.calls.filter(
        ([, , dto]: [
          string,
          string,
          {
            deploymentTargetId: string;
            lane: string;
            gitBranch: string | null;
            vars: Array<{ key: string }>;
          },
        ]) =>
          dto.deploymentTargetId === 'render-demo-backend-uat' &&
          dto.lane === 'preview' &&
          dto.gitBranch === 'uat',
      );
      const sentVars = uatBackendCalls.flatMap(
        ([, , dto]: [
          string,
          string,
          { vars: Array<{ key: string; value: string }> },
        ]) => dto.vars,
      );
      // FRONTEND_URL is still injected, but the user's CORS_ORIGINS wins: the
      // only CORS_ORIGINS value ever sent for uat is the user's own.
      expect(sentVars.map((variable) => variable.key)).toContain(
        'FRONTEND_URL',
      );
      expect(
        sentVars
          .filter((variable) => variable.key === 'CORS_ORIGINS')
          .map((variable) => variable.value),
      ).toEqual(['https://my-own.example']);
    });

    it('cross-links targets that live on different projects (multi-repo)', async () => {
      const service = new ProjectDeploymentProvisioningService(
        deploymentTargetsService as never,
        envVarsService as never,
        ciSecretsInstallerRegistry as never,
        providerPolicyRegistry,
      );

      const backendTarget = {
        slot: 'backend' as const,
        provider: 'render' as const,
        ownershipMode: 'flowci_managed' as const,
        deploymentStrategy: 'render_image_pushed' as const,
        status: 'created' as const,
        deploymentTargetId: 'render-be',
        providerProjectId: 'srv-be',
        providerProjectName: 'demo-backend-main',
        providerMetadata: {
          renderServiceUrl: 'https://demo-backend-main.onrender.com',
        },
        renderEnvironmentName: 'production' as const,
        branchName: 'main',
        errorSummary: null,
        env: [],
      };
      const frontendTarget = {
        slot: 'frontend' as const,
        provider: 'vercel' as const,
        ownershipMode: 'flowci_managed' as const,
        deploymentStrategy: 'vercel_git_connected' as const,
        status: 'created' as const,
        deploymentTargetId: 'vercel-fe',
        providerProjectId: 'prj_fe',
        providerProjectName: 'demo-frontend',
        providerMetadata: {},
        branchName: 'main',
        errorSummary: null,
        env: [],
      };

      await service.crossLinkServiceUrls({
        userId: 'user-1',
        request: { enabled: true, targets: [] },
        groups: [
          {
            projectId: 'backend-project',
            result: { status: 'completed', targets: [backendTarget] },
          },
          {
            projectId: 'frontend-project',
            result: { status: 'completed', targets: [frontendTarget] },
          },
        ],
      });

      expect(envVarsService.provisionEnvVars).toHaveBeenCalledWith(
        'backend-project',
        'user-1',
        {
          deploymentTargetId: 'render-be',
          lane: 'production',
          gitBranch: null,
          vars: [
            { key: 'FRONTEND_URL', value: 'https://demo-frontend.vercel.app' },
            { key: 'CORS_ORIGINS', value: 'https://demo-frontend.vercel.app' },
          ],
        },
      );
      expect(envVarsService.provisionEnvVars).toHaveBeenCalledWith(
        'frontend-project',
        'user-1',
        {
          deploymentTargetId: 'vercel-fe',
          lane: 'production',
          gitBranch: null,
          vars: [
            {
              key: 'NEXT_PUBLIC_API_URL',
              value: 'https://demo-backend-main.onrender.com',
            },
            {
              key: 'API_URL',
              value: 'https://demo-backend-main.onrender.com',
            },
          ],
        },
      );
    });

    it('does nothing when only one side of the stack exists', async () => {
      const service = new ProjectDeploymentProvisioningService(
        deploymentTargetsService as never,
        envVarsService as never,
        ciSecretsInstallerRegistry as never,
        providerPolicyRegistry,
      );

      await service.crossLinkServiceUrls({
        userId: 'user-1',
        request: { enabled: true, targets: [] },
        groups: [
          {
            projectId: 'backend-project',
            result: {
              status: 'completed',
              targets: [
                {
                  slot: 'backend',
                  provider: 'render',
                  ownershipMode: 'flowci_managed',
                  deploymentStrategy: 'render_image_pushed',
                  status: 'created',
                  deploymentTargetId: 'render-be',
                  providerProjectId: 'srv-be',
                  providerProjectName: 'demo-backend-main',
                  providerMetadata: {},
                  errorSummary: null,
                  env: [],
                },
              ],
            },
          },
        ],
      });

      expect(envVarsService.provisionEnvVars).not.toHaveBeenCalled();
    });
  });
});

/*
 * A declined secret install has to be findable.
 *
 * Two paths decide the same thing from different sources: the workflow
 * generator emits deploy jobs from the target's OWNERSHIP MODE, this installs
 * the secrets those jobs read from its DEPLOYMENT STRATEGY. When they
 * disagree the repository gets `deploy-vercel-frontend-uat` referencing
 * `secrets.VERCEL_FRONTEND_TOKEN` that nothing set — observed on real
 * projects, both providers, with provisioning reporting success.
 *
 * The deploy then fails on an empty credential, in another repository, in
 * another workflow, with an error naming none of this.
 */
describe('ProjectDeploymentProvisioningService — declined secret installs', () => {
  // Its own mocks: the harness above is scoped to the first describe.
  const deploymentTargetsServiceRef = {
    createDeploymentTarget: jest.fn(),
    updateProviderMetadata: jest.fn(),
  };
  const envVarsServiceRef = {
    provisionEnvVars: jest.fn().mockResolvedValue({ applied: [] }),
  };
  const providerPolicyRegistryRef = new DeploymentProviderPolicyRegistry([
    new RenderDeploymentPolicy({} as RenderCostPolicyService),
    new VercelDeploymentPolicy(),
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
    envVarsServiceRef.provisionEnvVars.mockResolvedValue({ applied: [] });
    deploymentTargetsServiceRef.updateProviderMetadata.mockResolvedValue(
      undefined,
    );
  });

  const targetFor = (overrides: Record<string, unknown>) => ({
    id: 'target-9',
    projectId: 'project-1',
    slot: 'frontend',
    ownershipMode: 'flowci_managed',
    provider: 'vercel',
    providerConnectionId: null,
    providerProjectId: 'prj_9',
    providerProjectName: 'orders-ui-uat',
    repoFullName: 'tone/orders-ui',
    branchName: 'uat',
    rootDirectory: '.',
    buildCommand: 'npm run build',
    startCommand: null,
    environmentMap: {},
    deploymentStrategy: 'vercel_ci_pushed',
    providerMetadata: { vercelOrgId: 'team_flowci' },
    status: 'active',
    ...overrides,
  });

  const provision = async (installers: { get: jest.Mock }) => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const service = new ProjectDeploymentProvisioningService(
      deploymentTargetsServiceRef as never,
      envVarsServiceRef as never,
      installers as never,
      providerPolicyRegistryRef,
    );

    await service.provisionForProject({
      projectId: 'project-1',
      userId: 'user-1',
      repoFullName: 'tone/orders-ui',
      githubAccessToken: 'github-token',
      request: {
        enabled: true,
        targets: [
          {
            slot: 'frontend',
            provider: 'vercel',
            ownershipMode: 'flowci_managed',
            projectName: 'orders-ui-test',
            branchName: 'uat',
            rootDirectory: '.',
            buildCommand: 'npm run build',
            env: [],
          },
        ],
      },
    });

    const messages = warn.mock.calls.map((call) => String(call[0]));
    warn.mockRestore();
    return messages;
  };

  it('says so when the installer declines the target, and why', async () => {
    deploymentTargetsServiceRef.createDeploymentTarget.mockResolvedValueOnce(
      // The strategy the workflow generator never reads, and this one does.
      targetFor({ deploymentStrategy: 'provider_native' }),
    );

    const messages = await provision({
      get: jest.fn(() => ({
        supports: jest.fn(() => false),
        installForTarget: jest.fn(),
      })),
    });

    const declined = messages.find((message) => message.includes('declined'));
    expect(declined).toBeDefined();
    // Both halves of the disagreement, so the reader does not have to guess
    // which one is wrong.
    expect(declined).toContain('provider_native');
    expect(declined).toContain('flowci_managed');
    expect(declined).toContain('tone/orders-ui');
    expect(declined).toContain('without credentials');
  });

  it('says so when no installer is registered for the provider at all', async () => {
    deploymentTargetsServiceRef.createDeploymentTarget.mockResolvedValueOnce(
      targetFor({}),
    );

    const messages = await provision({ get: jest.fn(() => undefined) });

    const missing = messages.find((message) =>
      message.includes('No CI secrets installer'),
    );
    expect(missing).toBeDefined();
    expect(missing).toContain('vercel');
  });

  it('stays quiet when the installer accepts the target', async () => {
    deploymentTargetsServiceRef.createDeploymentTarget.mockResolvedValueOnce(
      targetFor({}),
    );

    const messages = await provision({
      get: jest.fn(() => ({
        supports: jest.fn(() => true),
        installForTarget: jest.fn().mockResolvedValue({ githubSecrets: {} }),
      })),
    });

    expect(
      messages.filter(
        (message) =>
          message.includes('declined') ||
          message.includes('No CI secrets installer'),
      ),
    ).toHaveLength(0);
  });
});

/*
 * A target that fails to provision writes no row, so before this the only
 * trace was a warn line on the server - while the pipeline generated for that
 * target shipped to the repository regardless. A React project reached
 * production that way: three Vercel deploy jobs committed, zero deployment
 * targets stored, and a green "project created".
 */
describe('ProjectDeploymentProvisioningService, a target that cannot be created', () => {
  const targetsService = {
    createDeploymentTarget: jest
      .fn()
      .mockRejectedValue(
        new Error('ALPHACI-managed vercel token is not configured'),
      ),
    updateProviderMetadata: jest.fn(),
    recordTargetProvisioningFailure: jest.fn().mockResolvedValue(undefined),
  };

  const provision = async (overrides?: { recordFails?: boolean }) => {
    targetsService.recordTargetProvisioningFailure.mockClear();
    if (overrides?.recordFails) {
      targetsService.recordTargetProvisioningFailure.mockRejectedValueOnce(
        new Error('audit sink unreachable'),
      );
    }

    const service = new ProjectDeploymentProvisioningService(
      targetsService as never,
      { provisionEnvVars: jest.fn() } as never,
      { get: jest.fn(() => undefined) } as never,
      new DeploymentProviderPolicyRegistry([
        new RenderDeploymentPolicy({} as never),
        new VercelDeploymentPolicy(),
      ]),
    );

    return service.provisionForProject({
      projectId: 'project-1',
      userId: 'user-1',
      repoFullName: 'acme/storefront',
      githubAccessToken: 'token',
      request: {
        enabled: true,
        targets: [
          {
            slot: 'frontend',
            provider: 'vercel',
            ownershipMode: 'flowci_managed',
          },
        ],
      } as never,
    });
  };

  it('records the failure where someone can find it', async () => {
    const result = await provision();

    expect(result.status).toBe('failed');
    expect(targetsService.recordTargetProvisioningFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        provider: 'vercel',
        slot: 'frontend',
        reason: expect.stringContaining('vercel token'),
      }),
    );
  });

  it('still returns a result when recording the failure itself fails', async () => {
    // Losing the record of a failure must not also lose the results of the
    // targets that succeeded, so the recorder is awaited and swallowed.
    await expect(provision({ recordFails: true })).resolves.toMatchObject({
      status: 'failed',
    });
  });
});
