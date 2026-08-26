import { Logger } from '@nestjs/common';

const logger = new Logger('ProviderFetchWithRetry');

/**
 * Wraps fetch with bounded retry/backoff for provider rate limits (Render,
 * Vercel). Retries only on 429, honoring Retry-After when present, and caps
 * the wait so a request can never hang past the platform's request timeout.
 *
 * Scoped to the log-fetching paths that get polled repeatedly (live console,
 * future live-tail) — those are the calls most likely to trip a provider's
 * rate limit under normal use. One-shot, user-triggered actions elsewhere in
 * these clients (create/delete target, upsert env vars) aren't wrapped: they
 * happen once per click, not in a loop, so the risk profile is different.
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
