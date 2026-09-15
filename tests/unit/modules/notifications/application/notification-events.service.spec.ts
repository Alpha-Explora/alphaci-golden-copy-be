import { NotificationEventsService } from '#modules/platform-ops/notifications/application/notification-events.service';
import type { NotificationsRepository } from '#modules/platform-ops/notifications/infrastructure/notifications.repository';

describe('NotificationEventsService', () => {
  const repository = {
    getPreferences: jest.fn(),
    createForUser: jest.fn(),
  } as unknown as jest.Mocked<NotificationsRepository>;
  const capabilityResolver = { deployment: jest.fn() };

  beforeEach(() => {
    jest.resetAllMocks();
    capabilityResolver.deployment.mockReturnValue(
      new Set(['platform.notifications']),
    );
    repository.getPreferences.mockResolvedValue({
      userId: 'user-1',
      inAppEnabled: true,
      emailEnabled: false,
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
  });

  it('does not create notifications when disabled', async () => {
    capabilityResolver.deployment.mockReturnValueOnce(new Set());
    const service = new NotificationEventsService(
      repository,
      capabilityResolver as never,
    );

    await service.record({
      userId: 'user-1',
      projectId: 'project-1',
      eventCode: 'quota_reached',
      title: 'Quota reached',
      body: 'Project quota reached.',
    });

    expect(repository.createForUser).not.toHaveBeenCalled();
  });

  it('does not create notifications when in-app preferences are disabled', async () => {
    repository.getPreferences.mockResolvedValueOnce({
      userId: 'user-1',
      inAppEnabled: false,
      emailEnabled: false,
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    const service = new NotificationEventsService(
      repository,
      capabilityResolver as never,
    );

    await service.record({
      userId: 'user-1',
      eventCode: 'quota_reached',
      title: 'Quota reached',
      body: 'Project quota reached.',
    });

    expect(repository.createForUser).not.toHaveBeenCalled();
  });

  it('creates notifications when enabled', async () => {
    const service = new NotificationEventsService(
      repository,
      capabilityResolver as never,
    );

    await service.record({
      userId: 'user-1',
      projectId: 'project-1',
      eventCode: 'quota_reached',
      title: 'Quota reached',
      body: 'Project quota reached.',
    });

    expect(repository.createForUser).toHaveBeenCalledWith({
      userId: 'user-1',
      projectId: 'project-1',
      eventCode: 'quota_reached',
      title: 'Quota reached',
      body: 'Project quota reached.',
    });
  });
});
