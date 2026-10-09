// --- Starter browser-test pack ----------------------------------------------
//
// The files every frontend gets so its verify stage has something worth
// running: pages load cleanly, internal links resolve, no serious
// accessibility violations, and the home page looks the way it was approved.
//
// ONE source for two callers - the scaffold (new projects) and the "Add browser
// tests" pull request (existing projects). Keeping the file contents here, and
// nowhere else, is what stops the two from drifting into different packs.
//
// The generated sources are built from arrays of lines rather than template
// literals on purpose: the specs themselves are full of `${}`-free string
// concatenation and quotes, and a template literal here would make every one
// of them an escaping puzzle.

import type { ScaffoldFile } from './scaffold-file';

/**
 * Where Playwright keeps approved screenshots. FLAT (no per-spec or
 * per-platform subfolders) because playwright-e2e.yml downloads the approved
 * PNGs from ALPHACI into `tests/e2e/__visual__/<name>.png` and nowhere else.
 */
export const SNAPSHOT_PATH_TEMPLATE = '{testDir}/__visual__/{arg}{ext}';

export const PLAYWRIGHT_CONFIG_PATH = 'playwright.config.ts';
export const E2E_SUPPORT_PATH = 'tests/e2e/support.ts';

/** The four checks. A repository "has the pack" when all four and support exist. */
export const BROWSER_TEST_SPEC_PATHS = [
  'tests/e2e/pages.e2e-spec.ts',
  'tests/e2e/links.e2e-spec.ts',
  'tests/e2e/a11y.e2e-spec.ts',
  'tests/e2e/visual.e2e-spec.ts',
] as const;

/** Everything `installed` is judged on: the four specs plus their shared helper. */
export const BROWSER_TEST_REQUIRED_PATHS: readonly string[] = [
  ...BROWSER_TEST_SPEC_PATHS,
  E2E_SUPPORT_PATH,
];

/**
 * The snippet a repository with its own playwright.config.ts needs, because
 * we never edit an existing config. Shown in the pull request body.
 */
export const SNAPSHOT_CONFIG_SNIPPET = [
  'export default defineConfig({',
  '  // ...your existing options...',
  `  snapshotPathTemplate: '${SNAPSHOT_PATH_TEMPLATE}',`,
  '  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.001 } },',
  '});',
].join('\n');

/**
 * Playwright configuration for the deployed-app suite.
 *
 * testDir and the `.e2e-spec.ts` suffix match what jest.config.ts already
 * excludes, so the two runners cannot pick up each other's files.
 *
 * The base URL arrives as E2E_BASE_URL, which playwright-e2e.yml sets from
 * the verify stage's resolved deployment hostname. There is no fallback to
 * localhost on purpose: a suite that quietly tests a dev server instead of
 * the deployment it was pointed at is worse than one that fails.
 *
 * A uat/main preview sits behind Vercel's Standard Protection, which answers
 * every request - Playwright's included - with a redirect to Vercel's own
 * SSO page rather than the app. VERCEL_AUTOMATION_BYPASS_SECRET is the
 * per-project key playwright-e2e.yml is handed when a Vercel frontend target
 * installed one (staged-workflow.builder.ts's uiTestJob); sent as a header,
 * it is Vercel's own documented way past that wall for CI. Unset - no Vercel
 * frontend target, or one that predates this - and the suite runs exactly as
 * it did before, against whatever E2E_BASE_URL resolves to unprotected.
 */
export function buildPlaywrightConfig(): string {
  return [
    "import { defineConfig, devices } from '@playwright/test';",
    '',
    'const baseURL = process.env.E2E_BASE_URL;',
    '',
    'if (!baseURL) {',
    '  throw new Error(',
    "    'E2E_BASE_URL is not set. The end-to-end suite runs against a deployed " +
      "environment, so there is no default to fall back to.',",
    '  );',
    '}',
    '',
    'const vercelAutomationBypassSecret =',
    '  process.env.VERCEL_AUTOMATION_BYPASS_SECRET;',
    '',
    'export default defineConfig({',
    "  testDir: 'tests/e2e',",
    "  testMatch: '**/*.e2e-spec.ts',",
    '  // Approved screenshots live in ONE flat folder. playwright-e2e.yml',
    '  // downloads the baselines approved in ALPHACI to exactly this path, so',
    '  // the template must not grow per-spec or per-platform subfolders.',
    `  snapshotPathTemplate: '${SNAPSHOT_PATH_TEMPLATE}',`,
    '  expect: {',
    '    toHaveScreenshot: {',
    '      // Antialiasing noise between runner images is absorbed per pixel by',
    "      // Playwright's colour threshold (default 0.2). On top of that, at most",
    '      // 0.1% of pixels may differ: 1% let a recoloured, reworded heading pass',
    '      // unnoticed on a full desktop page (~10,000 pixels of headroom).',
    '      maxDiffPixelRatio: 0.001,',
    '    },',
    '  },',
    '  // A deployed environment is shared, so a failure is worth one retry',
    '  // before it is called a failure - but only in CI, where flakes cost a',
    '  // promotion rather than a rerun.',
    '  retries: process.env.CI ? 1 : 0,',
    '  // The json reporter is what ALPHACI reads to show per-test results',
    '  // beside the other tools, instead of one pass/fail word for the whole',
    '  // suite. The verify stage sets PLAYWRIGHT_JSON_OUTPUT_NAME, which takes',
    '  // precedence over the path given here, so the two cannot drift.',
    '  reporter: process.env.CI',
    '    ? [["list"], ["json", { outputFile: "test-results/alphaci-e2e.json" }], ["html", { open: "never" }]]',
    '    : "list",',
    '  use: {',
    '    baseURL,',
    "    trace: 'on-first-retry',",
    '    // Vercel Protection Bypass for Automation: gets Playwright past the',
    "    // deployment's SSO wall on a protected uat/main preview. Omitted",
    '    // entirely when the secret is not set, rather than sent empty.',
    '    ...(vercelAutomationBypassSecret',
    '      ? {',
    '          extraHTTPHeaders: {',
    "            'x-vercel-protection-bypass': vercelAutomationBypassSecret,",
    "            'x-vercel-set-bypass-cookie': 'true',",
    '          },',
    '        }',
    '      : {}),',
    '  },',
    '  projects: [',
    "    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },",
    '  ],',
    '});',
    '',
  ].join('\n');
}

/** The routes and the console-error collector the specs share. */
function buildSupport(): string {
  return [
    "import type { Page } from '@playwright/test';",
    '',
    '/**',
    ' * The routes the page-load and accessibility checks visit.',
    ' *',
    ' * Start with the home page and ADD YOUR OWN ROUTES here as the app grows,',
    " * for example ['/', '/pricing', '/login']. Each entry becomes one test in",
    ' * pages.e2e-spec.ts and one in a11y.e2e-spec.ts. Keep it to pages that',
    ' * render without being signed in: these checks have no session.',
    ' */',
    "export const PAGES: string[] = ['/'];",
    '',
    '/**',
    ' * Start listening for console errors and uncaught page errors on `page`.',
    ' * Returns the live list: read it after the page has loaded.',
    ' *',
    ' * A failed favicon request is ignored. Browsers log it as a console error,',
    ' * but it says nothing about the app and fails on any site without one.',
    ' */',
    'export function collectPageProblems(page: Page): string[] {',
    '  const problems: string[] = [];',
    '',
    "  page.on('console', (message) => {",
    "    if (message.type() !== 'error') {",
    '      return;',
    '    }',
    '    const source = message.location().url;',
    "    if (source.includes('favicon') || message.text().includes('favicon')) {",
    '      return;',
    '    }',
    "    problems.push('console error: ' + message.text());",
    '  });',
    '',
    "  page.on('pageerror', (error) => {",
    "    problems.push('uncaught error: ' + error.message);",
    '  });',
    '',
    '  return problems;',
    '}',
    '',
  ].join('\n');
}

function buildPagesSpec(): string {
  return [
    "import { expect, test } from '@playwright/test';",
    '',
    "import { PAGES, collectPageProblems } from './support';",
    '',
    '// Every page in PAGES must answer with a success status and load without',
    '// logging a console error or throwing an uncaught error.',
    'for (const path of PAGES) {',
    "  test('loads ' + path + ' without errors', async ({ page }) => {",
    '    // What this test checks, in words. ALPHACI shows it beside the result.',
    '    test.info().annotations.push({',
    "      type: 'description',",
    '      description:',
    "        'Opens ' + path + ' on the deployed site and fails if it answers with an HTTP error, or logs a console error or an uncaught error while it loads.',",
    '    });',
    '    const problems = collectPageProblems(page);',
    '',
    "    const response = await test.step('Open ' + path, () => page.goto(path));",
    '    const status = response?.status() ?? 0;',
    "    await test.step('Check the HTTP status', () => {",
    "      expect(response, 'No response for ' + path).not.toBeNull();",
    "      expect(status, path + ' answered with HTTP ' + String(status)).toBeLessThan(400);",
    '    });',
    '',
    "    await test.step('Wait for the page to finish loading', () => page.waitForLoadState('load'));",
    '',
    '    // What the test found, recorded before the check so it is there on a failure too.',
    '    test.info().annotations.push({',
    "      type: 'result',",
    '      description:',
    "        path + ' answered HTTP ' + String(status) + ' with ' + String(problems.length) + ' console or page errors',",
    '    });',
    "    await test.step('Check for console and page errors', () => {",
    "      expect(problems, path + ' logged errors:\\n' + problems.join('\\n')).toEqual([]);",
    '    });',
    '  });',
    '}',
    '',
  ].join('\n');
}

function buildLinksSpec(): string {
  return [
    "import { expect, test } from '@playwright/test';",
    '',
    '// Links checked per run. A cap keeps the stage fast on a link-heavy page.',
    'const MAX_LINKS = 25;',
    '',
    '// Follows every same-origin link on the home page and fails on any that',
    '// answers with an error. The `request` fixture is built from the same',
    '// `use` block as the browser, so it sends the same Vercel protection-bypass',
    '// header as every other check.',
    "test('internal links on the home page resolve', async ({ page, request }) => {",
    '  test.info().annotations.push({',
    "    type: 'description',",
    '    description:',
    "      'Collects the links on the home page that stay on this site and requests each one (up to ' + String(MAX_LINKS) + '); fails if any answers with an HTTP error or cannot be reached.',",
    '  });',
    '',
    "  await test.step('Open the home page', () => page.goto('/'));",
    '',
    "  const targets = await test.step('Collect the same-site links', async () => {",
    '    const origin = new URL(page.url()).origin;',
    "    const hrefs = await page.locator('a[href]').evaluateAll((elements) =>",
    "      elements.map((element) => element.getAttribute('href') ?? ''),",
    '    );',
    '    const found = new Set<string>();',
    '    for (const raw of hrefs) {',
    '      const href = raw.trim();',
    "      if (href === '' || href.startsWith('#')) {",
    '        continue;',
    '      }',
    '      if (/^(mailto|tel|javascript):/i.test(href)) {',
    '        continue;',
    '      }',
    '      let url: URL;',
    '      try {',
    '        url = new URL(href, page.url());',
    '      } catch {',
    '        continue;',
    '      }',
    '      if (url.origin !== origin) {',
    '        continue;',
    '      }',
    "      url.hash = '';",
    '      found.add(url.toString());',
    '    }',
    '    return Array.from(found);',
    '  });',
    '',
    '  const checked = targets.slice(0, MAX_LINKS);',
    '  const broken: string[] = [];',
    "  await test.step('Request each link', async () => {",
    '    for (const link of checked) {',
    '      try {',
    '        const response = await request.get(link);',
    '        if (response.status() >= 400) {',
    "          broken.push(String(response.status()) + ' ' + link);",
    '        }',
    '      } catch (error) {',
    "        broken.push('unreachable ' + link + ' (' + String(error) + ')');",
    '      }',
    '    }',
    '  });',
    '',
    '  test.info().annotations.push({',
    "    type: 'result',",
    '    description:',
    "      String(targets.length) + ' same-site links found, ' + String(checked.length) + ' checked, ' + String(broken.length) + ' broken',",
    '  });',
    "  await test.step('Check for broken links', () => {",
    "    expect(broken, 'Broken links on the home page:\\n' + broken.join('\\n')).toEqual([]);",
    '  });',
    '});',
    '',
  ].join('\n');
}

function buildA11ySpec(): string {
  return [
    "import AxeBuilder from '@axe-core/playwright';",
    "import { expect, test } from '@playwright/test';",
    '',
    "import { PAGES } from './support';",
    '',
    '// Only the two worst impact levels fail the check. Minor and moderate',
    '// findings are real but would turn a first run red on almost any app.',
    "const BLOCKING_IMPACTS = ['critical', 'serious'];",
    '',
    'for (const path of PAGES) {',
    "  test('no critical or serious accessibility violations on ' + path, async ({",
    '    page,',
    '  }) => {',
    '    test.info().annotations.push({',
    "      type: 'description',",
    '      description:',
    "        'Runs the axe accessibility checker on ' + path + ' and fails on any critical or serious violation, such as missing form labels or text that is too low in contrast. Minor and moderate findings are counted but do not fail.',",
    '    });',
    '',
    "    await test.step('Open ' + path, () => page.goto(path));",
    '',
    '    // @axe-core/playwright peers on any playwright-core, so npm can install a',
    '    // newer copy than @playwright/test brings and the two Page types stop',
    '    // matching under tsc. At runtime it is the same page object.',
    "    const axePage = page as unknown as ConstructorParameters<typeof AxeBuilder>[0]['page'];",
    "    const results = await test.step('Run the axe accessibility scan', () =>",
    '      new AxeBuilder({ page: axePage }).analyze(),',
    '    );',
    '    const blocking = results.violations.filter(',
    '      (violation) =>',
    '        violation.impact != null && BLOCKING_IMPACTS.includes(violation.impact),',
    '    );',
    '',
    '    const report = blocking.map((violation) => {',
    '      const targets = violation.nodes',
    '        .slice(0, 3)',
    "        .map((node) => node.target.join(' '))",
    "        .join(', ');",
    '      return (',
    "        violation.id + ' (' + String(violation.impact) + '): ' +",
    "        violation.help + ' - ' + targets",
    '      );',
    '    });',
    '',
    '    test.info().annotations.push({',
    "      type: 'result',",
    '      description:',
    "        String(blocking.length) + ' critical or serious and ' + String(results.violations.length - blocking.length) + ' minor or moderate violations; ' + String(results.passes.length) + ' accessibility rules passed',",
    '    });',
    "    await test.step('Check for critical or serious violations', () => {",
    "      expect(report, 'Accessibility violations on ' + path + ':\\n' + report.join('\\n')).toEqual([]);",
    '    });',
    '  });',
    '}',
    '',
  ].join('\n');
}

function buildVisualSpec(): string {
  return [
    "import { existsSync } from 'node:fs';",
    "import { join } from 'node:path';",
    '',
    "import { expect, test, type Page } from '@playwright/test';",
    '',
    '// The home page at a desktop and a phone size, compared with the reference',
    '// screenshots approved in ALPHACI (downloaded into __visual__ before the run).',
    'const VIEWPORTS = [',
    "  { name: 'desktop', width: 1280, height: 800 },",
    "  { name: 'mobile', width: 390, height: 844 },",
    '];',
    '',
    '// Nothing is masked by default. Mask regions that change on every load - a',
    '// clock, a rotating banner, a random avatar - so they do not fail the check:',
    '// const mask = (page: Page) => [page.locator(\'[data-testid="live-clock"]\')];',
    'const mask = (_page: Page) => [];',
    '',
    '/**',
    ' * Compare with the approved reference, or record the first one.',
    ' *',
    ' * With no reference yet, Playwright would write the screenshot AND fail the',
    ' * test, turning every new project red before anyone could approve anything.',
    ' * Instead a missing reference is captured here and the test passes; ALPHACI',
    ' * shows it as "new" for approval. A changed page still fails, with a diff.',
    ' */',
    'async function expectApprovedScreenshot(page: Page, file: string) {',
    "  const reference = join(test.info().project.testDir, '__visual__', file);",
    "  const options = { fullPage: true, animations: 'disabled' as const, mask: mask(page) };",
    '  if (!existsSync(reference)) {',
    '    await page.screenshot({ ...options, path: reference });',
    '    test.info().annotations.push({',
    "      type: 'visual',",
    "      description: file + ': new screenshot, waiting for approval in ALPHACI',",
    '    });',
    '    return;',
    '  }',
    '  await expect(page).toHaveScreenshot(file, options);',
    '}',
    '',
    'for (const { name, width, height } of VIEWPORTS) {',
    "  test.describe('home page at ' + name + ' size', () => {",
    '    test.use({ viewport: { width, height } });',
    '',
    "    test('matches the approved screenshot', async ({ page }) => {",
    '      test.info().annotations.push({',
    "        type: 'description',",
    '        description:',
    "          'Takes a full-page screenshot of the home page at ' + String(width) + 'x' + String(height) + ' and compares it with the reference approved in ALPHACI. A first run records the screenshot for approval instead of failing.',",
    '      });',
    "      await test.step('Open the home page', () => page.goto('/'));",
    "      await test.step('Wait for the page to finish loading', () => page.waitForLoadState('load'));",
    "      await test.step('Compare with the approved screenshot', () =>",
    "        expectApprovedScreenshot(page, 'home-' + name + '.png'),",
    '      );',
    '    });',
    '  });',
    '}',
    '',
  ].join('\n');
}

/**
 * The starter pack's files, rooted at `prefix` (empty for the repository
 * root, `${dir}/` inside a workspace).
 */
export function buildBrowserTestStarterFiles(prefix = ''): ScaffoldFile[] {
  return [
    {
      path: `${prefix}${PLAYWRIGHT_CONFIG_PATH}`,
      content: buildPlaywrightConfig(),
    },
    { path: `${prefix}${E2E_SUPPORT_PATH}`, content: buildSupport() },
    { path: `${prefix}tests/e2e/pages.e2e-spec.ts`, content: buildPagesSpec() },
    { path: `${prefix}tests/e2e/links.e2e-spec.ts`, content: buildLinksSpec() },
    { path: `${prefix}tests/e2e/a11y.e2e-spec.ts`, content: buildA11ySpec() },
    {
      path: `${prefix}tests/e2e/visual.e2e-spec.ts`,
      content: buildVisualSpec(),
    },
  ];
}
