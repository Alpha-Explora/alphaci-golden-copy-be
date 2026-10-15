import { ownBrowserTestPaths } from './browser-tests.own-tests';

const STARTER = [
  'playwright.config.ts',
  'tests/e2e/pages.e2e-spec.ts',
  'tests/e2e/support.ts',
];
const WITH_PLAYWRIGHT = JSON.stringify({
  devDependencies: { '@playwright/test': '^1.49.0' },
});

describe('ownBrowserTestPaths', () => {
  it('finds Playwright tests by folder or by *.e2e name, sorted', () => {
    expect(
      ownBrowserTestPaths(
        [
          'tests/e2e/checkout.spec.ts',
          'e2e/login.test.ts',
          'apps/web/playwright/cart.spec.tsx',
          'src/flows/order.e2e.ts',
          'src/flows/pay.e2e-spec.ts',
        ],
        WITH_PLAYWRIGHT,
        STARTER,
      ),
    ).toEqual([
      'apps/web/playwright/cart.spec.tsx',
      'e2e/login.test.ts',
      'src/flows/order.e2e.ts',
      'src/flows/pay.e2e-spec.ts',
      'tests/e2e/checkout.spec.ts',
    ]);
  });

  it('leaves out unit tests, helpers, node_modules and the starter pack', () => {
    expect(
      ownBrowserTestPaths(
        [
          'src/lib/money.test.ts',
          'src/components/cart.spec.tsx',
          'e2e/fixtures.ts',
          'node_modules/pkg/e2e/x.spec.ts',
          'tests/e2e/pages.e2e-spec.ts',
        ],
        WITH_PLAYWRIGHT,
        STARTER,
      ),
    ).toEqual([]);
  });

  it('counts nothing for a repository that does not use Playwright', () => {
    expect(
      ownBrowserTestPaths(
        ['e2e/login.spec.ts'],
        '{"devDependencies":{"cypress":"13"}}',
        STARTER,
      ),
    ).toEqual([]);
    expect(ownBrowserTestPaths(['e2e/login.spec.ts'], null, STARTER)).toEqual(
      [],
    );
  });

  it('takes a playwright.config at any depth as using Playwright', () => {
    expect(
      ownBrowserTestPaths(
        ['apps/web/playwright.config.mts', 'apps/web/e2e/home.spec.ts'],
        '{"devDependencies":{}}',
        STARTER,
      ),
    ).toEqual(['apps/web/e2e/home.spec.ts']);
  });
});
