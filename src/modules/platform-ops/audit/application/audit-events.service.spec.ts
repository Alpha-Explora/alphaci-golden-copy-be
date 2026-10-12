import { AuditEventsService } from './audit-events.service';

describe('AuditEventsService', () => {
  const repository = {
    create: jest.fn(),
    listForProject: jest.fn(),
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

    expect(repository.create).not.toHaveBeenCalled();
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

    expect(repository.create).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      projectId: 'project-1',
      eventCode: 'workflow_pr_created',
      message: 'Workflow update PR created',
      metadata: { pullRequestNumber: 42 },
    });
  });

  it('does not throw when project event recording fails', async () => {
    repository.create.mockRejectedValueOnce(new Error('database down'));
    const service = new AuditEventsService(
      repository as never,
      capabilityResolver as never,
    );

    await expect(
      service.recordProjectEvent({
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
      service.listProjectEvents({ projectId: 'project-1' }),
    ).resolves.toEqual({ enabled: false, items: [], next: null });
    expect(repository.listForProject).not.toHaveBeenCalled();
  });

  describe('listProjectEvents paging', () => {
    const row = (n: number) => ({
      id: `event-${n}`,
      createdAt: `2026-06-14T00:00:0${n}.000000Z`,
      actorLogin: null,
      scope: 'repository',
    });

    it('passes the Project and cursor through and defaults to 50', async () => {
      repository.listForProject.mockResolvedValueOnce([]);
      const service = new AuditEventsService(
        repository as never,
        capabilityResolver as never,
      );

      await service.listProjectEvents({
        projectId: 'repo-1',
        deliveryProjectId: 'dp-1',
        before: '2026-06-14T00:00:00.000000Z',
      });

      expect(repository.listForProject).toHaveBeenCalledWith({
        projectId: 'repo-1',
        deliveryProjectId: 'dp-1',
        limit: 51,
        before: '2026-06-14T00:00:00.000000Z',
      });
    });

    it('clamps the limit to 100', async () => {
      repository.listForProject.mockResolvedValueOnce([]);
      const service = new AuditEventsService(
        repository as never,
        capabilityResolver as never,
      );

      await service.listProjectEvents({ projectId: 'repo-1', limit: 5000 });

      expect(repository.listForProject).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 101, deliveryProjectId: null }),
      );
    });

    it('returns a next cursor only when more rows exist', async () => {
      const service = new AuditEventsService(
        repository as never,
        capabilityResolver as never,
      );

      repository.listForProject.mockResolvedValueOnce([row(3), row(2), row(1)]);
      await expect(
        service.listProjectEvents({ projectId: 'repo-1', limit: 2 }),
      ).resolves.toEqual({
        enabled: true,
        items: [row(3), row(2)],
        next: row(2).createdAt,
      });

      repository.listForProject.mockResolvedValueOnce([row(3), row(2)]);
      await expect(
        service.listProjectEvents({ projectId: 'repo-1', limit: 2 }),
      ).resolves.toMatchObject({ next: null });
    });
  });
});

describe('AuditEventsService.findLatestProjectEventTimes', () => {
  const repository = { findLatestEventTimes: jest.fn() };
  const capabilityResolver = { deployment: jest.fn() };
  const lookups = [
    { projectId: 'p-api', since: '2026-10-03T08:00:00.000000Z' },
    { projectId: 'p-web', since: '2026-10-03T08:00:00.000000Z' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    capabilityResolver.deployment.mockReturnValue(
      new Set(['platform.audit-events']),
    );
  });

  it('asks the repository once for every lookup', async () => {
    repository.findLatestEventTimes.mockResolvedValue(
      new Map([['p-api', '2026-10-04T09:30:00.000000Z']]),
    );
    const service = new AuditEventsService(
      repository as never,
      capabilityResolver as never,
    );

    await expect(
      service.findLatestProjectEventTimes('qa.promotion.merged', lookups),
    ).resolves.toEqual(new Map([['p-api', '2026-10-04T09:30:00.000000Z']]));
    expect(repository.findLatestEventTimes).toHaveBeenCalledTimes(1);
    expect(repository.findLatestEventTimes).toHaveBeenCalledWith(
      'qa.promotion.merged',
      lookups,
    );
  });

  it('is null, not an empty answer, when audit recording is off', async () => {
    capabilityResolver.deployment.mockReturnValue(new Set());
    const service = new AuditEventsService(
      repository as never,
      capabilityResolver as never,
    );

    await expect(
      service.findLatestProjectEventTimes('qa.promotion.merged', lookups),
    ).resolves.toBeNull();
    expect(repository.findLatestEventTimes).not.toHaveBeenCalled();
  });

  it('skips the query when there is nothing to look up', async () => {
    const service = new AuditEventsService(
      repository as never,
      capabilityResolver as never,
    );

    await expect(
      service.findLatestProjectEventTimes('qa.promotion.merged', []),
    ).resolves.toEqual(new Map());
    expect(repository.findLatestEventTimes).not.toHaveBeenCalled();
  });
});
