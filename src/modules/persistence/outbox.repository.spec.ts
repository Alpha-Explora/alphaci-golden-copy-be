import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { OutboxRepository } from './outbox.repository.js';
import { DatabaseService } from '../../kernel/db/database.service.js';

const makeDatabaseService = () =>
  ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
  }) as unknown as DatabaseService;

describe('OutboxRepository', () => {
  let repo: OutboxRepository;
  let db: DatabaseService;

  beforeEach(async () => {
    db = makeDatabaseService();
    const module: TestingModule = await Test.createTestingModule({
      providers: [OutboxRepository, { provide: DatabaseService, useValue: db }],
    }).compile();

    repo = module.get(OutboxRepository);
  });

  it('should be defined', () => {
    expect(repo).toBeDefined();
  });

  it('publishes an event via database query', async () => {
    await repo.publishLater({
      topic: 'user.signed_in',
      aggregateType: 'user',
      aggregateId: 'user-123',
      payload: { provider: 'github' },
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO outbox_events'),
      expect.arrayContaining(['user.signed_in', 'user', 'user-123']),
    );
  });

  it('swallows database errors and logs a warning', async () => {
    (db.query as jest.Mock).mockRejectedValueOnce(new Error('db error'));

    await expect(
      repo.publishLater({
        topic: 'test.event',
        aggregateType: 'test',
        aggregateId: 'id-1',
        payload: {},
      }),
    ).resolves.toBeUndefined();
  });
});
