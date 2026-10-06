/**
 * The packages the starter browser-test pack needs, as an `npm install`
 * argument list.
 *
 * Two consumers must agree on this, which is why it is one constant and not
 * prose in two places:
 *
 *   - the scaffold writes these into a NEW frontend's package.json, and the
 *     "Add browser tests" pull request writes them into an existing one;
 *   - playwright-e2e.yml's `ensure-test-deps` input `npm install --no-save`s
 *     them at run time into a repository whose lockfile must not move.
 *
 * `@playwright/test` is ^1.55 because visual baselines are stored in ALPHACI
 * and the verify workflow runs with `--update-snapshots=missing`, which needs
 * 1.50 or newer. `@axe-core/playwright` backs the accessibility check.
 *
 * TODO(unify): a parallel change exports an identical
 * `BROWSER_TEST_DEPENDENCIES` from staged-workflow.builder.ts. Once both are
 * merged, delete one and import the other - the two strings must never drift.
 */
export const BROWSER_TEST_DEPENDENCIES =
  '@playwright/test@^1.55.0 @axe-core/playwright@^4.10.0';

/**
 * `BROWSER_TEST_DEPENDENCIES` as a package.json devDependencies fragment.
 *
 * Split on the LAST '@' so a scoped name ('@playwright/test') keeps its own.
 */
export function browserTestDevDependencies(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const spec of BROWSER_TEST_DEPENDENCIES.split(/\s+/)) {
    const at = spec.lastIndexOf('@');
    entries[spec.slice(0, at)] = spec.slice(at + 1);
  }
  return entries;
}
