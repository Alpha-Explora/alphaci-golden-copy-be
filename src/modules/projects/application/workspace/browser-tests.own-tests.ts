/**
 * A repository's own Playwright tests, whatever they are named.
 *
 * The verify workflow (playwright-e2e.yml) runs the repository's own test
 * command, so tests it already has run there. The starter pack only adds
 * ALPHACI's four standard checks. Without this, a repository with its own
 * suite (tests/e2e/checkout.spec.ts, say) read as having "no browser tests".
 *
 * Plain functions: no dependency to wire, so they are tested as data.
 */

/** At most this many paths are returned; `count` still counts them all. */
export const OWN_TEST_PATHS_SHOWN = 20;

const PLAYWRIGHT_CONFIG = /(^|\/)playwright\.config\.(ts|mts|cts|js|mjs|cjs)$/;

/** A test file: *.spec / *.test / *.e2e / *.e2e-spec, in TypeScript or JavaScript. */
const TEST_FILE = /\.(spec|test|e2e|e2e-spec)\.(ts|tsx|mts|js|jsx|mjs|cjs)$/;

/** Where Playwright suites live by convention: an e2e or playwright folder, or an *.e2e* file name. */
const BROWSER_TEST_PLACE = /(^|\/)(e2e|playwright)\/|\.e2e(-spec)?\.[a-z]+$/;

function hasPlaywrightDependency(packageJson: string | null): boolean {
  if (!packageJson) return false;
  try {
    const parsed = JSON.parse(packageJson) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    return Boolean(
      parsed.devDependencies?.['@playwright/test'] ??
      parsed.dependencies?.['@playwright/test'],
    );
  } catch {
    return false;
  }
}

/**
 * The repository's own browser test files: only when it uses Playwright (the
 * dependency, or a playwright.config at any depth), never inside
 * node_modules, and never one of ALPHACI's starter files.
 */
export function ownBrowserTestPaths(
  paths: readonly string[],
  packageJson: string | null,
  starterPaths: readonly string[],
): string[] {
  const usesPlaywright =
    hasPlaywrightDependency(packageJson) ||
    paths.some((path) => PLAYWRIGHT_CONFIG.test(path));
  if (!usesPlaywright) return [];
  const starter = new Set(starterPaths);
  return paths
    .filter(
      (path) =>
        !path.includes('node_modules/') &&
        !starter.has(path) &&
        TEST_FILE.test(path) &&
        BROWSER_TEST_PLACE.test(path),
    )
    .sort();
}
