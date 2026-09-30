import { NotFoundException } from '@nestjs/common';

import type { DatabaseService } from '#kernel/db/database.service';
import { NotificationsRepository } from '#modules/platform-ops/notifications/infrastructure/notifications.repository';

const makeDatabaseService = (query: jest.Mock) =>
  ({ query }) as unknown as DatabaseService;

describe('NotificationsRepository', () => {
  let query: jest.Mock;
  let repository: NotificationsRepository;

  beforeEach(() => {
    query = jest.fn();
    repository = new NotificationsRepository(makeDatabaseService(query));
  });

  it('lists notifications and computes unread count', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'notification-1',
          title: 'Workflow update',
          body: 'A workflow PR was created.',
          event_code: 'workflow_pr_created',
          read_at: null,
          created_at: new Date('2026-06-14T00:00:00.000Z'),
          project_id: 'project-1',
          delivery_project_id: 'delivery-1',
          group_id: 'group-1',
        },
        {
          id: 'notification-2',
          title: 'Deployment',
          body: 'Deployment completed.',
          event_code: 'deployment_completed',
          read_at: '2026-06-14T01:00:00.000Z',
          created_at: '2026-06-14T00:30:00.000Z',
          project_id: 'project-2',
          delivery_project_id: null,
          group_id: null,
        },
      ],
    });

    await expect(repository.listForUser('user-1')).resolves.toEqual({
      enabled: true,
      items: [
        {
          id: 'notification-1',
          title: 'Workflow update',
          body: 'A workflow PR was created.',
          eventCode: 'workflow_pr_created',
          readAt: null,
          createdAt: '2026-06-14T00:00:00.000Z',
          projectId: 'project-1',
          groupId: 'group-1',
          deliveryProjectId: 'delivery-1',
        },
        {
          id: 'notification-2',
          title: 'Deployment',
          body: 'Deployment completed.',
          eventCode: 'deployment_completed',
          readAt: '2026-06-14T01:00:00.000Z',
          createdAt: '2026-06-14T00:30:00.000Z',
          projectId: 'project-2',
          groupId: null,
          deliveryProjectId: null,
        },
      ],
      unreadCount: 1,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM notifications.notifications'),
      ['user-1'],
    );
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('LEFT JOIN hierarchy.repositories');
    expect(sql).toContain('hr.provisioned_project_id = n.project_id');
  });

  it('returns null ids for a notification with no project or an unfiled one', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'n-1',
          title: 't',
          body: 'b',
          event_code: 'x',
          read_at: null,
          created_at: '2026-06-14T00:00:00.000Z',
          project_id: null,
          delivery_project_id: null,
          group_id: null,
        },
        {
          id: 'n-2',
          title: 't',
          body: 'b',
          event_code: 'x',
          read_at: null,
          created_at: '2026-06-14T00:00:00.000Z',
          project_id: 'project-9',
          delivery_project_id: undefined,
          group_id: undefined,
        },
      ],
    });

    const { items } = await repository.listForUser('user-1');

    expect(
      items.map((i) => [i.projectId, i.groupId, i.deliveryProjectId]),
    ).toEqual([
      [null, null, null],
      ['project-9', null, null],
    ]);
  });

  it('marks a notification read for the owning user', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'notification-1' }] });

    await expect(
      repository.markRead('user-1', 'notification-1'),
    ).resolves.toEqual({ id: 'notification-1', read: true });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SET read_at = COALESCE(read_at, NOW())'),
      ['notification-1', 'user-1'],
    );
  });

  it('throws when a notification is not found for the user', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(repository.markRead('user-1', 'missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('creates a notification for a user', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'notification-1',
          title: 'Quota reached',
          body: 'Project quota reached.',
          event_code: 'quota_reached',
          read_at: null,
          created_at: new Date('2026-06-15T00:00:00.000Z'),
        },
      ],
    });

    await expect(
      repository.createForUser({
        userId: 'user-1',
        projectId: 'project-1',
        eventCode: 'quota_reached',
        title: 'Quota reached',
        body: 'Project quota reached.',
      }),
    ).resolves.toMatchObject({
      id: 'notification-1',
      eventCode: 'quota_reached',
      readAt: null,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO notifications.notifications'),
      [
        'user-1',
        'project-1',
        'quota_reached',
        'Quota reached',
        'Project quota reached.',
      ],
    );
  });

  it('reads notification preferences, creating defaults first', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [
        {
          user_id: 'user-1',
          in_app_enabled: true,
          email_enabled: false,
          updated_at: new Date('2026-06-15T00:00:00.000Z'),
        },
      ],
    });

    await expect(repository.getPreferences('user-1')).resolves.toEqual({
      userId: 'user-1',
      inAppEnabled: true,
      emailEnabled: false,
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        'INSERT INTO notifications.notification_preferences',
      ),
      ['user-1'],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM notifications.notification_preferences'),
      ['user-1'],
    );
  });

  it('updates notification preferences with existing values as defaults', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            user_id: 'user-1',
            in_app_enabled: true,
            email_enabled: false,
            updated_at: '2026-06-15T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            user_id: 'user-1',
            in_app_enabled: false,
            email_enabled: false,
            updated_at: '2026-06-15T00:01:00.000Z',
          },
        ],
      });

    await expect(
      repository.updatePreferences('user-1', { inAppEnabled: false }),
    ).resolves.toMatchObject({
      userId: 'user-1',
      inAppEnabled: false,
      emailEnabled: false,
    });
    expect(query.mock.calls[2]?.[0]).toContain('ON CONFLICT (user_id)');
    expect(query.mock.calls[2]?.[1]).toEqual(['user-1', false, false]);
  });
});
