import type { ThrottlerStorage } from '@nestjs/throttler';

type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

interface Window {
  hits: number;
  windowEndsAt: number;
  /** 0 unless the key is blocked; then the time the block ends. */
  blockedUntil: number;
}

const SWEEP_EVERY = 1024;

/**
 * In-memory throttler storage with one fixed window per key, each on its own
 * clock. The bundled ThrottlerStorageService cancels every expiry timer of a
 * throttler whenever any one blocked key unblocks, so other keys' hit counts
 * never decay and a healthy client is throttled for good. Here no timers are
 * shared: a key's window and block end on their own schedule.
 */
export class FixedWindowThrottlerStorage implements ThrottlerStorage {
  private readonly windows = new Map<string, Window>();
  private increments = 0;

  increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): Promise<ThrottlerStorageRecord> {
    const now = Date.now();
    if (++this.increments % SWEEP_EVERY === 0) this.sweep(now);
    let window = this.windows.get(key);
    if (window && window.blockedUntil > now)
      return Promise.resolve(record(window, now));
    // A new window starts on the first hit, after a block ends, or when the window elapses.
    if (!window || window.blockedUntil !== 0 || window.windowEndsAt <= now) {
      window = { hits: 0, windowEndsAt: now + ttl, blockedUntil: 0 };
      this.windows.set(key, window);
    }
    window.hits += 1;
    if (window.hits > limit) window.blockedUntil = now + blockDuration;
    return Promise.resolve(record(window, now));
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows)
      if (window.windowEndsAt <= now && window.blockedUntil <= now)
        this.windows.delete(key);
  }
}

function record(window: Window, now: number): ThrottlerStorageRecord {
  const blocked = window.blockedUntil > now;
  return {
    totalHits: window.hits,
    timeToExpire: Math.max(0, Math.ceil((window.windowEndsAt - now) / 1000)),
    isBlocked: blocked,
    timeToBlockExpire: blocked
      ? Math.ceil((window.blockedUntil - now) / 1000)
      : 0,
  };
}
