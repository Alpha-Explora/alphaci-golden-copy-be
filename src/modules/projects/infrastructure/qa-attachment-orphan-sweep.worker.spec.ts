import type { ConfigService } from '@nestjs/config';

import type { DatabaseService } from '#kernel/db/database.service.js';
import {
  QA_ORPHAN_SWEEP_MAX_PASSES_PER_TICK,
  QaAttachmentOrphanSweepWorker,
} from './qa-attachment-orphan-sweep.worker';
import {
  type PostgresQaAttachmentOrphanSweep,
  QA_ORPHAN_SWEEP_BATCH_SIZE,
} from './qa-attachment-orphan-sweep.postgres';

function setup(options: {
  driver?: 'postgres' | 'supabase';
  enabled?: boolean;
  passes?: Array<number | null>;
}) {
  const config = {
    getOrThrow: jest.fn().mockReturnValue({
      storage: { driver: options.driver ?? 'postgres' },
    }),
  } as unknown as ConfigService;
  const database = {
    isEnabled: jest.fn().mockReturnValue(options.enabled ?? true),
  } as unknown as DatabaseService;
  const sweepOnce = jest.fn();
  for (const pass of options.passes ?? []) {
    sweepOnce.mockResolvedValueOnce(pass);
  }
  const sweep = { sweepOnce } as unknown as PostgresQaAttachmentOrphanSweep;
  const worker = new QaAttachmentOrphanSweepWorker(config, database, sweep);
  return { worker, sweepOnce };
}

describe('QaAttachmentOrphanSweepWorker', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('schedules nothing on the supabase driver', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const { worker } = setup({ driver: 'supabase' });

    worker.onModuleInit();

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('schedules nothing when no database is configured', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const { worker } = setup({ enabled: false });

    worker.onModuleInit();

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('schedules a sweep on the postgres driver and clears it on destroy', () => {
    jest.useFakeTimers();
    const { worker, sweepOnce } = setup({ passes: [0] });

    worker.onModuleInit();
    jest.advanceTimersByTime(15 * 60 * 1000);
    expect(sweepOnce).toHaveBeenCalledTimes(1);

    worker.onModuleDestroy();
    jest.advanceTimersByTime(60 * 60 * 1000);
    expect(sweepOnce).toHaveBeenCalledTimes(1);
  });

  it('drains batches until a short batch comes back', async () => {
    const { worker, sweepOnce } = setup({
      passes: [QA_ORPHAN_SWEEP_BATCH_SIZE, QA_ORPHAN_SWEEP_BATCH_SIZE, 7],
    });

    await expect(worker.sweepOrphans()).resolves.toBe(
      QA_ORPHAN_SWEEP_BATCH_SIZE * 2 + 7,
    );
    expect(sweepOnce).toHaveBeenCalledTimes(3);
    expect(sweepOnce).toHaveBeenCalledWith(QA_ORPHAN_SWEEP_BATCH_SIZE);
  });

  it('stops after the per-tick pass cap even when every batch is full', async () => {
    const { worker, sweepOnce } = setup({
      passes: Array.from(
        { length: QA_ORPHAN_SWEEP_MAX_PASSES_PER_TICK + 5 },
        () => QA_ORPHAN_SWEEP_BATCH_SIZE,
      ),
    });

    await worker.sweepOrphans();

    expect(sweepOnce).toHaveBeenCalledTimes(
      QA_ORPHAN_SWEEP_MAX_PASSES_PER_TICK,
    );
  });

  it('stops at once when another replica holds the lock', async () => {
    const { worker, sweepOnce } = setup({
      passes: [QA_ORPHAN_SWEEP_BATCH_SIZE, null],
    });

    await expect(worker.sweepOrphans()).resolves.toBe(
      QA_ORPHAN_SWEEP_BATCH_SIZE,
    );
    expect(sweepOnce).toHaveBeenCalledTimes(2);
  });

  it('does not overlap a tick with a slow previous one', async () => {
    let release: (value: number) => void = () => undefined;
    const sweepOnce = jest.fn(
      () => new Promise<number>((resolve) => (release = resolve)),
    );
    const config = {
      getOrThrow: jest
        .fn()
        .mockReturnValue({ storage: { driver: 'postgres' } }),
    } as unknown as ConfigService;
    const database = {
      isEnabled: jest.fn().mockReturnValue(true),
    } as unknown as DatabaseService;
    const worker = new QaAttachmentOrphanSweepWorker(config, database, {
      sweepOnce,
    } as unknown as PostgresQaAttachmentOrphanSweep);

    const first = worker.sweepOrphans();
    await expect(worker.sweepOrphans()).resolves.toBe(0);
    release(0);
    await expect(first).resolves.toBe(0);
    expect(sweepOnce).toHaveBeenCalledTimes(1);
  });
});
