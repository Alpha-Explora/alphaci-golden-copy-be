import { NotFoundException } from '@nestjs/common';

import type { ProjectLinkPort } from '#kernel/ports/project-link.port';
import type { ProjectsRepository } from '../../infrastructure/projects.repository';
import { ProjectDashboardService } from './project-dashboard.service';

/**
 * The repository Audit tab: visibility is the same predicate as the rest of the
 * app (ProjectsRepository.findByIdAndUser), not "the repository's creator".
 */
describe('ProjectDashboardService.listProjectAuditEvents', () => {
  const repoRow = { id: 'repo-1', user_id: 'creator' };
  const event = {
    id: 'e1',
    workspaceId: 'ws-1',
    projectId: null,
    actorUserId: 'u1',
    actorLogin: 'octo',
    eventCode: 'qa.requirement.created',
    message: 'QA requirement "Login" created',
    metadata: { deliveryProjectId: 'dp-1' },
    createdAt: '2026-10-01T10:00:00.000000Z',
    scope: 'project' as const,
  };
  const folder = { deliveryProjectId: 'dp-1', groupId: 'g', name: 'P' };

  function build(options: {
    visibleTo?: string[];
    folder?: unknown;
    linkError?: Error;
  }) {
    const findByIdAndUser = jest.fn((id: string, userId: string) =>
      Promise.resolve(
        options.visibleTo?.includes(userId) && id === 'repo-1' ? repoRow : null,
      ),
    );
    const listProjectEvents = jest.fn().mockResolvedValue({
      enabled: true,
      items: [event],
      next: '2026-10-01T10:00:00.000000Z',
    });
    const getProjectFolder = jest.fn(() =>
      options.linkError
        ? Promise.reject(options.linkError)
        : Promise.resolve(options.folder ?? null),
    );
    const service = new ProjectDashboardService(
      { findByIdAndUser } as unknown as ProjectsRepository,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { getProjectFolder } as unknown as ProjectLinkPort,
      { listProjectEvents },
    );
    return { service, findByIdAndUser, listProjectEvents, getProjectFolder };
  }

  it.each([
    ['the creator', 'creator'],
    ['a Product owner on the team', 'lead-user'],
    ['QA on the team', 'qa-user'],
    ['another Developer on the team', 'dev-user'],
    ['an admin', 'admin-user'],
  ])('shows events to %s', async (_label, userId) => {
    const { service, listProjectEvents } = build({
      visibleTo: ['creator', 'lead-user', 'qa-user', 'dev-user', 'admin-user'],
      folder,
    });

    const result = await service.listProjectAuditEvents('repo-1', userId);

    expect(result).toEqual({
      enabled: true,
      items: [
        {
          id: 'e1',
          eventCode: 'qa.requirement.created',
          message: 'QA requirement "Login" created',
          actorUserId: 'u1',
          actorLogin: 'octo',
          metadata: { deliveryProjectId: 'dp-1' },
          createdAt: '2026-10-01T10:00:00.000000Z',
          scope: 'project',
        },
      ],
      next: '2026-10-01T10:00:00.000000Z',
    });
    expect(listProjectEvents).toHaveBeenCalledWith({
      projectId: 'repo-1',
      deliveryProjectId: 'dp-1',
      before: null,
    });
  });

  it('answers 404 and never queries audit for a caller who cannot see the repository', async () => {
    const { service, listProjectEvents, getProjectFolder } = build({
      visibleTo: ['creator'],
      folder,
    });

    await expect(
      service.listProjectAuditEvents('repo-1', 'outsider'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(listProjectEvents).not.toHaveBeenCalled();
    expect(getProjectFolder).not.toHaveBeenCalled();
  });

  it('resolves the Project through the folder lookup, so every sibling repository gets the same Project events', async () => {
    const { service, listProjectEvents, getProjectFolder } = build({
      visibleTo: ['dev-user'],
      folder,
    });

    await service.listProjectAuditEvents('repo-1', 'dev-user');

    expect(getProjectFolder).toHaveBeenCalledWith('repo-1');
    expect(listProjectEvents).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryProjectId: 'dp-1' }),
    );
  });

  it('uses no Project when the repository is not filed under one', async () => {
    const { service, listProjectEvents } = build({
      visibleTo: ['dev-user'],
      folder: null,
    });

    await service.listProjectAuditEvents('repo-1', 'dev-user');

    expect(listProjectEvents).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryProjectId: null }),
    );
  });

  it('degrades to repository-only events when the Project lookup fails', async () => {
    const { service, listProjectEvents } = build({
      visibleTo: ['dev-user'],
      linkError: new Error('hierarchy down'),
    });

    await expect(
      service.listProjectAuditEvents('repo-1', 'dev-user'),
    ).resolves.toMatchObject({ enabled: true });
    expect(listProjectEvents).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryProjectId: null }),
    );
  });

  it('forwards limit and the before cursor', async () => {
    const { service, listProjectEvents } = build({
      visibleTo: ['dev-user'],
      folder,
    });

    await service.listProjectAuditEvents('repo-1', 'dev-user', {
      limit: 20,
      before: '2026-10-01T09:00:00.000000Z',
    });

    expect(listProjectEvents).toHaveBeenCalledWith({
      projectId: 'repo-1',
      deliveryProjectId: 'dp-1',
      limit: 20,
      before: '2026-10-01T09:00:00.000000Z',
    });
  });

  it('reports the capability state when no audit port is wired', async () => {
    const service = new ProjectDashboardService({
      findByIdAndUser: jest.fn().mockResolvedValue(repoRow),
    } as unknown as ProjectsRepository);

    await expect(
      service.listProjectAuditEvents('repo-1', 'u'),
    ).resolves.toEqual({ enabled: false, items: [], next: null });
  });
});
