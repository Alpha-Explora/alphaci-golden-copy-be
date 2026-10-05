import {
  MAX_COOLDOWN_BACKOFF_MS,
  ProviderCooldownRegistry,
} from './provider-cooldown.registry';

describe('ProviderCooldownRegistry', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens a cooldown that expires after the wait', () => {
    const registry = new ProviderCooldownRegistry();

    expect(registry.trip('k', 30_000, 0)).toEqual({
      retryAfterMs: 30_000,
      started: true,
    });
    expect(registry.remainingMs('k', 10_000)).toBe(20_000);
    expect(registry.remainingMs('k', 30_000)).toBe(0);
    expect(registry.remainingMs('other', 10_000)).toBe(0);
  });

  it('treats a 429 inside an active cooldown as the same event', () => {
    const registry = new ProviderCooldownRegistry();
    registry.trip('k', 30_000, 0);

    expect(registry.trip('k', 30_000, 5_000)).toEqual({
      retryAfterMs: 25_000,
      started: false,
    });
  });

  it('doubles the wait per consecutive 429 and caps it', () => {
    const registry = new ProviderCooldownRegistry();
    let now = 0;
    const waits: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { retryAfterMs } = registry.trip('k', 30_000, now);
      waits.push(retryAfterMs);
      now += retryAfterMs;
    }

    expect(waits).toEqual([30_000, 60_000, 120_000, 120_000, 120_000]);
    expect(Math.max(...waits)).toBe(MAX_COOLDOWN_BACKOFF_MS);
  });

  it('still honours a Retry-After longer than the cap', () => {
    const registry = new ProviderCooldownRegistry();

    expect(registry.trip('k', 300_000, 0).retryAfterMs).toBe(300_000);
  });

  it('forgets the backoff after a success once the cooldown is over', () => {
    jest.useFakeTimers().setSystemTime(40_000);
    const registry = new ProviderCooldownRegistry();
    registry.trip('k', 30_000, 0);

    registry.recordSuccess('k');

    expect(registry.trip('k', 30_000, 40_000).retryAfterMs).toBe(30_000);
  });

  it('keeps an active cooldown when a pre-existing request succeeds', () => {
    jest.useFakeTimers().setSystemTime(5_000);
    const registry = new ProviderCooldownRegistry();
    registry.trip('k', 30_000, 0);

    registry.recordSuccess('k');

    expect(registry.remainingMs('k', 5_000)).toBe(25_000);
  });
});
