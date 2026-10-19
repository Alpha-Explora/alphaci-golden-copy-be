import { NotificationsService } from './notifications.service';

it('suppresses live and HTTP notification snapshots for recipients who opted out', async () => {
  const repository = {
    isInAppEnabled: jest.fn().mockResolvedValue(false),
    listForUser: jest.fn(),
  };
  await expect(
    new NotificationsService(repository as never).listForUser('member'),
  ).resolves.toEqual({ enabled: false, items: [], unreadCount: 0 });
  expect(repository.isInAppEnabled).toHaveBeenCalledWith('member');
  expect(repository.listForUser).not.toHaveBeenCalled();
});
