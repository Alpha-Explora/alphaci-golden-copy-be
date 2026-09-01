import { Logger } from '@nestjs/common';

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

  it('redacts bearer credentials when a best-effort write fails', async () => {
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const repository = new OutboxRepository({
      query: jest
        .fn()
        .mockRejectedValue(new Error('upstream rejected Bearer secret-token')),
    } as never);

    await expect(
      repository.publishBestEffort({
        topic: 'platform.audit.recorded',
        aggregateType: 'audit_event',
        aggregateId: 'project-1',
        payload: {},
      }),
    ).resolves.toBeUndefined();

    expect(warning).toHaveBeenCalledWith(
      'Outbox write skipped: upstream rejected Bearer [redacted]',
    );
    warning.mockRestore();
  });
});

describe('OutboxRepository.processPending', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('releases the claim transaction before invoking an external handler', async () => {
    let claimTransactionCompleted = false;
    const { client, databaseService } = createDatabaseService([testRow()]);
    databaseService.withTransaction = jest.fn(async (fn) => {
      const result = await fn(client);
      claimTransactionCompleted = true;
      return result;
    });
    const repository = new OutboxRepository(databaseService as never);
    const handler = jest.fn(async () => {
      expect(claimTransactionCompleted).toBe(true);
    });

    await expect(
      repository.processPending(handler, 1, ['platform.audit.recorded']),
    ).resolves.toBe(1);
  });

  it('claims rows with the active platform schema and a lease token', async () => {
    const { client, databaseService } = createDatabaseService([testRow()]);
    const repository = new OutboxRepository(databaseService as never);

    await repository.processPending(
      jest.fn().mockResolvedValue(undefined),
      50,
      ['platform.audit.recorded'],
    );

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM platform.outbox_events'),
      [1, ['platform.audit.recorded'], expect.any(String), 300],
    );
    expect(client.query.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(client.query.mock.calls[0][0]).toContain('lease_expires_at');
    expect(databaseService.query).toHaveBeenCalledWith(
      expect.stringContaining('published_at = NOW()'),
      ['event-1', expect.any(String)],
    );
    expect(databaseService.query.mock.calls[0][0]).not.toContain(
      'processed_at',
    );
    expect(client.query.mock.calls[0][0]).not.toContain('pg_try_advisory_lock');
  });

  it('limits selection to the topic set owned by the caller', async () => {
    const { client, databaseService } = createDatabaseService([]);
    const repository = new OutboxRepository(databaseService as never);

    await expect(
      repository.processPending(jest.fn().mockResolvedValue(undefined), 10, [
        'platform.audit.recorded',
      ]),
    ).resolves.toBe(0);

    expect(client.query.mock.calls[0][0]).toContain('topic = ANY($2::text[])');
    expect(client.query.mock.calls[0][1]).toEqual([
      1,
      ['platform.audit.recorded'],
      expect.any(String),
      300,
    ]);
  });

  it('does not claim rows when no owned topics are registered', async () => {
    const databaseService = {
      withTransaction: jest.fn(),
      query: jest.fn(),
    };
    const repository = new OutboxRepository(databaseService as never);

    await expect(
      repository.processPending(jest.fn().mockResolvedValue(undefined)),
    ).resolves.toBe(0);
    expect(databaseService.withTransaction).not.toHaveBeenCalled();
  });

  it('does not claim rows for unregistered topic strings', async () => {
    const databaseService = {
      withTransaction: jest.fn(),
      query: jest.fn(),
    };
    const repository = new OutboxRepository(databaseService as never);

    await expect(
      repository.processPending(jest.fn().mockResolvedValue(undefined), 10, [
        'workflow.generated',
      ]),
    ).resolves.toBe(0);
    expect(databaseService.withTransaction).not.toHaveBeenCalled();
  });

  it('rejects a lease that can expire before the handler timeout', async () => {
    const databaseService = {
      withTransaction: jest.fn(),
      query: jest.fn(),
    };
    const repository = new OutboxRepository(databaseService as never);

    await expect(
      repository.processPending(
        jest.fn().mockResolvedValue(undefined),
        10,
        ['platform.audit.recorded'],
        { leaseSeconds: 45, handlerTimeoutMs: 45_000 },
      ),
    ).rejects.toThrow(
      'OUTBOX_LEASE_SECONDS must be greater than OUTBOX_HANDLER_TIMEOUT_MS',
    );
    expect(databaseService.withTransaction).not.toHaveBeenCalled();
  });

  it('leaves failed rows pending and schedules a retry with backoff', async () => {
    const { databaseService } = createDatabaseService([
      testRow({ attempts: 2 }),
    ]);
    const repository = new OutboxRepository(databaseService as never);

    await expect(
      repository.processPending(
        jest.fn().mockRejectedValue(new Error('temporary downstream failure')),
        10,
        ['platform.audit.recorded'],
      ),
    ).resolves.toBe(0);

    expect(databaseService.query).toHaveBeenCalledWith(
      expect.stringContaining('available_at = NOW()'),
      ['event-1', 3, 60, 'temporary downstream failure', expect.any(String)],
    );
    expect(databaseService.query.mock.calls[0][0]).toContain(
      'lease_token = $5',
    );
  });

  it('quarantines a row after the configured attempts and records the failure', async () => {
    const { databaseService } = createDatabaseService([
      testRow({ attempts: 4 }),
    ]);
    const repository = new OutboxRepository(databaseService as never);

    await expect(
      repository.processPending(
        jest.fn().mockRejectedValue(new Error('terminal downstream failure')),
        10,
        ['platform.audit.recorded'],
        { maxAttempts: 5 },
      ),
    ).resolves.toBe(0);

    expect(databaseService.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'quarantined'"),
      ['event-1', 5, 'terminal downstream failure', expect.any(String)],
    );
    expect(databaseService.query.mock.calls[0][0]).toContain(
      'quarantined_at = NOW()',
    );
    expect(databaseService.query.mock.calls[0][0]).toContain(
      'lease_expires_at = NULL',
    );
  });

  it('propagates retry-state persistence failures instead of hiding them', async () => {
    const retryError = new Error('retry state database unavailable');
    const { databaseService } = createDatabaseService(
      [testRow()],
      undefined,
      retryError,
    );
    const repository = new OutboxRepository(databaseService as never);

    await expect(
      repository.processPending(
        jest.fn().mockRejectedValue(new Error('temporary downstream failure')),
        10,
        ['platform.audit.recorded'],
      ),
    ).rejects.toThrow('retry state database unavailable');
  });

  it('propagates acknowledgement persistence failures after the handler succeeds', async () => {
    const ackError = new Error('acknowledgement database unavailable');
    const { databaseService } = createDatabaseService(
      [testRow()],
      undefined,
      ackError,
    );
    const repository = new OutboxRepository(databaseService as never);

    await expect(
      repository.processPending(jest.fn().mockResolvedValue(undefined), 10, [
        'platform.audit.recorded',
      ]),
    ).rejects.toThrow('acknowledgement database unavailable');
  });

  it('records a bounded timeout as a handler failure', async () => {
    jest.useFakeTimers();
    const { databaseService } = createDatabaseService([testRow()]);
    const repository = new OutboxRepository(databaseService as never);
    const run = repository.processPending(
      () => new Promise<void>(() => undefined),
      10,
      ['platform.audit.recorded'],
      { handlerTimeoutMs: 5 },
    );

    await jest.advanceTimersByTimeAsync(5);
    await expect(run).resolves.toBe(0);
    expect(databaseService.query.mock.calls[0][1]).toEqual([
      'event-1',
      1,
      60,
      'Outbox handler timed out after 5ms for event-1',
      expect.any(String),
    ]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to the bounded default batch size for invalid limit %s',
    async (limit) => {
      const { client, databaseService } = createDatabaseService(
        Array.from({ length: 50 }, (_, index) =>
          testRow({ id: `event-${index}` }),
        ),
      );
      const repository = new OutboxRepository(databaseService as never);

      await expect(
        repository.processPending(
          jest.fn().mockResolvedValue(undefined),
          limit,
          ['platform.audit.recorded'],
        ),
      ).resolves.toBe(50);

      expect(client.query).toHaveBeenCalledTimes(50);
    },
  );
});

interface TestOutboxRow {
  id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  created_at: string;
  attempts: number;
}

function testRow(overrides: Partial<TestOutboxRow> = {}): TestOutboxRow {
  return {
    id: 'event-1',
    topic: 'platform.audit.recorded',
    aggregate_type: 'audit_event',
    aggregate_id: 'project-1',
    payload: { eventCode: 'project.updated' },
    created_at: '2026-08-27T00:00:00.000Z',
    attempts: 0,
    ...overrides,
  };
}

function createDatabaseService(
  rows: TestOutboxRow[],
  mutationResult: { rows: Array<{ id: string }> } = {
    rows: [{ id: 'event-1' }],
  },
  mutationError?: Error,
) {
  const pendingRows = [...rows];
  const client = {
    query: jest.fn().mockImplementation(async () => ({
      rows: pendingRows.splice(0, 1),
    })),
  };
  const databaseService = {
    withTransaction: jest.fn(
      async (fn: (value: typeof client) => Promise<unknown>) => fn(client),
    ),
    query: mutationError
      ? jest.fn().mockRejectedValue(mutationError)
      : jest.fn().mockResolvedValue(mutationResult),
  };
  return { client, databaseService };
}
