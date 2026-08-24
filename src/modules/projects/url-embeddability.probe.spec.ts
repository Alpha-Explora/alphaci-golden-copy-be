import { UrlEmbeddabilityProbe } from './url-embeddability.probe';

function headResponse(headers: Record<string, string>) {
  return {
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  };
}

describe('UrlEmbeddabilityProbe', () => {
  const url = 'https://web-app-git-main-tone.vercel.app';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports no verdict and issues no request without a URL', async () => {
    global.fetch = jest.fn();

    await expect(new UrlEmbeddabilityProbe().check(null)).resolves.toEqual({
      embeddable: null,
      reason: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('treats a site with no framing headers as embeddable', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(headResponse({}));

    await expect(new UrlEmbeddabilityProbe().check(url)).resolves.toEqual({
      embeddable: true,
      reason: null,
    });
  });

  it('probes with HEAD and refuses to follow redirects off the allowlist', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(headResponse({}));

    await new UrlEmbeddabilityProbe().check(url);

    expect(fetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ method: 'HEAD', redirect: 'manual' }),
    );
  });

  it.each([
    ['DENY', 'X-Frame-Options: DENY'],
    ['deny', 'X-Frame-Options: DENY'],
    ['SAMEORIGIN', 'X-Frame-Options: SAMEORIGIN'],
    ['ALLOW-FROM https://example.com', 'ALLOW-FROM'],
  ])('reports %s as not embeddable', async (header) => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(headResponse({ 'x-frame-options': header }));

    const verdict = await new UrlEmbeddabilityProbe().check(url);

    expect(verdict.embeddable).toBe(false);
    expect(verdict.reason).toBeTruthy();
  });

  it('reports a restrictive frame-ancestors policy as not embeddable', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(
      headResponse({
        'content-security-policy':
          "default-src 'self'; frame-ancestors 'self' https://trusted.example",
      }),
    );

    const verdict = await new UrlEmbeddabilityProbe().check(url);

    expect(verdict.embeddable).toBe(false);
  });

  it('treats a wildcard frame-ancestors policy as embeddable', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(
      headResponse({
        'content-security-policy': "default-src 'self'; frame-ancestors *",
      }),
    );

    await expect(new UrlEmbeddabilityProbe().check(url)).resolves.toEqual({
      embeddable: true,
      reason: null,
    });
  });

  it('ignores a policy that sets no frame-ancestors directive', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(
      headResponse({
        'content-security-policy': "default-src 'self'; script-src 'self'",
      }),
    );

    await expect(new UrlEmbeddabilityProbe().check(url)).resolves.toEqual({
      embeddable: true,
      reason: null,
    });
  });

  it('reports no verdict when the deployment cannot be reached', async () => {
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('timed out'));

    const verdict = await new UrlEmbeddabilityProbe().check(url);

    expect(verdict.embeddable).toBeNull();
    expect(verdict.reason).toContain('Could not reach');
  });

  describe('SSRF boundary', () => {
    it.each([
      ['a host outside the allowlist', 'https://evil.example.com/'],
      ['an internal hostname', 'http://localhost:5432/'],
      ['a link-local address', 'http://169.254.169.254/latest/meta-data/'],
      ['a private address', 'http://10.0.0.5/'],
      ['a non-http scheme', 'file:///etc/passwd'],
      ['a unparseable URL', 'not-a-url'],
      // Suffix matching must not be fooled by a lookalike registrable domain.
      ['a lookalike domain', 'https://vercel.app.evil.com/'],
    ])('refuses to probe %s', async (_label, candidate) => {
      global.fetch = jest.fn();

      const verdict = await new UrlEmbeddabilityProbe().check(candidate);

      expect(verdict.embeddable).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('probes an allowlisted Render host', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce(headResponse({}));

      await new UrlEmbeddabilityProbe().check(
        'https://orders-api.onrender.com',
      );

      expect(fetch).toHaveBeenCalled();
    });
  });

  it('serves a repeated URL from cache instead of probing twice', async () => {
    global.fetch = jest.fn().mockResolvedValue(headResponse({}));
    const probe = new UrlEmbeddabilityProbe();

    await probe.check(url);
    await probe.check(url);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('probes a different URL separately', async () => {
    global.fetch = jest.fn().mockResolvedValue(headResponse({}));
    const probe = new UrlEmbeddabilityProbe();

    await probe.check(url);
    await probe.check('https://web-app-git-feat-x-tone.vercel.app');

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
