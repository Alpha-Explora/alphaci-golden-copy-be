import {
  DEFAULT_RATE_LIMIT_RETRY_AFTER_MS,
  ProviderRateLimitedError,
  parseRetryAfterMs,
} from './provider-rate-limited.error';

describe('parseRetryAfterMs', () => {
  const now = Date.parse('2026-10-05T12:00:00.000Z');

  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs('45', now)).toBe(45_000);
    expect(parseRetryAfterMs('1.5', now)).toBe(1_500);
  });

  it('reads an HTTP-date relative to now', () => {
    expect(parseRetryAfterMs('Mon, 05 Oct 2026 12:01:00 GMT', now)).toBe(
      60_000,
    );
  });

  it.each([undefined, null, '', '   ', 'soon', '0', '-5'])(
    'falls back to the default for %p',
    (header) => {
      expect(parseRetryAfterMs(header, now)).toBe(
        DEFAULT_RATE_LIMIT_RETRY_AFTER_MS,
      );
    },
  );

  it('falls back when the HTTP-date is already past', () => {
    expect(parseRetryAfterMs('Mon, 05 Oct 2026 11:00:00 GMT', now)).toBe(
      DEFAULT_RATE_LIMIT_RETRY_AFTER_MS,
    );
  });
});

describe('ProviderRateLimitedError', () => {
  it('carries the wait and a body-free message', () => {
    const error = new ProviderRateLimitedError('Render', 12_500);

    expect(error.retryAfterMs).toBe(12_500);
    expect(error.provider).toBe('Render');
    expect(error.message).toBe('Render rate limit exceeded; retry in 13s');
  });
});
