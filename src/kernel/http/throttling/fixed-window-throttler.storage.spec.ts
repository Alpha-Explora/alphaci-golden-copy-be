import { FixedWindowThrottlerStorage } from './fixed-window-throttler.storage';

const TTL = 60_000;
const LIMIT = 2;
const BLOCK = 60_000;

describe('FixedWindowThrottlerStorage', () => {
  const START = 1_000_000;

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('blocks a key past its limit and unblocks it after the block ends', async () => {
    const storage = new FixedWindowThrottlerStorage();
    const hit = () => storage.increment('a', TTL, LIMIT, BLOCK);
    expect((await hit()).isBlocked).toBe(false);
    expect((await hit()).isBlocked).toBe(false);
    const blocked = await hit();
    expect(blocked).toMatchObject({ isBlocked: true, totalHits: 3 });
    expect(blocked.timeToBlockExpire).toBe(BLOCK / 1000);
    // Hits while blocked do not count.
    expect(await hit()).toMatchObject({ isBlocked: true, totalHits: 3 });
    jest.setSystemTime(START + BLOCK);
    expect(await hit()).toMatchObject({ isBlocked: false, totalHits: 1 });
  });

  it('lets one key expire on time while another key stays blocked', async () => {
    const storage = new FixedWindowThrottlerStorage();
    const hit = (key: string) => storage.increment(key, TTL, LIMIT, BLOCK);
    // Key A is used once at the start of its window.
    expect(await hit('a')).toMatchObject({ totalHits: 1 });

    // Key B is blocked late in that window, so its block outlives A's window.
    jest.setSystemTime(START + 50_000);
    await hit('b');
    await hit('b');
    expect(await hit('b')).toMatchObject({ isBlocked: true, totalHits: 3 });

    // A's window has elapsed, so A starts again from one; B is still blocked.
    jest.setSystemTime(START + TTL + 11_000);
    expect(await hit('a')).toMatchObject({ totalHits: 1, isBlocked: false });
    expect(await hit('b')).toMatchObject({ isBlocked: true, totalHits: 3 });

    // Once B's block ends, B starts again from one.
    jest.setSystemTime(START + 50_000 + BLOCK);
    expect(await hit('b')).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('reports the seconds left in the window', async () => {
    const storage = new FixedWindowThrottlerStorage();
    expect(await storage.increment('a', TTL, LIMIT, BLOCK)).toMatchObject({
      timeToExpire: TTL / 1000,
    });
    jest.setSystemTime(START + 10_000);
    expect(await storage.increment('a', TTL, LIMIT, BLOCK)).toMatchObject({
      timeToExpire: 50,
    });
  });
});
