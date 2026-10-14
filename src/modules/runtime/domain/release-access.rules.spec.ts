import { canPromoteRelease } from './release-access.rules';

describe('release promotion personas', () => {
  it.each([
    ['admin', true, true],
    ['lead', true, true],
    ['member', true, false],
    ['qa', false, false],
    [null, false, false],
    [undefined, false, false],
  ] as const)(
    '%s has explicit promotion rights',
    (role, nonProduction, production) => {
      expect(canPromoteRelease(role, 'non_production')).toBe(nonProduction);
      expect(canPromoteRelease(role, 'production')).toBe(production);
    },
  );
});
