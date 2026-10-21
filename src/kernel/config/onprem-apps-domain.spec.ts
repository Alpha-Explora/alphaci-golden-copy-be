import {
  onpremAppsAddress,
  onpremAppsHostEnding,
  resolveOnpremAppsDomain,
} from './onprem-apps-domain';

const settings =
  (values: Record<string, string>) =>
  (key: string): string | undefined =>
    values[key];

describe('resolveOnpremAppsDomain', () => {
  it('is off without ONPREM_APPS_DOMAIN', () => {
    expect(resolveOnpremAppsDomain(settings({}))).toBeUndefined();
  });

  it('normalizes the domain and suffix', () => {
    expect(
      resolveOnpremAppsDomain(
        settings({
          ONPREM_APPS_DOMAIN: ' Apps.Example.com ',
          ONPREM_APPS_LABEL_SUFFIX: ' StPeter ',
        }),
      ),
    ).toEqual({ domain: 'apps.example.com', labelSuffix: 'stpeter' });
  });

  // Dropping a bad suffix would put apps on the shared domain's bare names.
  it.each(['-stpeter', 'st.peter', 'st peter', 'a'.repeat(33)])(
    'turns app addresses off for the invalid suffix %p',
    (suffix) => {
      expect(
        resolveOnpremAppsDomain(
          settings({
            ONPREM_APPS_DOMAIN: 'example.com',
            ONPREM_APPS_LABEL_SUFFIX: suffix,
          }),
        ),
      ).toBeUndefined();
    },
  );
});

describe('onpremAppsAddress', () => {
  const plain = { domain: 'apps.example.com', labelSuffix: '' };
  const suffixed = { domain: 'example.com', labelSuffix: 'stpeter' };

  it('names an address as one label under the domain', () => {
    expect(onpremAppsAddress(plain, 'UAT_Shop.FE')).toBe(
      'https://uat-shop-fe.apps.example.com',
    );
    expect(onpremAppsAddress(suffixed, 'uat-shop')).toBe(
      'https://uat-shop-stpeter.example.com',
    );
  });

  it('keeps the label within 63 characters, suffix included', () => {
    const host = new URL(onpremAppsAddress(suffixed, 'x'.repeat(80))).host;
    const label = host.split('.')[0] ?? '';
    expect(label).toHaveLength(63);
    expect(label.endsWith('-stpeter')).toBe(true);
  });

  it('shares its ending with every address it names', () => {
    expect(onpremAppsHostEnding(suffixed)).toBe('-stpeter.example.com');
    expect(onpremAppsHostEnding(plain)).toBe('.apps.example.com');
  });
});
