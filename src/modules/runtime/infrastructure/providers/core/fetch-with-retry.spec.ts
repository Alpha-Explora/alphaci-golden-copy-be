import { ProviderRateLimitedError } from '../../../core/provider-rate-limited.error';
import { fetchWithRetry, throwIfRateLimited } from './fetch-with-retry';

describe('fetchWithRetry', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the response immediately on success', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, status: 200 });

    const response = await fetchWithRetry('https://example.test/logs');
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 honoring Retry-After, then succeeds', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    });

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: {
          get: (name: string) => (name === 'retry-after' ? '0' : null),
        },
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const response = await fetchWithRetry('https://example.test/logs');
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('gives up and returns the last 429 response after the max attempts', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: () => void) => {
      fn();
      return 0 as unknown as NodeJS.Timeout;
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name === 'retry-after' ? '0' : null) },
    });

    const response = await fetchWithRetry('https://example.test/logs');
    expect(response.status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-429 failures', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: { get: () => null },
    });

    const response = await fetchWithRetry('https://example.test/logs');
    expect(response.status).toBe(500);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('throwIfRateLimited', () => {
  const response = (status: number, retryAfter: string | null) =>
    ({
      status,
      headers: {
        get: (name: string) => (name === 'retry-after' ? retryAfter : null),
      },
    }) as unknown as Awaited<ReturnType<typeof fetch>>;

  it('throws a typed error carrying Retry-After seconds on 429', () => {
    expect(() => throwIfRateLimited(response(429, '12'), 'Render')).toThrow(
      ProviderRateLimitedError,
    );
    try {
      throwIfRateLimited(response(429, '12'), 'Render');
    } catch (error) {
      expect((error as ProviderRateLimitedError).retryAfterMs).toBe(12_000);
    }
  });

  it('defaults the wait when Retry-After is absent', () => {
    try {
      throwIfRateLimited(response(429, null), 'Vercel');
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as ProviderRateLimitedError).retryAfterMs).toBe(30_000);
    }
  });

  it('passes every other status through untouched', () => {
    expect(() =>
      throwIfRateLimited(response(200, null), 'Render'),
    ).not.toThrow();
    expect(() =>
      throwIfRateLimited(response(500, null), 'Render'),
    ).not.toThrow();
  });
});
