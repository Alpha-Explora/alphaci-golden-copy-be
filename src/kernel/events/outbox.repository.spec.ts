import { OutboxRepository } from './outbox.repository';

describe('OutboxRepository.processPending', () => {
  it('serially dispatches and marks rows while holding the relay lock', async () => {
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ locked: true }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'event-1',
              topic: 'platform.audit.recorded',
              aggregate_type: 'audit_event',
              aggregate_id: 'project-1',
              payload: { eventCode: 'project.updated' },
              created_at: '2026-08-27T00:00:00.000Z',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: 'event-1' }] })
        .mockResolvedValueOnce({ rows: [{ unlocked: true }] }),
    };
    const databaseService = {
      withClient: jest.fn((fn: (value: typeof client) => Promise<number>) =>
        fn(client),
      ),
    };
    const repository = new OutboxRepository(databaseService as never);
    const handler = jest.fn().mockResolvedValue(undefined);

    await expect(repository.processPending(handler)).resolves.toBe(1);
    expect(handler).toHaveBeenCalledWith({
      id: 'event-1',
      topic: 'platform.audit.recorded',
      aggregateType: 'audit_event',
      aggregateId: 'project-1',
      payload: { eventCode: 'project.updated' },
      createdAt: '2026-08-27T00:00:00.000Z',
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'published'"),
      ['event-1'],
    );
  });

  it('does not read rows when another relay owns the lock', async () => {
    const client = {
      query: jest.fn().mockResolvedValueOnce({ rows: [{ locked: false }] }),
    };
    const databaseService = {
      withClient: jest.fn((fn: (value: typeof client) => Promise<number>) =>
        fn(client),
      ),
    };
    const repository = new OutboxRepository(databaseService as never);
    const handler = jest.fn();

    await expect(repository.processPending(handler)).resolves.toBe(0);
    expect(handler).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
