import { Logger } from '@nestjs/common';

import {
  ProviderRateLimitedError,
  parseRetryAfterMs,
} from '../../../core/provider-rate-limited.error';

const logger = new Logger('ProviderFetchWithRetry');

/**
 * Wraps fetch with bounded retry/backoff for provider rate limits (Render,
 * Vercel). Retries only on 429, honoring Retry-After when present, and caps
 * the wait so a request can never hang past the platform's request timeout.
 *
 * No longer used by the log reads: those are polled (shared poller, every open
 * console), and retrying a 429 inside a poll tick only adds requests while the
 * key is already limited, so they use {@link throwIfRateLimited} and let the
 * shared cooldown decide when to ask again. This stays for any one-shot read
 * that wants a bounded in-place retry; create/delete target and env-var writes
 * are not wrapped either - they happen once per click, not in a loop.
 */
export async function fetchWithRetry(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  label = 'provider',
): ReturnType<typeof fetch> {
  const maxAttempts = 3;
  const maxWaitMs = 8_000;

  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(input, init);

    if (response.status !== 429 || attempt >= maxAttempts) {
      return response;
    }

    const waitMs = resolveRetryDelayMs(response, attempt);
    if (waitMs > maxWaitMs) {
      return response;
    }

    logger.warn(
      `${label} rate limit (429); retrying in ${String(waitMs)}ms (attempt ${String(attempt)}/${String(maxAttempts)})`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

function resolveRetryDelayMs(
  response: Awaited<ReturnType<typeof fetch>>,
  attempt: number,
): number {
  const retryAfter = response.headers?.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }

  // Exponential backoff fallback: 1s, 2s, 4s.
  return 2 ** (attempt - 1) * 1000;
}

/**
 * Turns a 429 into a ProviderRateLimitedError (Retry-After honoured, a default
 * applied when absent); every other status passes through for the caller's own
 * assertOk. Used by the polled log reads INSTEAD of fetchWithRetry: retrying a
 * 429 inside a poll tick only adds requests while the key is already limited -
 * the next tick (gated by the shared cooldown) is the retry.
 */
export function throwIfRateLimited(
  response: Awaited<ReturnType<typeof fetch>>,
  label: string,
): void {
  if (response.status === 429) {
    throw new ProviderRateLimitedError(
      label,
      parseRetryAfterMs(response.headers?.get('retry-after')),
    );
  }
}
