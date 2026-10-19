import { UnauthorizedException } from '@nestjs/common';
import { NEVER } from 'rxjs';

import { NotificationsController } from '#modules/platform-ops/notifications/api/notifications.controller';
import { NotificationsService } from '#modules/platform-ops/notifications/application/notifications.service';
import type { NotificationStreamService } from '#modules/platform-ops/notifications/application/notification-stream.service';

describe('NotificationsController', () => {
  const makeService = () =>
    ({
      listForUser: jest.fn().mockResolvedValue({
        enabled: true,
        items: [
          {
            id: 'notification-1',
            title: 'Workflow update',
            body: 'A workflow update PR was created.',
            eventCode: 'workflow_pr_created',
            readAt: null,
            createdAt: '2026-06-14T00:00:00.000Z',
          },
        ],
        unreadCount: 1,
      }),
      markRead: jest
        .fn()
        .mockResolvedValue({ id: 'notification-1', read: true }),
      getPreferences: jest.fn().mockResolvedValue({
        userId: 'user-1',
        inAppEnabled: true,
        emailEnabled: false,
        updatedAt: '2026-06-15T00:00:00.000Z',
      }),
      updatePreferences: jest.fn().mockResolvedValue({
        userId: 'user-1',
        inAppEnabled: false,
        emailEnabled: false,
        updatedAt: '2026-06-15T00:01:00.000Z',
      }),
    }) as unknown as jest.Mocked<NotificationsService>;

  it('returns persisted notifications for the current user', async () => {
    const service = makeService();
    const controller = new NotificationsController(service);

    await expect(
      controller.list({ session: { user: { id: 'user-1' } } } as never),
    ).resolves.toEqual({
      userId: 'user-1',
      enabled: true,
      items: [
        {
          id: 'notification-1',
          title: 'Workflow update',
          body: 'A workflow update PR was created.',
          eventCode: 'workflow_pr_created',
          readAt: null,
          createdAt: '2026-06-14T00:00:00.000Z',
        },
      ],
      unreadCount: 1,
    });
    expect(service.listForUser).toHaveBeenCalledWith('user-1');
  });

  it('marks a notification read for an authenticated user', async () => {
    const service = makeService();
    const controller = new NotificationsController(service);

    await expect(
      controller.markRead(
        { session: { user: { id: 'user-1' } } } as never,
        'notification-1',
      ),
    ).resolves.toEqual({ id: 'notification-1', read: true });
    expect(service.markRead).toHaveBeenCalledWith('user-1', 'notification-1');
  });

  it('rejects unauthenticated notification requests', () => {
    const controller = new NotificationsController(makeService());

    expect(() => controller.list({ session: {} } as never)).toThrow(
      UnauthorizedException,
    );
  });

  it('uses the session recipient for streaming and stops after the session is revoked', async () => {
    jest.useFakeTimers();
    try {
      const streams = { open: jest.fn(() => NEVER), closed$: NEVER };
      const controller = new NotificationsController(
        makeService(),
        streams as unknown as NotificationStreamService,
      );
      const get = jest.fn(
        (
          _id: string,
          callback: (error: Error | null, session: null) => void,
        ) => {
          callback(null, null);
        },
      );
      const error = jest.fn();
      const subscription = controller
        .stream({
          session: { userId: 'member' },
          sessionID: 'session-id',
          sessionStore: { get },
        } as never)
        .subscribe({ error });
      expect(streams.open).toHaveBeenCalledWith('member');
      jest.advanceTimersByTime(15000);
      await Promise.resolve();
      await Promise.resolve();
      expect(get).toHaveBeenCalledWith('session-id', expect.any(Function));
      expect(error).toHaveBeenCalledWith(expect.any(UnauthorizedException));
      subscription.unsubscribe();
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns notification preferences for the current user', async () => {
    const service = makeService();
    const controller = new NotificationsController(service);

    await expect(
      controller.getPreferences({ session: { userId: 'user-1' } } as never),
    ).resolves.toMatchObject({
      userId: 'user-1',
      inAppEnabled: true,
    });
    expect(service.getPreferences).toHaveBeenCalledWith('user-1');
  });

  it('updates notification preferences for the current user', async () => {
    const service = makeService();
    const controller = new NotificationsController(service);

    await expect(
      controller.updatePreferences({ session: { userId: 'user-1' } } as never, {
        inAppEnabled: false,
      }),
    ).resolves.toMatchObject({
      userId: 'user-1',
      inAppEnabled: false,
    });
    expect(service.updatePreferences).toHaveBeenCalledWith('user-1', {
      inAppEnabled: false,
    });
  });
});
