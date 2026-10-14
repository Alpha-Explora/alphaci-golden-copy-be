/**
 * Provider-agnostic "the provider said 429" error, shared by every provider
 * adapter (infrastructure) and the log stream coordinator (application).
 * Living in core/ is deliberate for the same reason deployment-logs.types.ts
 * does: application must not import infrastructure, yet both sides need to
 * agree on this type, so it has to sit where both may import it.
 *
 * It exists because a generic Error('... 429 {raw body}') is useless to a
 * poller: the caller needs to know HOW LONG to stay quiet, and the provider's
 * raw JSON body must never be echoed to a browser as the reason.
 */

/** Used when a 429 carries no usable Retry-After header. */
export const DEFAULT_RATE_LIMIT_RETRY_AFTER_MS = 30_000;

export class ProviderRateLimitedError extends Error {
  constructor(
    readonly provider: string,
    readonly retryAfterMs: number,
  ) {
    // Deliberately carries no provider response body: the message is safe to
    // log and to surface.
    super(
      `${provider} rate limit exceeded; retry in ${String(Math.ceil(retryAfterMs / 1000))}s`,
    );
    this.name = 'ProviderRateLimitedError';
  }
}

/**
 * Parses a Retry-After header, which is either delta-seconds or an HTTP-date,
 * into milliseconds from `now`. Anything absent, malformed or non-positive
 * falls back to the default so a limited provider is never hammered.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  now: number = Date.now(),
  fallbackMs: number = DEFAULT_RATE_LIMIT_RETRY_AFTER_MS,
): number {
  const value = header?.trim();
  if (!value) {
    return fallbackMs;
  }

  if (/^\d+(\.\d+)?$/.test(value)) {
    const ms = Math.ceil(Number(value) * 1000);
    return ms > 0 ? ms : fallbackMs;
  }

  const at = Date.parse(value);
  if (Number.isFinite(at)) {
    const ms = at - now;
    return ms > 0 ? ms : fallbackMs;
  }

  return fallbackMs;
}
