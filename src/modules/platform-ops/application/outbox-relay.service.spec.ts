import { OutboxRelayService } from './outbox-relay.service';
import { OutboxDispatcher } from '#kernel/events/outbox-dispatcher';

describe('OutboxRelayService', () => {
  it('routes audit and notification topics to their existing policy services', async () => {
    const processPending = jest.fn(
      async (handler: (event: unknown) => Promise<void>) => {
        await handler({
          id: 'audit-1',
          topic: 'platform.audit.recorded',
          aggregateType: 'audit_event',
          aggregateId: 'project-1',
          payload: {
            projectId: 'project-1',
            eventCode: 'project.updated',
            message: 'Project updated',
          },
          createdAt: '2026-08-27T00:00:00.000Z',
        });
        await handler({
          id: 'notification-1',
          topic: 'platform.notification.requested',
          aggregateType: 'notification',
          aggregateId: 'user-1',
          payload: {
            userId: 'user-1',
            eventCode: 'project.updated',
            title: 'Project updated',
            body: 'The project changed.',
          },
          createdAt: '2026-08-27T00:00:00.000Z',
        });
        return 2;
      },
    );
    const auditEventsService = {
      recordProjectEvent: jest.fn().mockResolvedValue(undefined),
    };
    const notificationEventsService = {
      record: jest.fn().mockResolvedValue(undefined),
    };
    const dispatcher = new OutboxDispatcher();
    const service = new OutboxRelayService(
      { processPending } as never,
      dispatcher,
      auditEventsService as never,
      notificationEventsService as never,
    );
    service.onModuleInit();

    await expect(service.processPendingOnce(10)).resolves.toBe(2);
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: 'project.updated' }),
    );
    expect(notificationEventsService.record).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
    );
  });

  it('passes bounded lease and handler timeout settings to the repository', async () => {
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      OUTBOX_LEASE_SECONDS: '90',
      OUTBOX_HANDLER_TIMEOUT_MS: '45000',
    };
    try {
      const processPending = jest.fn().mockResolvedValue(0);
      const service = new OutboxRelayService(
        { processPending } as never,
        new OutboxDispatcher(),
        { recordProjectEvent: jest.fn() } as never,
        { record: jest.fn() } as never,
      );
      service.onModuleInit();

      await service.processPendingOnce(10);

      expect(processPending).toHaveBeenCalledWith(
        expect.any(Function),
        10,
        expect.arrayContaining([
          'platform.audit.recorded',
          'platform.notification.requested',
        ]),
        {
          leaseSeconds: 90,
          handlerTimeoutMs: 45000,
        },
      );
    } finally {
      process.env = originalEnv;
    }
  });

  it('fails closed when the lease is not longer than the handler timeout', async () => {
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      OUTBOX_LEASE_SECONDS: '45',
      OUTBOX_HANDLER_TIMEOUT_MS: '45000',
    };
    try {
      const processPending = jest.fn().mockResolvedValue(0);
      const service = new OutboxRelayService(
        { processPending } as never,
        new OutboxDispatcher(),
        { recordProjectEvent: jest.fn() } as never,
        { record: jest.fn() } as never,
      );
      service.onModuleInit();

      await expect(service.processPendingOnce(10)).rejects.toThrow(
        'OUTBOX_LEASE_SECONDS must be greater than OUTBOX_HANDLER_TIMEOUT_MS',
      );
      expect(processPending).not.toHaveBeenCalled();
    } finally {
      process.env = originalEnv;
    }
  });
});
