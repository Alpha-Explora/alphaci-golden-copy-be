import { UrlEmbeddabilityProbe } from './url-embeddability.probe';

function headResponse(headers: Record<string, string>, status = 200) {
  return {
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  };
}

function redirectTo(location: string, headers: Record<string, string> = {}) {
  return headResponse({ ...headers, location }, 302);
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

  describe('redirects', () => {
    it('reports a deployment-protection sign-in wall, not the wall’s own headers', async () => {
      // What Vercel Authentication actually answers with: a redirect to its
      // SSO endpoint that itself carries X-Frame-Options: DENY.
      global.fetch = jest.fn().mockResolvedValueOnce(
        redirectTo('https://vercel.com/sso-api?url=x', {
          'x-frame-options': 'DENY',
        }),
      );

      const verdict = await new UrlEmbeddabilityProbe().check(url);

      expect(verdict.embeddable).toBe(false);
      expect(verdict.reason).toContain('deployment protection');
      expect(verdict.reason).not.toContain('X-Frame-Options');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([401, 403])(
      'reports a %s answer as a sign-in wall',
      async (status) => {
        global.fetch = jest
          .fn()
          .mockResolvedValueOnce(headResponse({}, status));

        const verdict = await new UrlEmbeddabilityProbe().check(url);

        expect(verdict.embeddable).toBe(false);
        expect(verdict.reason).toContain('deployment protection');
      },
    );

    it('follows a same-host redirect and judges the page that answers', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(redirectTo('/login'))
        .mockResolvedValueOnce(headResponse({}));

      await expect(new UrlEmbeddabilityProbe().check(url)).resolves.toEqual({
        embeddable: true,
        reason: null,
      });
      expect(fetch).toHaveBeenLastCalledWith(
        `${url}/login`,
        expect.objectContaining({ method: 'HEAD', redirect: 'manual' }),
      );
    });

    it('reports framing headers on the page a same-host redirect lands on', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(redirectTo('/login'))
        .mockResolvedValueOnce(headResponse({ 'x-frame-options': 'DENY' }));

      const verdict = await new UrlEmbeddabilityProbe().check(url);

      expect(verdict.embeddable).toBe(false);
      expect(verdict.reason).toContain('X-Frame-Options: DENY');
    });

    it('never follows a redirect to another host', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(redirectTo('https://example.com/landing'));

      const verdict = await new UrlEmbeddabilityProbe().check(url);

      expect(verdict.embeddable).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('gives up after a bounded number of same-host hops', async () => {
      global.fetch = jest.fn().mockResolvedValue(redirectTo('/again'));

      const verdict = await new UrlEmbeddabilityProbe().check(url);

      expect(verdict.embeddable).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(4);
    });
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

    describe('on-prem app addresses', () => {
      const saved = { ...process.env };
      afterEach(() => {
        process.env = { ...saved };
      });
      const probes = async (candidate: string) => {
        global.fetch = jest.fn().mockResolvedValue(headResponse({}));
        await new UrlEmbeddabilityProbe().check(candidate);
        return (fetch as jest.Mock).mock.calls.length > 0;
      };

      it('probes any name under the apps domain without a suffix', async () => {
        process.env['ONPREM_APPS_DOMAIN'] = 'apps.example.com';
        expect(await probes('https://uat-shop.apps.example.com')).toBe(true);
      });

      // A suffix means the domain is shared: its other names are not apps.
      it('with a label suffix, probes only names that end with it', async () => {
        process.env['ONPREM_APPS_DOMAIN'] = 'example.com';
        process.env['ONPREM_APPS_LABEL_SUFFIX'] = 'stpeter';
        expect(await probes('https://uat-shop-stpeter.example.com')).toBe(true);
        expect(await probes('https://alphaci.example.com')).toBe(false);
      });

      it('probes no apps-domain name when the suffix is invalid', async () => {
        process.env['ONPREM_APPS_DOMAIN'] = 'example.com';
        process.env['ONPREM_APPS_LABEL_SUFFIX'] = 'not a label';
        expect(await probes('https://uat-shop.example.com')).toBe(false);
      });
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
