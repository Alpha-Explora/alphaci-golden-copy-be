import { AuditEventsService } from './audit-events.service';

describe('AuditEventsService', () => {
  const repository = {
    createDeploymentGlobal: jest.fn(),
    listByProjectForUser: jest.fn(),
  };
  const capabilityResolver = { deployment: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    capabilityResolver.deployment.mockReturnValue(
      new Set(['platform.audit-events']),
    );
  });

  it('does not write audit rows when audit is disabled', async () => {
    capabilityResolver.deployment.mockReturnValueOnce(new Set());
    const service = new AuditEventsService(
      repository as never,
      capabilityResolver as never,
    );

    await service.record({
      actorUserId: 'user-1',
      projectId: 'project-1',
      eventCode: 'workflow_pr_created',
      message: 'Workflow update PR created',
      metadata: { pullRequestNumber: 42 },
    });

    expect(repository.createDeploymentGlobal).not.toHaveBeenCalled();
  });

  it('writes audit rows when audit is enabled', async () => {
    const service = new AuditEventsService(
      repository as never,
      capabilityResolver as never,
    );

    await service.record({
      actorUserId: 'user-1',
      projectId: 'project-1',
      eventCode: 'workflow_pr_created',
      message: 'Workflow update PR created',
      metadata: { pullRequestNumber: 42 },
    });

    expect(repository.createDeploymentGlobal).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      projectId: 'project-1',
      eventCode: 'workflow_pr_created',
      message: 'Workflow update PR created',
      metadata: { pullRequestNumber: 42 },
    });
  });

  it('does not throw when project event recording fails', async () => {
    repository.createDeploymentGlobal.mockRejectedValueOnce(
      new Error('database down'),
    );
    const service = new AuditEventsService(
      repository as never,
      capabilityResolver as never,
    );

    await expect(
      service.recordDeploymentGlobalProjectEvent({
        actorUserId: 'user-1',
        projectId: 'project-1',
        eventCode: 'workflow_pr_created',
        message: 'Workflow update PR created',
      }),
    ).resolves.toBeUndefined();
  });

  it('returns disabled audit list when audit is disabled', async () => {
    capabilityResolver.deployment.mockReturnValueOnce(new Set());
    const service = new AuditEventsService(
      repository as never,
      capabilityResolver as never,
    );

    await expect(
      service.listProjectEvents('project-1', 'user-1'),
    ).resolves.toEqual({ enabled: false, items: [] });
    expect(repository.listByProjectForUser).not.toHaveBeenCalled();
  });
});
