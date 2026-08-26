import { OutboxRelayService } from './outbox-relay.service';

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
    const service = new OutboxRelayService(
      { processPending } as never,
      auditEventsService as never,
      notificationEventsService as never,
    );

    await expect(service.processPendingOnce(10)).resolves.toBe(2);
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: 'project.updated' }),
    );
    expect(notificationEventsService.record).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
    );
  });
});
