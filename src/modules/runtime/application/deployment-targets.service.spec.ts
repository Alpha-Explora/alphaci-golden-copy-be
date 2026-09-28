import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';

import { DeploymentStrategyResolver } from '../domain/deployment-strategy.resolver';
import { DeploymentTargetsService } from './deployment-targets.service';
import { RenderCostPolicyService } from '../infrastructure/providers/render/render-cost-policy.service';
import { RenderDeploymentPolicy } from '../infrastructure/providers/render/render-deployment.policy';
import { VercelDeploymentPolicy } from '../infrastructure/providers/vercel/vercel-deployment.policy';
import type { DeploymentProviderPolicy } from '../domain/deployment-provider.policy';

describe('DeploymentTargetsService', () => {
  const projectReferenceLookup = {
    findProjectReference: jest.fn(),
    findProjectEnvironment: jest.fn(),
  };
  const deploymentTargetsRepository = {
    createDeploymentTarget: jest.fn(),
    deleteDeploymentTargetForUser: jest.fn(),
    findDeploymentTargetForUser: jest.fn(),
    listDeploymentTargets: jest.fn(),
    updateDeploymentTargetMetadataForUser: jest.fn(),
    updateProviderMetadata: jest.fn(),
  };
  const providerConnectionsRepository = {
    findActiveProviderConnection: jest.fn(),
  };
  const encryptionService = {
    decrypt: jest.fn(),
  };
  const vercelClient = {
    createTarget: jest.fn(),
  };
  const clientRegistry = {
    getClient: jest.fn(),
  };
  const configService = {
    getOrThrow: jest.fn(),
  };
  const capabilityResolver = {
    deployment: jest.fn(),
  };
  const usageQuotaService = {
    assertWithinLimit: jest.fn(),
    assertManagedFleetCapacity: jest.fn(),
  };
  const workspaceAccessService = {
    assertProjectRole: jest.fn(),
  };
  const auditEventsService = {
    recordProjectEvent: jest.fn(),
  };
  const notificationEventsService = {
    record: jest.fn(),
  };
  const providerRegistry = {
    find: jest.fn((provider: string) => {
      if (provider === 'render') {
        return {
          label: 'Render',
          supportedSlots: ['backend', 'standalone'],
          capabilities: {
            logFilters: ['level', 'type', 'text', 'instance'],
          },
          policy: renderPolicy,
          presentation: {
            publicUrl: (target: {
              providerProjectName: string;
              providerMetadata: Record<string, unknown>;
            }) =>
              (typeof target.providerMetadata['renderServiceUrl'] ===
                'string' &&
                target.providerMetadata['renderServiceUrl'].trim()) ||
              (target.providerProjectName
                ? `https://${target.providerProjectName}.onrender.com`
                : null),
            dashboardUrl: (target: { providerProjectId: string }) =>
              `https://dashboard.render.com/web/${target.providerProjectId}`,
            consoleUrl: (target: { providerProjectId: string }) =>
              `https://dashboard.render.com/web/${target.providerProjectId}/logs`,
          },
          slotViolationMessage: (): string =>
            'Render deployment targets are backend-only. Choose the backend slot for Render.',
        };
      }
      if (provider === 'vercel') {
        return {
          label: 'Vercel',
          supportedSlots: ['frontend'],
          capabilities: {
            logFilters: ['level', 'type', 'text'],
          },
          policy: vercelPolicy,
          presentation: {
            publicUrl: (target: { providerProjectName: string }) =>
              target.providerProjectName
                ? `https://${target.providerProjectName}.vercel.app`
                : null,
            dashboardUrl: (target: {
              providerProjectId: string;
              providerProjectName: string;
              providerMetadata: Record<string, unknown>;
            }) => {
              const teamSlug =
                typeof target.providerMetadata['vercelTeamSlug'] === 'string'
                  ? target.providerMetadata['vercelTeamSlug'].trim()
                  : '';
              return teamSlug
                ? `https://vercel.com/${teamSlug}/${target.providerProjectName}`
                : `https://vercel.com/dashboard/project/${target.providerProjectId}`;
            },
            consoleUrl: (target: {
              providerProjectId: string;
              providerProjectName: string;
              providerMetadata: Record<string, unknown>;
            }) => {
              const teamSlug =
                typeof target.providerMetadata['vercelTeamSlug'] === 'string'
                  ? target.providerMetadata['vercelTeamSlug'].trim()
                  : '';
              return teamSlug
                ? `https://vercel.com/${teamSlug}/${target.providerProjectName}/deployments`
                : `https://vercel.com/dashboard/project/${target.providerProjectId}/deployments`;
            },
          },
          slotViolationMessage: (): string =>
            'Vercel deployment targets are frontend-only. Choose the frontend slot for Vercel.',
        };
      }
      return undefined;
    }),
  };

  let renderPolicy: DeploymentProviderPolicy;
  let vercelPolicy: DeploymentProviderPolicy;

  let service: DeploymentTargetsService;

  beforeEach(() => {
    jest.clearAllMocks();
    projectReferenceLookup.findProjectReference.mockResolvedValue({
      projectId: 'project-1',
      userId: 'user-1',
      repoFullName: 'owner/repo',
    });
    providerConnectionsRepository.findActiveProviderConnection.mockResolvedValue(
      {
        id: 'connection-1',
        provider: 'vercel',
        encryptedToken: 'encrypted',
        metadata: {},
      },
    );
    encryptionService.decrypt.mockReturnValue('vercel-token');
    clientRegistry.getClient.mockReturnValue(vercelClient);
    usageQuotaService.assertWithinLimit.mockResolvedValue(undefined);
    usageQuotaService.assertManagedFleetCapacity.mockResolvedValue(undefined);
    workspaceAccessService.assertProjectRole.mockResolvedValue({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      role: 'member',
    });
    configService.getOrThrow.mockReturnValue({
      envProvisioning: {
        ownershipMode: 'byo',
        flowciManaged: {
          renderToken: 'render-token',
          vercelToken: 'flowci-vercel-token',
          vercelTeamId: 'team_flowci',
          vercelTeamSlug: 'flowci-team',
        },
      },
      projectTargetManagement: {
        enabled: true,
      },
    });
    capabilityResolver.deployment.mockReturnValue(
      new Set(['projects.target-management']),
    );
    renderPolicy = new RenderDeploymentPolicy(
      new RenderCostPolicyService(configService as never),
    );
    vercelPolicy = new VercelDeploymentPolicy();

    service = new DeploymentTargetsService(
      projectReferenceLookup,
      deploymentTargetsRepository as never,
      providerConnectionsRepository as never,
      encryptionService as never,
      clientRegistry,
      configService as never,
      new DeploymentStrategyResolver(providerRegistry as never),
      undefined,
      usageQuotaService,
      workspaceAccessService as never,
      auditEventsService as never,
      notificationEventsService as never,
      providerRegistry as never,
      capabilityResolver as never,
    );
  });

  /*
   * The resolver used to reach no policy at all - it was built without its
   * registry - and every managed target was created as `provider_native`.
   * The secrets installers ignore that strategy, so the targets existed and
   * their pipelines could never deploy. A provider with a policy never
   * answers `provider_native`, so seeing it means the wiring broke, and the
   * target must not be created.
   */
  it('refuses to create a target when the strategy fell back to provider_native', async () => {
    const unwired = new DeploymentTargetsService(
      projectReferenceLookup,
      deploymentTargetsRepository as never,
      providerConnectionsRepository as never,
      encryptionService as never,
      clientRegistry,
      configService as never,
      new DeploymentStrategyResolver(),
      undefined,
      usageQuotaService,
      workspaceAccessService as never,
      auditEventsService as never,
      notificationEventsService as never,
      providerRegistry as never,
    );

    const attempt = unwired.createDeploymentTarget('project-1', 'user-1', {
      action: 'create',
      slot: 'frontend',
      ownershipMode: 'byo',
      provider: 'vercel',
      providerConnectionId: 'connection-1',
      projectName: 'demo-frontend',
    });

    await expect(attempt).rejects.toThrow(InternalServerErrorException);
    await expect(attempt).rejects.toThrow('could not be resolved');
    expect(vercelClient.createTarget).not.toHaveBeenCalled();
    expect(
      deploymentTargetsRepository.createDeploymentTarget,
    ).not.toHaveBeenCalled();
  });

  it('rejects BYO Vercel targets when connection org metadata is missing', async () => {
    await expect(
      service.createDeploymentTarget('project-1', 'user-1', {
        action: 'create',
        slot: 'frontend',
        ownershipMode: 'byo',
        provider: 'vercel',
        providerConnectionId: 'connection-1',
        projectName: 'demo-frontend',
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.createDeploymentTarget('project-1', 'user-1', {
        action: 'create',
        slot: 'frontend',
        ownershipMode: 'byo',
        provider: 'vercel',
        providerConnectionId: 'connection-1',
        projectName: 'demo-frontend',
      }),
    ).rejects.toThrow('Vercel provider connection is missing org metadata');
    expect(vercelClient.createTarget).not.toHaveBeenCalled();
    expect(
      deploymentTargetsRepository.createDeploymentTarget,
    ).not.toHaveBeenCalled();
  });

  it('rejects archived ALPHACI-managed Vercel targets before provider calls', async () => {
    await expect(
      service.createDeploymentTarget('project-1', 'user-1', {
        action: 'create',
        slot: 'frontend',
        ownershipMode: 'flowci_managed',
        provider: 'vercel',
        projectName: 'demo-frontend',
      }),
    ).rejects.toThrow(
      'Managed vercel hosting is archived. Connect your own vercel account and use BYO hosting for new targets.',
    );

    expect(vercelClient.createTarget).not.toHaveBeenCalled();
    expect(
      deploymentTargetsRepository.createDeploymentTarget,
    ).not.toHaveBeenCalled();
    expect(workspaceAccessService.assertProjectRole).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      ['admin', 'delegated_lead', 'member'],
    );
  });

  it('rejects archived ALPHACI-managed Render targets before provider calls', async () => {
    await expect(
      service.createDeploymentTarget('project-1', 'user-1', {
        action: 'create',
        slot: 'backend',
        ownershipMode: 'flowci_managed',
        provider: 'render',
        projectName: 'demo-backend',
      }),
    ).rejects.toThrow(
      'Managed render hosting is archived. Connect your own render account and use BYO hosting for new targets.',
    );

    expect(vercelClient.createTarget).not.toHaveBeenCalled();
    expect(
      deploymentTargetsRepository.createDeploymentTarget,
    ).not.toHaveBeenCalled();
  });

  it('rejects Render targets outside the backend slot before provider calls', async () => {
    await expect(
      service.createDeploymentTarget('project-1', 'user-1', {
        action: 'create',
        slot: 'frontend',
        ownershipMode: 'byo',
        provider: 'render',
        providerConnectionId: 'connection-1',
        projectName: 'demo-api',
      }),
    ).rejects.toThrow(
      'Render deployment targets are backend-only. Choose the backend slot for Render.',
    );

    expect(vercelClient.createTarget).not.toHaveBeenCalled();
    expect(
      deploymentTargetsRepository.createDeploymentTarget,
    ).not.toHaveBeenCalled();
  });

  it('rejects Vercel targets outside the frontend slot before provider calls', async () => {
    await expect(
      service.createDeploymentTarget('project-1', 'user-1', {
        action: 'create',
        slot: 'backend',
        ownershipMode: 'byo',
        provider: 'vercel',
        providerConnectionId: 'connection-1',
        projectName: 'demo-web',
      }),
    ).rejects.toThrow(
      'Vercel deployment targets are frontend-only. Choose the frontend slot for Vercel.',
    );

    expect(vercelClient.createTarget).not.toHaveBeenCalled();
    expect(
      deploymentTargetsRepository.createDeploymentTarget,
    ).not.toHaveBeenCalled();
  });

  it('rejects BYO targets when the deployment centralizes on flowci_managed', async () => {
    configService.getOrThrow.mockReturnValue({
      envProvisioning: {
        ownershipMode: 'flowci_managed',
        flowciManaged: {
          renderToken: 'render-token',
          vercelToken: 'flowci-vercel-token',
          vercelTeamId: 'team_flowci',
          vercelTeamSlug: 'flowci-team',
        },
      },
      projectTargetManagement: { enabled: true },
    });

    await expect(
      service.createDeploymentTarget('project-1', 'user-1', {
        action: 'create',
        slot: 'frontend',
        ownershipMode: 'byo',
        provider: 'vercel',
        projectName: 'demo-frontend',
        providerConnectionId: 'conn-1',
      }),
    ).rejects.toThrow(
      "This workspace centralizes deployments on the organization's vercel account. Bring-your-own vercel hosting is not available here.",
    );

    expect(vercelClient.createTarget).not.toHaveBeenCalled();
    expect(
      deploymentTargetsRepository.createDeploymentTarget,
    ).not.toHaveBeenCalled();
  });

  it('registers existing Render services without storing legacy deploy hook metadata', async () => {
    providerConnectionsRepository.findActiveProviderConnection.mockResolvedValueOnce(
      {
        id: 'connection-1',
        provider: 'render',
        encryptedToken: 'encrypted',
        metadata: {
          ownerId: 'usr-render-owner',
        },
      },
    );
    encryptionService.decrypt.mockReturnValueOnce('render-token');
    deploymentTargetsRepository.createDeploymentTarget.mockResolvedValueOnce({
      id: 'target-1',
    });

    await service.createDeploymentTarget('project-1', 'user-1', {
      action: 'register_existing',
      slot: 'backend',
      ownershipMode: 'byo',
      provider: 'render',
      providerConnectionId: 'connection-1',
      providerProjectId: 'srv-1',
      providerProjectName: 'orders-api-test',
      renderDeployMethod: 'existing_service',
      environmentMap: {
        deployHookUrl: 'https://api.render.com/deploy/legacy',
      },
    });

    expect(vercelClient.createTarget).not.toHaveBeenCalled();
    expect(
      deploymentTargetsRepository.createDeploymentTarget,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'render',
        providerConnectionId: 'connection-1',
        providerProjectId: 'srv-1',
        providerProjectName: 'orders-api-test',
        deploymentStrategy: 'render_existing_service',
      }),
    );
    const [createInput] = deploymentTargetsRepository.createDeploymentTarget
      .mock.calls[0] as [
      {
        providerMetadata: Record<string, unknown>;
      },
    ];
    expect(createInput.providerMetadata).not.toHaveProperty('deployHookUrl');
  });

  it('updates ALPHACI target metadata without calling provider clients', async () => {
    const updatedTarget = {
      id: 'target-1',
      projectId: 'project-1',
      slot: 'backend',
      provider: 'render',
      providerProjectName: 'orders-api-uat',
      branchName: 'uat',
      rootDirectory: 'apps/api',
      buildCommand: 'npm run build',
      startCommand: 'npm run start:prod',
      renderEnvironmentName: 'uat',
    };
    deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
      {
        ...updatedTarget,
        provider: 'render',
        providerMetadata: {},
      },
    );
    deploymentTargetsRepository.updateDeploymentTargetMetadataForUser.mockResolvedValueOnce(
      updatedTarget,
    );

    await expect(
      service.updateDeploymentTargetMetadata(
        'project-1',
        'target-1',
        'user-1',
        {
          providerProjectName: ' orders-api-uat ',
          branchName: ' uat ',
          rootDirectory: ' apps/api ',
          buildCommand: ' npm run build ',
          startCommand: ' npm run start:prod ',
          slot: 'backend',
          renderEnvironmentName: 'uat',
        },
      ),
    ).resolves.toEqual(updatedTarget);

    expect(vercelClient.createTarget).not.toHaveBeenCalled();
    expect(
      deploymentTargetsRepository.updateDeploymentTargetMetadataForUser,
    ).toHaveBeenCalledWith(
      'project-1',
      'target-1',
      'user-1',
      expect.objectContaining({
        providerProjectName: 'orders-api-uat',
        branchName: 'uat',
        rootDirectory: 'apps/api',
        buildCommand: 'npm run build',
        startCommand: 'npm run start:prod',
        slot: 'backend',
        renderEnvironmentName: 'uat',
      }),
    );
    expect(workspaceAccessService.assertProjectRole).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      ['admin', 'delegated_lead', 'member'],
    );
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        projectId: 'project-1',
        eventCode: 'deployment_target_updated',
      }),
    );
  });

  it('rejects slot metadata updates that violate provider ownership', async () => {
    deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
      {
        id: 'target-1',
        projectId: 'project-1',
        provider: 'render',
        providerProjectName: 'orders-api',
        branchName: 'test',
        rootDirectory: null,
        status: 'active',
        providerMetadata: {},
      },
    );

    await expect(
      service.updateDeploymentTargetMetadata(
        'project-1',
        'target-1',
        'user-1',
        {
          slot: 'frontend',
        },
      ),
    ).rejects.toThrow(
      'Render deployment targets are backend-only. Choose the backend slot for Render.',
    );

    expect(
      deploymentTargetsRepository.updateDeploymentTargetMetadataForUser,
    ).not.toHaveBeenCalled();
  });

  it('rejects metadata updates for another user target', async () => {
    deploymentTargetsRepository.updateDeploymentTargetMetadataForUser.mockResolvedValueOnce(
      null,
    );

    await expect(
      service.updateDeploymentTargetMetadata(
        'project-1',
        'target-1',
        'user-2',
        {
          providerProjectName: 'orders-api',
        },
      ),
    ).rejects.toThrow('Deployment target not found');
  });

  it('detaches a target from ALPHACI without calling the provider delete API when not requested', async () => {
    deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
      {
        id: 'target-1',
        projectId: 'project-1',
        provider: 'render',
        providerProjectId: 'srv-1',
        providerProjectName: 'orders-api-test',
        ownershipMode: 'flowci_managed',
        providerConnectionId: null,
      },
    );
    deploymentTargetsRepository.deleteDeploymentTargetForUser.mockResolvedValueOnce(
      true,
    );

    await expect(
      service.detachDeploymentTarget('project-1', 'target-1', 'user-1'),
    ).resolves.toEqual({ detached: true, providerResourceDeleted: false });

    expect(vercelClient.createTarget).not.toHaveBeenCalled();
    expect(clientRegistry.getClient).not.toHaveBeenCalled();
    expect(
      deploymentTargetsRepository.deleteDeploymentTargetForUser,
    ).toHaveBeenCalledWith('project-1', 'target-1', 'user-1');
    expect(workspaceAccessService.assertProjectRole).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      ['admin', 'delegated_lead', 'member'],
    );
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        projectId: 'project-1',
        eventCode: 'deployment_target_detached',
        metadata: expect.objectContaining({
          deleteProviderResourceRequested: false,
          providerResourceDeleted: false,
        }),
      }),
    );
  });

  it('requires admin/delegated_lead (not member) role when requesting the live provider resource be deleted', async () => {
    workspaceAccessService.assertProjectRole.mockImplementation(
      (_projectId: string, _userId: string, roles: string[]) => {
        if (!roles.includes('member')) {
          return Promise.reject(
            new Error('Forbidden: requires admin or delegated_lead role'),
          );
        }
        return Promise.resolve({
          workspaceId: 'workspace-1',
          userId: 'user-1',
          role: 'member',
        });
      },
    );
    // No findDeploymentTargetForUser mock is queued here: access is denied
    // in assertProjectMutationAccess before the target row is ever loaded,
    // so queuing an unused mockResolvedValueOnce would leak into (and
    // desync) the next test's queue.

    await expect(
      service.detachDeploymentTarget('project-1', 'target-1', 'user-1', {
        deleteProviderResource: true,
      }),
    ).rejects.toThrow('Forbidden: requires admin or delegated_lead role');

    expect(workspaceAccessService.assertProjectRole).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      ['admin', 'delegated_lead'],
    );
    expect(
      deploymentTargetsRepository.deleteDeploymentTargetForUser,
    ).not.toHaveBeenCalled();
  });

  it('allows deleteProviderResource for admin/delegated_lead roles and deletes the live resource', async () => {
    const renderClient = {
      deleteTarget: jest.fn().mockResolvedValue({ deleted: true }),
    };
    clientRegistry.getClient.mockReturnValue(renderClient);
    deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
      {
        id: 'target-1',
        projectId: 'project-1',
        provider: 'render',
        providerProjectId: 'srv-1',
        providerProjectName: 'orders-api-test',
        ownershipMode: 'flowci_managed',
        providerConnectionId: null,
      },
    );
    deploymentTargetsRepository.deleteDeploymentTargetForUser.mockResolvedValueOnce(
      true,
    );

    await expect(
      service.detachDeploymentTarget('project-1', 'target-1', 'user-1', {
        deleteProviderResource: true,
      }),
    ).resolves.toEqual({ detached: true, providerResourceDeleted: true });

    expect(workspaceAccessService.assertProjectRole).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      ['admin', 'delegated_lead'],
    );
    expect(renderClient.deleteTarget).toHaveBeenCalledWith({
      token: 'render-token',
      targetId: 'srv-1',
    });
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          deleteProviderResourceRequested: true,
          providerResourceDeleted: true,
        }),
      }),
    );
  });

  it('deletes every tracked provider resource for a project and reports failures without throwing', async () => {
    const renderClient = {
      deleteTarget: jest.fn().mockResolvedValue({ deleted: true }),
    };
    const failingVercelClient = {
      deleteTarget: jest
        .fn()
        .mockRejectedValue(new Error('Vercel API is down')),
    };
    clientRegistry.getClient.mockImplementation((provider: string) =>
      provider === 'render' ? renderClient : failingVercelClient,
    );
    deploymentTargetsRepository.listDeploymentTargets.mockResolvedValueOnce([
      {
        id: 'target-1',
        provider: 'render',
        providerProjectId: 'srv-1',
        providerProjectName: 'orders-api',
        ownershipMode: 'flowci_managed',
        providerConnectionId: null,
      },
      {
        id: 'target-2',
        provider: 'vercel',
        providerProjectId: 'prj-1',
        providerProjectName: 'orders-web',
        ownershipMode: 'flowci_managed',
        providerConnectionId: null,
      },
      {
        id: 'target-3',
        provider: 'render',
        providerProjectId: '  ',
        providerProjectName: 'never-created',
        ownershipMode: 'flowci_managed',
        providerConnectionId: null,
      },
    ]);

    await expect(
      service.deleteProviderResourcesForProject('project-1', 'user-1'),
    ).resolves.toEqual({
      deleted: [
        {
          targetId: 'target-1',
          provider: 'render',
          providerProjectName: 'orders-api',
        },
      ],
      failed: [
        {
          targetId: 'target-2',
          provider: 'vercel',
          providerProjectName: 'orders-web',
          message: 'Vercel API is down',
        },
      ],
    });

    expect(renderClient.deleteTarget).toHaveBeenCalledTimes(1);
    expect(renderClient.deleteTarget).toHaveBeenCalledWith({
      token: 'render-token',
      targetId: 'srv-1',
    });
    expect(failingVercelClient.deleteTarget).toHaveBeenCalledWith({
      token: 'flowci-vercel-token',
      targetId: 'prj-1',
    });
    expect(
      deploymentTargetsRepository.deleteDeploymentTargetForUser,
    ).not.toHaveBeenCalled();
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: 'deployment_provider_resources_deleted',
      }),
    );
  });

  it('still detaches locally and reports a providerDeleteError when the live provider delete fails', async () => {
    const renderClient = {
      deleteTarget: jest
        .fn()
        .mockRejectedValue(new Error('Render API is down')),
    };
    clientRegistry.getClient.mockReturnValue(renderClient);
    deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
      {
        id: 'target-1',
        projectId: 'project-1',
        provider: 'render',
        providerProjectId: 'srv-1',
        providerProjectName: 'orders-api-test',
        ownershipMode: 'flowci_managed',
        providerConnectionId: null,
      },
    );
    deploymentTargetsRepository.deleteDeploymentTargetForUser.mockResolvedValueOnce(
      true,
    );

    await expect(
      service.detachDeploymentTarget('project-1', 'target-1', 'user-1', {
        deleteProviderResource: true,
      }),
    ).resolves.toEqual({
      detached: true,
      providerResourceDeleted: false,
      providerDeleteError: 'Render API is down',
    });

    expect(
      deploymentTargetsRepository.deleteDeploymentTargetForUser,
    ).toHaveBeenCalledWith('project-1', 'target-1', 'user-1');
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          deleteProviderResourceRequested: true,
          providerResourceDeleted: false,
          providerDeleteError: 'Render API is down',
        }),
      }),
    );
  });

  it('reports the sync capability mode as provider_live when a provider project id is tracked', async () => {
    deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
      {
        id: 'target-1',
        projectId: 'project-1',
        provider: 'vercel',
        providerProjectId: 'prj_1',
        providerProjectName: 'orders-web',
        providerMetadata: { vercelTeamSlug: 'flowci-team' },
      },
    );

    await expect(
      service.getDeploymentTargetActions('project-1', 'target-1', 'user-1'),
    ).resolves.toMatchObject({
      targetId: 'target-1',
      actions: {
        sync: { enabled: true, mode: 'provider_live' },
        detach: { enabled: true },
        reinstallDeploymentSecrets: {
          enabled: false,
          reason: 'Provider activation required',
        },
        openProviderDashboard: {
          enabled: true,
          url: 'https://vercel.com/flowci-team/orders-web',
        },
        openProviderConsole: {
          enabled: true,
          url: 'https://vercel.com/flowci-team/orders-web/deployments',
        },
      },
    });
  });

  it('reports the sync capability mode as local_metadata when no provider project id is tracked', async () => {
    deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
      {
        id: 'target-1',
        projectId: 'project-1',
        provider: 'vercel',
        providerProjectId: '',
        providerProjectName: 'orders-web',
        providerMetadata: {},
      },
    );

    await expect(
      service.getDeploymentTargetActions('project-1', 'target-1', 'user-1'),
    ).resolves.toMatchObject({
      actions: {
        sync: { enabled: true, mode: 'local_metadata' },
      },
    });
  });

  it('reports provider_live sync with no findings when the live resource exists', async () => {
    const renderClient = {
      getTargetStatus: jest.fn().mockResolvedValue({
        exists: true,
        url: 'https://orders-api-test.onrender.com',
      }),
    };
    clientRegistry.getClient.mockReturnValue(renderClient);
    deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
      {
        id: 'target-1',
        projectId: 'project-1',
        provider: 'render',
        ownershipMode: 'flowci_managed',
        providerConnectionId: null,
        providerProjectId: 'srv-1',
        providerProjectName: 'orders-api-test',
        branchName: 'test',
        rootDirectory: null,
        status: 'active',
        providerMetadata: {},
      },
    );

    await expect(
      service.syncDeploymentTarget('project-1', 'target-1', 'user-1'),
    ).resolves.toMatchObject({
      mode: 'provider_live',
      status: 'active',
      findings: [],
      target: {
        id: 'target-1',
      },
    });

    expect(renderClient.getTargetStatus).toHaveBeenCalledWith({
      token: 'render-token',
      targetId: 'srv-1',
    });
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        projectId: 'project-1',
        eventCode: 'deployment_target_synced',
      }),
    );
  });

  it('demotes status and reports an error finding when the live provider resource is missing', async () => {
    const renderClient = {
      getTargetStatus: jest.fn().mockResolvedValue({ exists: false }),
    };
    clientRegistry.getClient.mockReturnValue(renderClient);
    deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
      {
        id: 'target-1',
        projectId: 'project-1',
        provider: 'render',
        ownershipMode: 'flowci_managed',
        providerConnectionId: null,
        providerProjectId: 'srv-1',
        providerProjectName: 'orders-api-test',
        branchName: 'test',
        rootDirectory: null,
        status: 'active',
        providerMetadata: {},
      },
    );

    await expect(
      service.syncDeploymentTarget('project-1', 'target-1', 'user-1'),
    ).resolves.toMatchObject({
      mode: 'provider_live',
      status: 'missing',
      findings: [
        {
          code: 'provider_resource_missing',
          severity: 'error',
        },
      ],
    });
  });

  it('falls back to local metadata with a warning finding when the live provider check fails', async () => {
    deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
      {
        id: 'target-1',
        projectId: 'project-1',
        provider: 'render',
        providerProjectId: 'srv-1',
        providerProjectName: 'orders-api-test',
        branchName: 'test',
        rootDirectory: null,
        status: 'active',
        providerMetadata: {},
      },
    );

    // No ownershipMode/providerConnectionId on the target means
    // resolveProviderToken throws — this exercises the graceful fallback
    // just as a network-level failure from the provider client would.
    await expect(
      service.syncDeploymentTarget('project-1', 'target-1', 'user-1'),
    ).resolves.toMatchObject({
      mode: 'local_metadata',
      status: 'missing',
      findings: [
        {
          code: 'provider_live_check_failed',
          severity: 'warning',
        },
      ],
      target: {
        id: 'target-1',
      },
    });

    expect(vercelClient.createTarget).not.toHaveBeenCalled();
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        projectId: 'project-1',
        eventCode: 'deployment_target_synced',
      }),
    );
  });

  it('flags a missing provider project id as a local-only finding and skips the live check', async () => {
    deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
      {
        id: 'target-1',
        projectId: 'project-1',
        provider: 'render',
        ownershipMode: 'flowci_managed',
        providerConnectionId: null,
        providerProjectId: '',
        providerProjectName: 'orders-api-test',
        branchName: 'test',
        rootDirectory: null,
        status: 'active',
        providerMetadata: {},
      },
    );

    await expect(
      service.syncDeploymentTarget('project-1', 'target-1', 'user-1'),
    ).resolves.toMatchObject({
      mode: 'local_metadata',
      status: 'missing',
      findings: [
        {
          code: 'provider_project_id_missing',
          severity: 'warning',
        },
      ],
    });
    expect(clientRegistry.getClient).not.toHaveBeenCalled();
  });

  it('flags missing branch metadata as a local-only finding alongside a live check', async () => {
    const renderClient = {
      getTargetStatus: jest.fn().mockResolvedValue({ exists: true }),
    };
    clientRegistry.getClient.mockReturnValue(renderClient);
    deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
      {
        id: 'target-1',
        projectId: 'project-1',
        provider: 'render',
        ownershipMode: 'flowci_managed',
        providerConnectionId: null,
        providerProjectId: 'srv-1',
        providerProjectName: 'orders-api-test',
        branchName: '',
        rootDirectory: null,
        status: 'active',
        providerMetadata: {},
      },
    );

    await expect(
      service.syncDeploymentTarget('project-1', 'target-1', 'user-1'),
    ).resolves.toMatchObject({
      mode: 'provider_live',
      status: 'missing',
      findings: [
        {
          code: 'target_branch_missing',
          severity: 'warning',
        },
      ],
    });
  });

  it('enriches listed targets with the public service URL and dashboard URL', async () => {
    deploymentTargetsRepository.listDeploymentTargets.mockResolvedValue([
      {
        id: 'target-render',
        provider: 'render',
        providerProjectId: 'srv-123',
        providerProjectName: 'demo-backend-main',
        providerMetadata: {
          renderServiceUrl: 'https://demo-backend-main.onrender.com',
        },
      },
      {
        id: 'target-render-no-metadata',
        provider: 'render',
        providerProjectId: 'srv-456',
        providerProjectName: 'demo-backend-uat',
        providerMetadata: {},
      },
      {
        id: 'target-vercel',
        provider: 'vercel',
        providerProjectId: 'prj_1',
        providerProjectName: 'demo-frontend',
        providerMetadata: {},
      },
    ]);

    const targets = await service.listDeploymentTargets('project-1', 'user-1');

    expect(targets[0]).toMatchObject({
      publicUrl: 'https://demo-backend-main.onrender.com',
      dashboardUrl: 'https://dashboard.render.com/web/srv-123',
    });
    // Falls back to Render's naming convention when metadata has no URL.
    expect(targets[1]?.publicUrl).toBe('https://demo-backend-uat.onrender.com');
    expect(targets[2]).toMatchObject({
      publicUrl: 'https://demo-frontend.vercel.app',
    });
  });

  describe('getDeploymentTargetLogs', () => {
    const line = (overrides: Partial<Record<string, unknown>> = {}) => ({
      id: 'log-1',
      timestamp: '2026-07-12T00:00:00.000Z',
      message: 'hello',
      level: 'info',
      type: null,
      instance: null,
      labels: {},
      ...overrides,
    });

    it('returns live logs, including a genuinely empty result, when the provider call succeeds', async () => {
      deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
        {
          id: 'target-1',
          projectId: 'project-1',
          provider: 'vercel',
          ownershipMode: 'byo',
          providerConnectionId: 'connection-1',
          providerProjectId: 'prj_1',
          providerMetadata: {},
        },
      );
      const client = {
        queryLogs: jest
          .fn()
          .mockResolvedValue({ logs: [], hasMore: false, next: null }),
      };
      clientRegistry.getClient.mockReturnValue(client);

      await expect(
        service.getDeploymentTargetLogs('project-1', 'target-1', 'user-1'),
      ).resolves.toEqual({
        source: 'live',
        logs: [],
        hasMore: false,
        next: null,
        filters: ['level', 'type', 'text'],
      });
      expect(client.queryLogs).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'vercel-token', targetId: 'prj_1' }),
      );
    });

    it('passes filters and Render owner ID through to the client', async () => {
      deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
        {
          id: 'target-1',
          projectId: 'project-1',
          provider: 'render',
          ownershipMode: 'flowci_managed',
          providerConnectionId: null,
          providerProjectId: 'srv-1',
          providerMetadata: { renderOwnerId: 'owner-1' },
        },
      );
      const client = {
        queryLogs: jest.fn().mockResolvedValue({
          logs: [line()],
          hasMore: true,
          next: {
            startTime: '2026-07-12T00:00:00.000Z',
            endTime: '2026-07-13T00:00:00.000Z',
          },
        }),
      };
      clientRegistry.getClient.mockReturnValue(client);

      await expect(
        service.getDeploymentTargetLogs('project-1', 'target-1', 'user-1', {
          type: ['build'],
          startTime: '2026-07-11T00:00:00.000Z',
        }),
      ).resolves.toEqual({
        source: 'live',
        logs: [line()],
        hasMore: true,
        next: {
          startTime: '2026-07-12T00:00:00.000Z',
          endTime: '2026-07-13T00:00:00.000Z',
        },
        filters: ['level', 'type', 'text', 'instance'],
      });
      expect(client.queryLogs).toHaveBeenCalledWith({
        token: 'render-token',
        targetId: 'srv-1',
        type: ['build'],
        startTime: '2026-07-11T00:00:00.000Z',
        renderOwnerId: 'owner-1',
      });
    });

    it('reports unavailable with no lines when the provider call fails', async () => {
      deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
        {
          id: 'target-1',
          projectId: 'project-1',
          provider: 'render',
          ownershipMode: 'flowci_managed',
          providerConnectionId: null,
          providerProjectId: 'srv-1',
          providerMetadata: {},
        },
      );
      const client = {
        queryLogs: jest
          .fn()
          .mockRejectedValue(
            new Error(
              'Render owner ID is not linked to this target — run Sync to link it, then reopen logs.',
            ),
          ),
      };
      clientRegistry.getClient.mockReturnValue(client);

      const result = await service.getDeploymentTargetLogs(
        'project-1',
        'target-1',
        'user-1',
      );
      expect(result).toEqual({
        source: 'unavailable',
        reason:
          'Render owner ID is not linked to this target — run Sync to link it, then reopen logs.',
        logs: [],
        hasMore: false,
        next: null,
        filters: ['level', 'type', 'text', 'instance'],
      });
    });

    it('reports unavailable when the provider client does not support live logs', async () => {
      deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
        {
          id: 'target-1',
          projectId: 'project-1',
          provider: 'render',
          ownershipMode: 'flowci_managed',
          providerConnectionId: null,
          providerProjectId: 'srv-1',
          providerMetadata: {},
        },
      );
      clientRegistry.getClient.mockReturnValue({});

      const result = await service.getDeploymentTargetLogs(
        'project-1',
        'target-1',
        'user-1',
      );
      expect(result.source).toBe('unavailable');
      expect(result.reason).toContain('not supported');
      expect(result.logs).toEqual([]);
    });

    it('reports simulated mock logs, without touching the provider, when live providers are disabled', async () => {
      deploymentTargetsRepository.findDeploymentTargetForUser.mockResolvedValueOnce(
        {
          id: 'target-1',
          projectId: 'project-1',
          provider: 'render',
          ownershipMode: 'flowci_managed',
          providerConnectionId: null,
          providerProjectId: 'srv-1',
          providerMetadata: {},
        },
      );
      const client = { queryLogs: jest.fn() };
      clientRegistry.getClient.mockReturnValue(client);
      configService.getOrThrow.mockReturnValue({
        envProvisioning: { flowciManaged: {} },
        deploymentHistory: { liveProvidersEnabled: false },
      });

      const result = await service.getDeploymentTargetLogs(
        'project-1',
        'target-1',
        'user-1',
      );
      expect(result.source).toBe('simulated');
      expect(result.hasMore).toBe(false);
      expect(result.next).toBeNull();
      expect(result.logs.length).toBeGreaterThan(0);
      // Every mock line must already be normalised to the response shape.
      for (const entry of result.logs) {
        expect(entry).toMatchObject({
          id: expect.any(String),
          timestamp: expect.any(String),
          message: expect.any(String),
          level: expect.stringMatching(/^(error|warn|info|debug)$/),
        });
      }
      expect(client.queryLogs).not.toHaveBeenCalled();
    });
  });
});
