/**
 * Coalesces identical async loads: while one is in flight every caller shares
 * its promise, and (when `ttlMs > 0`) a successful result is served to later
 * callers until it expires. Failures are never cached - the next caller
 * retries - so a transient provider error cannot be pinned for the TTL.
 *
 * It exists because provider rate limits are per credential, not per viewer:
 * N people (or N browser tabs) looking at the same deployment must cost the
 * provider one request, not N.
 */
export class ShortTtlCoalescer<T> {
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly settled = new Map<string, { value: T; expiresAt: number }>();

  run(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.settled.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return Promise.resolve(hit.value);
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const request = (async () => load())()
      .then((value) => {
        if (ttlMs > 0) {
          this.remember(key, value, ttlMs);
        }
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);

    return request;
  }

  /** Drops expired entries on write so the map cannot grow without bound. */
  private remember(key: string, value: T, ttlMs: number): void {
    const now = Date.now();
    for (const [entryKey, entry] of this.settled) {
      if (entry.expiresAt <= now) {
        this.settled.delete(entryKey);
      }
    }
    this.settled.set(key, { value, expiresAt: now + ttlMs });
  }
}
