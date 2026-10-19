import { NotificationStreamService } from './notification-stream.service';
import type { NotificationsService } from './notifications.service';

describe('recipient notification streams', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('completes active streams and releases polling timers during shutdown', () => {
    const hub = new NotificationStreamService({
      listForUser: jest.fn(),
    } as unknown as NotificationsService);
    const complete = jest.fn();
    hub.open('recipient').subscribe({ complete });
    hub.onModuleDestroy();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('shares reads for two tabs and emits a changed read state immediately on the next tick', async () => {
    const listForUser = jest
      .fn()
      .mockResolvedValue({ enabled: true, items: [], unreadCount: 1 });
    const hub = new NotificationStreamService({
      listForUser,
    } as unknown as NotificationsService);
    const first = jest.fn();
    const second = jest.fn();
    const a = hub.open('recipient').subscribe(first);
    const b = hub.open('recipient').subscribe(second);
    jest.advanceTimersByTime(0);
    await flush();
    expect(listForUser).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0]?.[0].data.userId).toBe('recipient');
    expect(second).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1000);
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    listForUser.mockResolvedValue({ enabled: true, items: [], unreadCount: 0 });
    jest.advanceTimersByTime(1000);
    await flush();
    expect(first).toHaveBeenCalledTimes(2);
    a.unsubscribe();
    b.unsubscribe();
    const calls = listForUser.mock.calls.length;
    jest.advanceTimersByTime(10000);
    await flush();
    expect(listForUser).toHaveBeenCalledTimes(calls);
  });

  it('keeps independent recipient readers and bounds connections', async () => {
    const listForUser = jest.fn().mockImplementation(async (id: string) => ({
      enabled: true,
      unreadCount: id === 'a' ? 1 : 9,
      items: [],
    }));
    const hub = new NotificationStreamService({
      listForUser,
    } as unknown as NotificationsService);
    const receiveA = jest.fn();
    const receiveB = jest.fn();
    const subscriptions = [
      hub.open('a').subscribe(receiveA),
      hub.open('b').subscribe(receiveB),
    ];
    for (let i = 0; i < 4; i++) subscriptions.push(hub.open('a').subscribe());
    const error = jest.fn();
    hub.open('a').subscribe({ error });
    expect(error).toHaveBeenCalled();
    jest.advanceTimersByTime(0);
    await flush();
    expect(receiveA.mock.calls[0]?.[0].data.notifications.unreadCount).toBe(1);
    expect(receiveB.mock.calls[0]?.[0].data.notifications.unreadCount).toBe(9);
    subscriptions.forEach((subscription) => subscription.unsubscribe());
  });
});
