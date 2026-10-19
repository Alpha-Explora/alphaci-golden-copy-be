import { NotificationRelayWorker } from './notification-relay.worker';

describe('fast notification delivery', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it('drains only notifications every second and stops on shutdown', async () => {
    const relay = {
      processNotificationEventsOnce: jest.fn().mockResolvedValue(1),
    };
    const worker = new NotificationRelayWorker(
      { isEnabled: () => true } as never,
      relay as never,
    );
    worker.onModuleInit();
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(relay.processNotificationEventsOnce).toHaveBeenCalledTimes(1);
    worker.onModuleDestroy();
    jest.advanceTimersByTime(15000);
    expect(relay.processNotificationEventsOnce).toHaveBeenCalledTimes(1);
  });
  it('does not overlap an unfinished notification pass', async () => {
    let done!: () => void;
    const relay = {
      processNotificationEventsOnce: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            done = resolve;
          }),
      ),
    };
    const worker = new NotificationRelayWorker(
      { isEnabled: () => true } as never,
      relay as never,
    );
    const first = worker.deliver();
    await worker.deliver();
    expect(relay.processNotificationEventsOnce).toHaveBeenCalledTimes(1);
    done();
    await first;
  });
});
