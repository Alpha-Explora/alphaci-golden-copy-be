import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';

import { DeploymentStrategyResolver } from '../domain/deployment-strategy.resolver';
import { DeploymentTargetsService } from './deployment-targets.service';

/**
 * Roll back from inside ALPHACI: who may, which deploys, what each provider
 * is asked, and what is recorded. Provider clients are mocks; their HTTP calls
 * are covered in provider-rollback.spec.ts.
 */
describe('DeploymentTargetsService rollback', () => {
  const projectReferenceLookup = {
    findProjectReference: jest.fn(),
    findProjectEnvironment: jest.fn(),
    listProjectEnvironments: jest.fn(),
  };
  const repository = {
    findDeploymentTargetForUser: jest.fn(),
    updateProviderMetadata: jest.fn(),
  };
  const connections = { findActiveProviderConnection: jest.fn() };
  const encryption = { decrypt: jest.fn() };
  const client = {
    getDeployHistory: jest.fn(),
    rollbackDeploy: jest.fn(),
    resumeDeploys: jest.fn(),
  };
  const clientRegistry = { getClient: jest.fn() };
  const configService = { get: jest.fn(), getOrThrow: jest.fn() };
  const capabilityResolver = { deployment: jest.fn() };
  const appRoleLookup = { findAppRole: jest.fn() };
  const audit = { recordProjectEvent: jest.fn() };
  const notifications = { record: jest.fn() };

  const renderTarget = {
    id: 'target-be',
    projectId: 'project-1',
    provider: 'render',
    ownershipMode: 'byo',
    providerConnectionId: 'connection-1',
    providerProjectId: 'srv-1',
    providerProjectName: 'orders-api',
    providerMetadata: { renderOwnerId: 'tea-1' },
  };
  const vercelTarget = {
    ...renderTarget,
    id: 'target-fe',
    provider: 'vercel',
    providerProjectId: 'prj_1',
    providerProjectName: 'orders-web',
    providerMetadata: {},
  };
  const renderHistory = [
    {
      id: 'dep-3',
      status: 'live',
      commitSha: 'c3c3c3c3',
      commitMessage: 'bad',
      environment: null,
    },
    {
      id: 'dep-2',
      status: 'deactivated',
      commitSha: 'b2b2b2b2',
      commitMessage: 'good',
      environment: null,
    },
  ];
  const vercelHistory = [
    {
      id: 'dpl_3',
      status: 'READY',
      commitSha: 'c3c3c3c3',
      commitMessage: 'bad',
      environment: 'production',
    },
    {
      id: 'dpl_2',
      status: 'READY',
      commitSha: 'b2b2b2b2',
      commitMessage: 'good',
      environment: 'production',
    },
  ];

  let service: DeploymentTargetsService;

  beforeEach(() => {
    jest.clearAllMocks();
    projectReferenceLookup.findProjectReference.mockResolvedValue({
      projectId: 'project-1',
      repoFullName: 'o/r',
    });
    connections.findActiveProviderConnection.mockImplementation(async () => ({
      id: 'connection-1',
      provider: repository.findDeploymentTargetForUser.mock.results.length
        ? (
            (await repository.findDeploymentTargetForUser.mock.results.at(-1)
              ?.value) as { provider: string }
          ).provider
        : 'render',
      encryptedToken: 'enc',
      metadata: {},
    }));
    encryption.decrypt.mockReturnValue('provider-token');
    clientRegistry.getClient.mockReturnValue(client);
    configService.getOrThrow.mockReturnValue({
      envProvisioning: { flowciManaged: {} },
    });
    capabilityResolver.deployment.mockReturnValue(
      new Set(['projects.target-management']),
    );
    appRoleLookup.findAppRole.mockResolvedValue('member');
    client.rollbackDeploy.mockResolvedValue({
      deployId: 'dep-new',
      status: 'created',
      holdsNewDeploys: false,
    });

    service = new DeploymentTargetsService(
      projectReferenceLookup,
      repository as never,
      connections as never,
      encryption as never,
      clientRegistry as never,
      configService as never,
      new DeploymentStrategyResolver(),
      undefined,
      undefined,
      undefined,
      audit as never,
      notifications as never,
      undefined,
      capabilityResolver as never,
      undefined,
      appRoleLookup as never,
    );
  });

  it('puts an earlier Render deploy back live, records who and why, and keeps no hold', async () => {
    repository.findDeploymentTargetForUser.mockResolvedValue(renderTarget);
    client.getDeployHistory.mockResolvedValue(renderHistory);

    await expect(
      service.rollbackDeploymentTarget('project-1', 'target-be', 'user-1', {
        deployId: 'dep-2',
        reason: ' checkout is broken ',
      }),
    ).resolves.toEqual({
      rolledBack: true,
      targetId: 'target-be',
      deployId: 'dep-new',
      status: 'created',
      rollback: null,
    });

    expect(client.rollbackDeploy).toHaveBeenCalledWith({
      token: 'provider-token',
      targetId: 'srv-1',
      deployId: 'dep-2',
    });
    expect(repository.updateProviderMetadata).not.toHaveBeenCalled();
    expect(audit.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        eventCode: 'deployment_target_rolled_back',
        message: 'orders-api rolled back to b2b2b2b',
        metadata: expect.objectContaining({
          deployId: 'dep-2',
          commitSha: 'b2b2b2b2',
          reason: 'checkout is broken',
        }),
      }),
    );
  });

  it('keeps the Vercel hold on the target until it is resumed', async () => {
    repository.findDeploymentTargetForUser.mockResolvedValue(vercelTarget);
    client.getDeployHistory.mockResolvedValue(vercelHistory);
    client.rollbackDeploy.mockResolvedValue({
      deployId: 'dpl_2',
      status: 'rolling_back',
      holdsNewDeploys: true,
    });

    const result = await service.rollbackDeploymentTarget(
      'project-1',
      'target-fe',
      'user-1',
      {
        deployId: 'dpl_2',
        reason: 'bad release',
      },
    );

    expect(result.rollback).toMatchObject({
      deployId: 'dpl_2',
      commitSha: 'b2b2b2b2',
      reason: 'bad release',
      rolledBackBy: 'user-1',
      holdsNewDeploys: true,
    });
    expect(repository.updateProviderMetadata).toHaveBeenCalledWith(
      'target-fe',
      {
        rollback: expect.objectContaining({
          deployId: 'dpl_2',
          holdsNewDeploys: true,
        }),
      },
    );
  });

  it('resumes a held Vercel target: the newest deploy goes live and the hold is cleared', async () => {
    repository.findDeploymentTargetForUser.mockResolvedValue({
      ...vercelTarget,
      providerMetadata: {
        keep: 1,
        rollback: {
          deployId: 'dpl_2',
          commitSha: 'b2b2b2b2',
          holdsNewDeploys: true,
        },
      },
    });
    client.resumeDeploys.mockResolvedValue({ deployId: 'dpl_5' });

    await expect(
      service.resumeDeploymentTargetDeploys('project-1', 'target-fe', 'user-1'),
    ).resolves.toEqual({
      resumed: true,
      targetId: 'target-fe',
      deployId: 'dpl_5',
    });
    expect(repository.updateProviderMetadata).toHaveBeenCalledWith(
      'target-fe',
      { keep: 1 },
    );
    expect(audit.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: 'deployment_target_rollback_resumed',
      }),
    );
  });

  it('refuses to resume a target that is not held', async () => {
    repository.findDeploymentTargetForUser.mockResolvedValue(vercelTarget);
    await expect(
      service.resumeDeploymentTargetDeploys('project-1', 'target-fe', 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(client.resumeDeploys).not.toHaveBeenCalled();
  });

  it.each(['lead', 'qa', null] as const)(
    'refuses %s: only Developers and admins manage hosting',
    async (role) => {
      appRoleLookup.findAppRole.mockResolvedValue(role);
      repository.findDeploymentTargetForUser.mockResolvedValue(renderTarget);
      await expect(
        service.rollbackDeploymentTarget('project-1', 'target-be', 'user-1', {
          deployId: 'dep-2',
          reason: 'broken',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(client.rollbackDeploy).not.toHaveBeenCalled();
    },
  );

  it('refuses the live deploy, a missing reason and a missing deploy before calling the provider', async () => {
    repository.findDeploymentTargetForUser.mockResolvedValue(renderTarget);
    client.getDeployHistory.mockResolvedValue(renderHistory);

    await expect(
      service.rollbackDeploymentTarget('project-1', 'target-be', 'user-1', {
        deployId: 'dep-3',
        reason: 'broken',
      }),
    ).rejects.toThrow(new ConflictException('That deploy is already live.'));
    await expect(
      service.rollbackDeploymentTarget('project-1', 'target-be', 'user-1', {
        deployId: 'dep-2',
        reason: '',
      }),
    ).rejects.toThrow(new BadRequestException('Say why you are rolling back.'));
    await expect(
      service.rollbackDeploymentTarget('project-1', 'target-be', 'user-1', {
        reason: 'broken',
      }),
    ).rejects.toThrow(
      new BadRequestException('Choose the deploy to put back.'),
    );
    expect(client.rollbackDeploy).not.toHaveBeenCalled();
  });

  it('offers Roll back in the actions only where the provider can do it, and Resume only while held', async () => {
    repository.findDeploymentTargetForUser.mockResolvedValueOnce({
      ...vercelTarget,
      providerMetadata: { rollback: { deployId: 'dpl_2' } },
    });
    await expect(
      service.getDeploymentTargetActions('project-1', 'target-fe', 'user-1'),
    ).resolves.toMatchObject({
      actions: { rollback: { enabled: true, resumable: true } },
    });

    clientRegistry.getClient.mockReturnValue({ getDeployHistory: jest.fn() });
    repository.findDeploymentTargetForUser.mockResolvedValueOnce(renderTarget);
    await expect(
      service.getDeploymentTargetActions('project-1', 'target-be', 'user-1'),
    ).resolves.toMatchObject({
      actions: { rollback: { enabled: false, resumable: false } },
    });
  });
});
