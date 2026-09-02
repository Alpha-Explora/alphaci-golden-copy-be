import { NotFoundException } from '@nestjs/common';

import { ProjectCiRunsService } from './project-ci-runs.service';

describe('ProjectCiRunsService', () => {
  const projectRow = {
    id: 'project-1',
    repo_full_name: 'tone/orders-api',
    project_options: {
      workflowFiles: [
        {
          name: 'ALPHACI Quality',
          path: '.github/workflows/10-alphaci-quality.yml',
        },
      ],
    },
  };

  const projectsRepository = {
    findByIdAndUser: jest.fn(),
  };

  const provider = {
    listRuns: jest.fn(),
    getRun: jest.fn(),
  };

  const configService = {
    getOrThrow: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    projectsRepository.findByIdAndUser.mockResolvedValue(projectRow);
    provider.listRuns.mockResolvedValue([]);
    provider.getRun.mockResolvedValue(null);
    configService.getOrThrow.mockReturnValue({
      ciRunTracking: {
        enabled: true,
        liveGithubEnabled: false,
      },
    });
  });

  function createService() {
    return new ProjectCiRunsService(
      projectsRepository as never,
      provider as never,
      configService as never,
    );
  }

  it('handles empty local run lists without calling GitHub Actions', async () => {
    await expect(
      createService().listRuns('project-1', 'user-1'),
    ).resolves.toEqual({
      enabled: true,
      mode: 'local_mock',
      liveGithubEnabled: false,
      githubActionsUrl: 'https://github.com/tone/orders-api/actions',
      runs: [],
    });

    expect(provider.listRuns).toHaveBeenCalledWith({
      projectId: 'project-1',
      repoFullName: 'tone/orders-api',
      workflowFiles: [
        {
          name: 'ALPHACI Quality',
          path: '.github/workflows/10-alphaci-quality.yml',
        },
      ],
    });
  });

  it('returns fixture runs from the local provider', async () => {
    provider.listRuns.mockResolvedValueOnce([
      {
        id: 'local-project-1-quality',
        stage: 'quality',
        workflowName: 'ALPHACI Quality',
        branch: 'test',
        commitSha: 'abc123',
        actor: 'alphaci-local',
        status: 'completed',
        conclusion: 'failure',
        createdAt: '2026-06-12T00:00:00.000Z',
        updatedAt: '2026-06-12T00:05:00.000Z',
        htmlUrl:
          'https://github.com/tone/orders-api/actions/workflows/10-alphaci-quality.yml',
        canRerun: false,
      },
    ]);

    await expect(
      createService().listRuns('project-1', 'user-1'),
    ).resolves.toMatchObject({
      runs: [
        {
          id: 'local-project-1-quality',
          stage: 'quality',
          conclusion: 'failure',
          canRerun: false,
        },
      ],
    });
  });

  it('returns run detail from the local provider', async () => {
    provider.getRun.mockResolvedValueOnce({
      id: 'local-project-1-quality',
      stage: 'quality',
      workflowName: 'ALPHACI Quality',
      branch: 'test',
      commitSha: 'abc123',
      actor: 'alphaci-local',
      status: 'completed',
      conclusion: 'failure',
      createdAt: '2026-06-12T00:00:00.000Z',
      updatedAt: '2026-06-12T00:05:00.000Z',
      htmlUrl:
        'https://github.com/tone/orders-api/actions/workflows/10-alphaci-quality.yml',
      canRerun: false,
    });

    await expect(
      createService().getRun('project-1', 'local-project-1-quality', 'user-1'),
    ).resolves.toMatchObject({
      id: 'local-project-1-quality',
      stage: 'quality',
    });
  });

  it('rejects run detail for another user project', async () => {
    projectsRepository.findByIdAndUser.mockResolvedValueOnce(null);

    await expect(
      createService().getRun('project-1', 'run-1', 'user-2'),
    ).rejects.toThrow(NotFoundException);
  });

  it('returns disabled rerun with an accurate reason regardless of live-sync flags', async () => {
    await expect(
      createService().rerun('project-1', 'run-1', 'user-1'),
    ).resolves.toEqual({
      enabled: false,
      runId: 'run-1',
      reason:
        'Manual rerun requires a live GitHub Actions integration, which is not implemented yet.',
    });
  });

  it('reports liveGithubEnabled true when explicitly configured', async () => {
    configService.getOrThrow.mockReturnValue({
      ciRunTracking: {
        enabled: true,
        liveGithubEnabled: true,
      },
    });

    await expect(
      createService().listRuns('project-1', 'user-1'),
    ).resolves.toMatchObject({
      liveGithubEnabled: true,
    });
  });

  it('reports liveGithubEnabled false when explicitly disabled', async () => {
    configService.getOrThrow.mockReturnValue({
      ciRunTracking: {
        enabled: true,
        liveGithubEnabled: false,
      },
    });

    await expect(
      createService().listRuns('project-1', 'user-1'),
    ).resolves.toMatchObject({
      liveGithubEnabled: false,
    });
  });

  it('defaults liveGithubEnabled to true when configService is absent', async () => {
    const service = new ProjectCiRunsService(
      projectsRepository as never,
      provider as never,
    );

    await expect(
      service.listRuns('project-1', 'user-1'),
    ).resolves.toMatchObject({
      liveGithubEnabled: true,
    });
  });
});
