import { BadGatewayException, type Logger } from '@nestjs/common';

export class GithubHttp {
  constructor(private readonly logger: Logger) {}

  /**
   * Wraps fetch with bounded retry/backoff for GitHub rate limits.
   *
   * Retries only on 429 and rate-limit 403s — detected via response headers so
   * the body is never consumed and remains readable by callers (a permission
   * 403 is NOT retried because its x-ratelimit-remaining is non-zero). Honors
   * Retry-After / X-RateLimit-Reset but caps the inline wait so a provisioning
   * request can never hang past the platform's request timeout; if the reset is
   * further out than the cap, the original response is returned for the caller
   * to surface normally.
   */
  async fetchWithRetry(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): ReturnType<typeof fetch> {
    const maxAttempts = 3;
    const maxWaitMs = 8_000;

    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(input, init);

      const isRateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers?.get('retry-after') != null ||
            response.headers?.get('x-ratelimit-remaining') === '0'));

      if (!isRateLimited || attempt >= maxAttempts) {
        return response;
      }

      const waitMs = this.resolveRetryDelayMs(response, attempt);
      if (waitMs > maxWaitMs) {
        return response;
      }

      this.logger.warn(
        `GitHub rate limit (${String(response.status)}); retrying in ${String(waitMs)}ms (attempt ${String(attempt)}/${String(maxAttempts)})`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  workspaceHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'cicd-workflow-product',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  /**
   * Shared failure path for every workspace read.
   *
   * 404 comes back as null rather than thrown: an empty repository, a deleted
   * branch, or a path that no longer exists are all normal states a browsing UI
   * must render as "nothing here", not as an error banner. 409 is GitHub's
   * answer for "this repository is empty", which is the same situation.
   */
  async workspaceGet<T>(
    url: string,
    accessToken: string,
    what: string,
  ): Promise<T | null> {
    const response = await this.fetchWithRetry(url, {
      headers: this.workspaceHeaders(accessToken),
    });

    if (response.status === 404 || response.status === 409) {
      return null;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub ${what} failed (${String(response.status)}): ${body.slice(0, 300)}`,
      );
    }

    return (await response.json()) as T;
  }

  private resolveRetryDelayMs(
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

    const reset = response.headers?.get('x-ratelimit-reset');
    if (reset) {
      const resetMs = Number(reset) * 1000 - Date.now();
      if (Number.isFinite(resetMs) && resetMs > 0) {
        return resetMs;
      }
    }

    // Exponential backoff fallback: 1s, 2s, 4s.
    return 2 ** (attempt - 1) * 1000;
  }
}
