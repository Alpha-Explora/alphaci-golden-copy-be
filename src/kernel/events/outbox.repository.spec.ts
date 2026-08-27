import { OutboxRepository } from './outbox.repository';

describe('OutboxRepository.publishInTransaction', () => {
  it('writes through the caller transaction instead of opening a second connection', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const databaseService = { query: jest.fn() };
    const repository = new OutboxRepository(databaseService as never);

    await repository.publishInTransaction(client as never, {
      topic: 'platform.audit.recorded',
      aggregateType: 'audit_event',
      aggregateId: 'project-1',
      payload: { eventCode: 'project.updated' },
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO platform.outbox_events'),
      [
        'platform.audit.recorded',
        'audit_event',
        'project-1',
        JSON.stringify({ eventCode: 'project.updated' }),
      ],
    );
    expect(databaseService.query).not.toHaveBeenCalled();
  });

  it('exposes a strict durable write for callers that need the failure', async () => {
    const databaseService = {
      query: jest.fn().mockRejectedValue(new Error('database unavailable')),
    };
    const repository = new OutboxRepository(databaseService as never);

    await expect(
      repository.publishDurably({
        topic: 'platform.audit.recorded',
        aggregateType: 'audit_event',
        aggregateId: 'project-1',
        payload: {},
      }),
    ).rejects.toThrow('database unavailable');
  });

  it('rejects an event topic that has no registered consumer', async () => {
    const client = { query: jest.fn() };
    const repository = new OutboxRepository({ query: jest.fn() } as never);

    await expect(
      repository.publishInTransaction(client as never, {
        topic: 'workflow.generated' as never,
        aggregateType: 'workflow',
        aggregateId: 'user-1',
        payload: {},
      }),
    ).rejects.toThrow("Unsupported outbox topic 'workflow.generated'");
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('OutboxRepository.processPending', () => {
  it('uses the active platform outbox schema when reading and publishing rows', async () => {
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
              attempts: 0,
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

    await repository.processPending(
      jest.fn().mockResolvedValue(undefined),
      50,
      ['platform.audit.recorded'],
    );

    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM platform.outbox_events'),
      expect.anything(),
    );
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('published_at = NOW()'),
      ['event-1'],
    );
    expect(client.query.mock.calls[2][0]).not.toContain('processed_at');
  });

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
              attempts: 0,
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

    await expect(
      repository.processPending(handler, 50, ['platform.audit.recorded']),
    ).resolves.toBe(1);
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

    await expect(
      repository.processPending(handler, 50, ['platform.audit.recorded']),
    ).resolves.toBe(0);
    expect(handler).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('limits selection to the topic set owned by the caller', async () => {
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ locked: true }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ unlocked: true }] }),
    };
    const databaseService = {
      withClient: jest.fn((fn: (value: typeof client) => Promise<number>) =>
        fn(client),
      ),
    };
    const repository = new OutboxRepository(databaseService as never);

    await expect(
      repository.processPending(
        jest.fn().mockResolvedValue(undefined),
        10,
        ['platform.audit.recorded'],
      ),
    ).resolves.toBe(0);

    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('topic = ANY($2::text[])'),
      [10, ['platform.audit.recorded']],
    );
  });

  it('leaves failed rows pending and schedules a retry with backoff', async () => {
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
              payload: {},
              created_at: '2026-08-27T00:00:00.000Z',
              attempts: 2,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ unlocked: true }] }),
    };
    const databaseService = {
      withClient: jest.fn((fn: (value: typeof client) => Promise<number>) =>
        fn(client),
      ),
    };
    const repository = new OutboxRepository(databaseService as never);

    await expect(
      repository.processPending(
        jest.fn().mockRejectedValue(new Error('temporary downstream failure')),
        10,
        ['platform.audit.recorded'],
      ),
    ).resolves.toBe(0);

    expect(client.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('attempts = attempts + 1'),
      ['event-1'],
    );
  });
});
