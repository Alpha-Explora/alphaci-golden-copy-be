import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { SubscriptionsRepository } from './subscriptions.repository.js';
import { DatabaseService } from '../../kernel/db/database.service.js';

const fakeRow = {
  plan: 'pro' as const,
  status: 'active' as const,
  provider: 'manual',
  updated_at: '2026-01-01T00:00:00Z',
  plan_code: 'pro_monthly',
  current_period_start: '2026-01-01T00:00:00Z',
  current_period_end: '2026-02-01T00:00:00Z',
  cancel_at_period_end: false,
  amount_php: 300,
  interval_unit: 'month' as const,
};

const makeDatabaseService = () => {
  const clientMock = {
    query: jest.fn().mockResolvedValue({ rows: [fakeRow] }),
    release: jest.fn(),
  };
  return {
    query: jest.fn().mockResolvedValue({ rows: [fakeRow] }),
    withClient: jest
      .fn()
      .mockImplementation(
        async (fn: (c: typeof clientMock) => Promise<unknown>) =>
          fn(clientMock),
      ),
    _clientMock: clientMock,
  } as unknown as DatabaseService & { _clientMock: typeof clientMock };
};

describe('SubscriptionsRepository', () => {
  let repo: SubscriptionsRepository;
  let db: ReturnType<typeof makeDatabaseService>;

  beforeEach(async () => {
    db = makeDatabaseService();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionsRepository,
        { provide: DatabaseService, useValue: db },
      ],
    }).compile();

    repo = module.get(SubscriptionsRepository);
  });

  it('should be defined', () => {
    expect(repo).toBeDefined();
  });

  describe('getCurrentByUserId', () => {
    it('returns mapped SubscriptionState when row exists', async () => {
      const result = await repo.getCurrentByUserId('user-1');

      expect(result).toMatchObject({
        plan: 'pro',
        status: 'active',
        planCode: 'pro_monthly',
        amountPhp: 300,
        interval: 'month',
      });
    });

    it('returns null when no row found', async () => {
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [] }) // ensurePlanCatalog seed query
        .mockResolvedValueOnce({ rows: [] }); // getCurrentByUserId query

      // Reset planSeedPromise to force re-seed
      const freshDb = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        withClient: jest.fn().mockResolvedValue(undefined),
      } as unknown as DatabaseService;

      const freshModule: TestingModule = await Test.createTestingModule({
        providers: [
          SubscriptionsRepository,
          { provide: DatabaseService, useValue: freshDb },
        ],
      }).compile();

      const freshRepo = freshModule.get(SubscriptionsRepository);
      const result = await freshRepo.getCurrentByUserId('user-missing');
      expect(result).toBeNull();
    });
  });

  describe('ensureDefaultFreeSubscription', () => {
    it('returns existing subscription if one exists', async () => {
      const result = await repo.ensureDefaultFreeSubscription('user-1');
      expect(result.plan).toBe('pro');
    });

    it('inserts free subscription when none exists', async () => {
      const freeRow = {
        ...fakeRow,
        plan: 'free' as const,
        plan_code: 'free',
        status: 'active' as const,
        amount_php: 0,
      };
      const freshDb = {
        // withClient is mocked to resolve without calling the inner fn, so
        // seedPlans() makes no db.query calls. Only 2 direct db.query calls happen:
        // the SELECT in getCurrentByUserId and the INSERT for the free subscription.
        query: jest
          .fn()
          .mockResolvedValueOnce({ rows: [] }) // getCurrentByUserId SELECT → null
          .mockResolvedValueOnce({ rows: [freeRow] }), // INSERT free subscription
        withClient: jest.fn().mockResolvedValue(undefined),
      } as unknown as DatabaseService;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SubscriptionsRepository,
          { provide: DatabaseService, useValue: freshDb },
        ],
      }).compile();

      const freshRepo = module.get(SubscriptionsRepository);
      const result = await freshRepo.ensureDefaultFreeSubscription('user-new');
      expect(result.plan).toBe('free');
      expect(result.status).toBe('active');

      const insertCall = (freshDb.query as jest.Mock).mock.calls.find(
        ([query]) =>
          typeof query === 'string' &&
          query.includes('INSERT INTO user_subscriptions'),
      );
      expect(insertCall?.[0]).toContain("VALUES ($1, 'free', 'free', 'active'");
    });
  });

  describe('activateMonthlyPlan', () => {
    it('returns activated subscription state', async () => {
      const result = await repo.activateMonthlyPlan(
        'user-1',
        'pro_monthly',
        300,
        'manual',
      );

      const insertCall = db._clientMock.query.mock.calls.find(
        ([query]) =>
          typeof query === 'string' &&
          query.includes('INSERT INTO user_subscriptions'),
      );

      expect(insertCall).toBeDefined();
      expect(insertCall?.[0]).toContain(
        "VALUES ($1, 'pro', $2, 'active', $3, $4",
      );
      expect(insertCall?.[1]).toEqual(['user-1', 'pro_monthly', 'manual', 300]);
      expect(result.plan).toBe('pro');
      expect(result.status).toBe('active');
    });

    it('rolls back and rethrows on error', async () => {
      // ensurePlanCatalog runs via withClient → clientMock.query (5 calls: BEGIN,
      // seedFree, seedPro, seedEnterprise, COMMIT). Pre-trigger it so the test-specific
      // mocks below are not consumed by seeding.
      await repo.getCurrentByUserId('seed-trigger');

      db._clientMock.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // UPDATE cancel existing
        .mockRejectedValueOnce(new Error('insert failed')); // INSERT fails

      await expect(
        repo.activateMonthlyPlan('user-1', 'pro_monthly', 300),
      ).rejects.toThrow('insert failed');
    });
  });

  describe('cancelCurrent', () => {
    it('returns canceled subscription state', async () => {
      const canceledRow = {
        ...fakeRow,
        status: 'canceled' as const,
        cancel_at_period_end: true,
      };
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [] }) // ensurePlanCatalog
        .mockResolvedValueOnce({ rows: [canceledRow] }); // UPDATE

      const result = await repo.cancelCurrent('user-1');
      expect(result.status).toBe('canceled');
    });

    it('falls back to ensureDefaultFreeSubscription when no row updated', async () => {
      const freeRow = {
        ...fakeRow,
        plan: 'free' as const,
        plan_code: 'free',
        status: 'active' as const,
      };
      // ensurePlanCatalog goes through withClient → clientMock.query, not db.query.
      // Only 3 db.query calls occur: the UPDATE, the fallback SELECT, and the fallback INSERT.
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [] }) // UPDATE returns no row
        .mockResolvedValueOnce({ rows: [] }) // getCurrentByUserId SELECT in fallback
        .mockResolvedValueOnce({ rows: [freeRow] }); // INSERT free in fallback

      const result = await repo.cancelCurrent('user-1');
      expect(result.plan).toBe('free');
      expect(result.status).toBe('active');
    });
  });
});
