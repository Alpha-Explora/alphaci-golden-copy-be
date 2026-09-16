import { ConflictException, NotFoundException } from '@nestjs/common';

import { ProjectLifecycleService } from './project-lifecycle.service';

describe('ProjectLifecycleService.disconnectProject external teardown', () => {
  const build = (
    overrides: {
      findByIdAndUser?: jest.Mock;
      deleteRepoForUser?: jest.Mock;
      teardownResult?: unknown;
      teardown?: null;
      sonarResult?: unknown;
    } = {},
  ) => {
    const calls: string[] = [];
    const projectsRepository = {
      findByIdAndUser:
        overrides.findByIdAndUser ??
        jest.fn().mockResolvedValue({
          id: 'project-1',
          repo_full_name: 'tone/orders-api',
        }),
      deleteByIdAndUser: jest.fn().mockImplementation(() => {
        calls.push('db-delete');
        return Promise.resolve(true);
      }),
    };
    const githubService = {
      deleteRepoForUser:
        overrides.deleteRepoForUser ??
        jest.fn().mockImplementation(() => {
          calls.push('github-delete');
          return Promise.resolve();
        }),
    };
    const teardown =
      overrides.teardown === null
        ? undefined
        : {
            deleteProviderResourcesForProject: jest
              .fn()
              .mockImplementation(() => {
                calls.push('provider-delete');
                return Promise.resolve(
                  overrides.teardownResult ?? {
                    deleted: [
                      {
                        targetId: 't-1',
                        provider: 'render',
                        providerProjectName: 'orders-api',
                      },
                      {
                        targetId: 't-2',
                        provider: 'vercel',
                        providerProjectName: 'orders-web',
                      },
                    ],
                    failed: [],
                  },
                );
              }),
          };
    const sonar = {
      deleteProject: jest.fn().mockImplementation(() => {
        calls.push('sonar-delete');
        return Promise.resolve(
          overrides.sonarResult ?? {
            status: 'deleted',
            sonarProjectKey: 'tone_orders-api',
          },
        );
      }),
    };
    const workspaceAccessService = {
      assertProjectRole: jest.fn().mockResolvedValue(undefined),
    };
    const auditEventsService = { recordProjectEvent: jest.fn() };

    const service = new ProjectLifecycleService(
      {} as never,
      projectsRepository as never,
      githubService as never,
      workspaceAccessService as never,
      auditEventsService as never,
      undefined,
      undefined,
      teardown as never,
      sonar as never,
    );
    return {
      service,
      calls,
      projectsRepository,
      teardown,
      sonar,
      workspaceAccessService,
      auditEventsService,
    };
  };

  const everything = {
    deleteGithubRepo: true,
    confirmRepoName: 'tone/orders-api',
    deleteProviderResources: true,
    deleteSonarProject: true,
  };

  it('leaves external resources alone by default', async () => {
    const { service, teardown, sonar, workspaceAccessService } = build();

    await expect(
      service.disconnectProject('project-1', 'user-1'),
    ).resolves.toEqual({ ok: true, githubRepoDeleted: false });

    expect(teardown?.deleteProviderResourcesForProject).not.toHaveBeenCalled();
    expect(sonar.deleteProject).not.toHaveBeenCalled();
    expect(workspaceAccessService.assertProjectRole).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      ['admin', 'delegated_lead', 'member'],
    );
  });

  it('deletes GitHub, then deployments, then SonarCloud, then the project row', async () => {
    const { service, calls, projectsRepository, workspaceAccessService } =
      build();

    await expect(
      service.disconnectProject('project-1', 'user-1', everything, 'gh-token'),
    ).resolves.toEqual({
      ok: true,
      githubRepoDeleted: true,
      providerResourcesDeleted: 2,
      sonarProjectDeleted: true,
    });

    expect(calls).toEqual([
      'github-delete',
      'provider-delete',
      'sonar-delete',
      'db-delete',
    ]);
    expect(workspaceAccessService.assertProjectRole).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      ['admin', 'delegated_lead'],
    );
    expect(projectsRepository.deleteByIdAndUser).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      ['admin', 'delegated_lead'],
    );
  });

  it('touches nothing else when the typed repo name does not match', async () => {
    const { service, calls } = build();

    await expect(
      service.disconnectProject(
        'project-1',
        'user-1',
        { ...everything, confirmRepoName: 'tone/typo' },
        'gh-token',
      ),
    ).rejects.toThrow('confirmRepoName does not match');

    expect(calls).toEqual([]);
  });

  it('touches nothing else when GitHub refuses', async () => {
    const { service, calls } = build({
      deleteRepoForUser: jest.fn().mockRejectedValue(new Error('403')),
    });

    await expect(
      service.disconnectProject('project-1', 'user-1', everything, 'gh-token'),
    ).rejects.toThrow(ConflictException);

    expect(calls).toEqual([]);
  });

  it('keeps the project when a deployment could not be deleted', async () => {
    const { service, calls, sonar } = build({
      teardownResult: {
        deleted: [],
        failed: [
          {
            targetId: 't-2',
            provider: 'vercel',
            providerProjectName: 'orders-web',
            message: 'Vercel API is down',
          },
        ],
      },
    });

    const error = await service
      .disconnectProject('project-1', 'user-1', everything, 'gh-token')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    const body = (error as ConflictException).getResponse() as {
      code: string;
      message: string;
    };
    expect(body.code).toBe('provider_delete_failed');
    expect(body.message).toContain('vercel orders-web: Vercel API is down');
    expect(body.message).toContain('untick "also delete on GitHub"');
    expect(calls).toEqual(['github-delete', 'provider-delete']);
    expect(sonar.deleteProject).not.toHaveBeenCalled();
  });

  it('keeps the project when the SonarCloud delete fails', async () => {
    const { service, calls, auditEventsService } = build({
      sonarResult: {
        status: 'failed',
        sonarProjectKey: 'tone_orders-api',
        message: 'SonarCloud is down',
      },
    });

    const error = await service
      .disconnectProject('project-1', 'user-1', { deleteSonarProject: true })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    const body = (error as ConflictException).getResponse() as {
      code: string;
      message: string;
    };
    expect(body.code).toBe('sonar_delete_failed');
    expect(body.message).toContain('SonarCloud is down');
    expect(body.message).not.toContain('GitHub');
    expect(calls).toEqual(['sonar-delete']);
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: 'project_sonar_project_delete_failed',
      }),
    );
  });

  it('disconnects when the SonarCloud project never existed', async () => {
    const { service, projectsRepository } = build({
      sonarResult: { status: 'not_found', sonarProjectKey: 'tone_orders-api' },
    });

    await expect(
      service.disconnectProject('project-1', 'user-1', {
        deleteSonarProject: true,
      }),
    ).resolves.toEqual({
      ok: true,
      githubRepoDeleted: false,
      sonarProjectDeleted: false,
    });
    expect(projectsRepository.deleteByIdAndUser).toHaveBeenCalled();
  });

  it('keeps the project when deployment teardown is not wired', async () => {
    const { service, projectsRepository } = build({ teardown: null });

    await expect(
      service.disconnectProject('project-1', 'user-1', {
        deleteProviderResources: true,
      }),
    ).rejects.toThrow(ConflictException);
    expect(projectsRepository.deleteByIdAndUser).not.toHaveBeenCalled();
  });

  it('refuses before any external call when the role-scoped lookup finds nothing', async () => {
    const { service, calls } = build({
      findByIdAndUser: jest.fn().mockResolvedValue(null),
    });

    await expect(
      service.disconnectProject('project-1', 'user-1', {
        deleteProviderResources: true,
        deleteSonarProject: true,
      }),
    ).rejects.toThrow(NotFoundException);

    expect(calls).toEqual([]);
  });
});
