import { providerPublicUrl } from './provider-public-url';

describe('providerPublicUrl', () => {
  it('prefers the Render service URL the provider returned at creation', () => {
    expect(
      providerPublicUrl({
        provider: 'render',
        providerProjectName: 'orders-api-test',
        providerMetadata: { renderServiceUrl: 'https://orders.example.com' },
      }),
    ).toBe('https://orders.example.com');
  });

  it('trims a padded Render service URL', () => {
    expect(
      providerPublicUrl({
        provider: 'render',
        providerProjectName: 'orders-api-test',
        providerMetadata: { renderServiceUrl: '  https://orders.example.com ' },
      }),
    ).toBe('https://orders.example.com');
  });

  it('falls back to the Render naming convention when metadata carries no URL', () => {
    expect(
      providerPublicUrl({
        provider: 'render',
        providerProjectName: 'orders-api-test',
        providerMetadata: {},
      }),
    ).toBe('https://orders-api-test.onrender.com');
  });

  it('ignores a blank Render service URL', () => {
    expect(
      providerPublicUrl({
        provider: 'render',
        providerProjectName: 'orders-api-test',
        providerMetadata: { renderServiceUrl: '   ' },
      }),
    ).toBe('https://orders-api-test.onrender.com');
  });

  it('ignores a non-string Render service URL', () => {
    expect(
      providerPublicUrl({
        provider: 'render',
        providerProjectName: 'orders-api-test',
        providerMetadata: { renderServiceUrl: 42 },
      }),
    ).toBe('https://orders-api-test.onrender.com');
  });

  it('uses the Vercel naming convention', () => {
    expect(
      providerPublicUrl({
        provider: 'vercel',
        providerProjectName: 'orders-web',
        providerMetadata: {},
      }),
    ).toBe('https://orders-web.vercel.app');
  });

  it('returns null when the provider project has no name to build a URL from', () => {
    expect(
      providerPublicUrl({
        provider: 'vercel',
        providerProjectName: '',
        providerMetadata: {},
      }),
    ).toBeNull();

    expect(
      providerPublicUrl({
        provider: 'render',
        providerProjectName: '',
        providerMetadata: {},
      }),
    ).toBeNull();
  });
});
