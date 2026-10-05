/**
 * Per-credential rate-limit cooldowns, shared by every poller that spends the
 * same provider rate-limit bucket.
 *
 * Keys are bucket identifiers (provider + connection id, or the managed
 * credential) - never a raw token, so they are safe to log.
 */

/** Repeated 429s back off exponentially but never beyond this. */
export const MAX_COOLDOWN_BACKOFF_MS = 120_000;

interface CooldownEntry {
  /** Epoch ms the cooldown ends. */
  until: number;
  /** Consecutive 429s without a success in between. */
  strikes: number;
}

export class ProviderCooldownRegistry {
  private readonly entries = new Map<string, CooldownEntry>();

  /** Milliseconds left on the bucket's cooldown, 0 when it may be used. */
  remainingMs(key: string, now: number = Date.now()): number {
    const entry = this.entries.get(key);

    return entry && entry.until > now ? entry.until - now : 0;
  }

  /** Epoch ms the cooldown ends (0 when none is active). */
  untilMs(key: string, now: number = Date.now()): number {
    const entry = this.entries.get(key);

    return entry && entry.until > now ? entry.until : 0;
  }

  /**
   * Records a 429. `started` is true only for the call that opens a cooldown:
   * several in-flight requests all returning 429 together are ONE event and
   * must not escalate the backoff or log repeatedly. The wait doubles per
   * consecutive 429 (capped), but a longer Retry-After from the provider is
   * always honoured.
   */
  trip(
    key: string,
    retryAfterMs: number,
    now: number = Date.now(),
  ): { retryAfterMs: number; started: boolean } {
    const active = this.remainingMs(key, now);
    if (active > 0) {
      return { retryAfterMs: active, started: false };
    }

    const strikes = this.entries.get(key)?.strikes ?? 0;
    const effective = Math.max(
      retryAfterMs,
      Math.min(MAX_COOLDOWN_BACKOFF_MS, retryAfterMs * 2 ** strikes),
    );
    this.entries.set(key, { until: now + effective, strikes: strikes + 1 });

    return { retryAfterMs: effective, started: true };
  }

  /** A live success proves the bucket is healthy again: forget the backoff. */
  recordSuccess(key: string): void {
    // A request issued before an active cooldown opened can still succeed
    // after it; that must not cancel the pause the 429 just asked for.
    if (this.remainingMs(key) === 0) {
      this.entries.delete(key);
    }
  }
}
