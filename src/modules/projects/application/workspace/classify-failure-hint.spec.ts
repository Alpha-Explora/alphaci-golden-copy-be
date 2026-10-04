import { classifyFailureHint } from './classify-failure-hint';

/**
 * The real failure that motivated the classifier: job
 * `promote-to-uat / Create Promotion PR` on Alphaexplora-Sandbox/logistics2cicd-fe
 * (run 37030220083). The app showed none of this text.
 */
const READ_ORG_LINE =
  "GraphQL: Your token has not been granted the required scopes to execute this query. The 'login' field requires one of the following scopes: ['read:org'], but your token has only been granted the: ['repo', 'workflow'] scopes. Please modify your token's scopes at: https://github.com/settings/tokens.";

describe('classifyFailureHint', () => {
  const cases: ReadonlyArray<{
    name: string;
    lines: string[];
    expected: RegExp;
  }> = [
    {
      name: 'a token missing the read:org scope (the exact real line)',
      lines: [READ_ORG_LINE, '##[error]Process completed with exit code 1.'],
      expected: /token is missing the read:org scope/,
    },
    {
      name: 'a token missing one of several scopes',
      lines: [
        "The 'login' field requires one of the following scopes: ['read:org', 'admin:org'].",
      ],
      expected: /any one of: read:org, admin:org/,
    },
    {
      name: 'a scope error whose scope list cannot be parsed',
      lines: ['Your token has not been granted the required scopes.'],
      expected: /missing a permission scope/,
    },
    {
      name: 'a GitHub App without permission',
      lines: ['HttpError: Resource not accessible by integration'],
      expected: /lacks permission/,
    },
    {
      name: 'a primary rate limit',
      lines: ['gh: API rate limit exceeded for installation ID 1234.'],
      expected: /rate-limited/,
    },
    {
      name: 'a secondary rate limit',
      lines: ['You have exceeded a secondary rate limit. Please wait.'],
      expected: /rate-limited/,
    },
    {
      name: 'npm dependency resolution (ERESOLVE)',
      lines: [
        'npm ERR! code ERESOLVE',
        'npm ERR! ERESOLVE could not resolve',
        'npm ERR! Found: react@19.0.0',
      ],
      expected: /version requirements conflict/,
    },
    {
      name: 'npm 10 dependency resolution wording',
      lines: [
        'npm error code ERESOLVE',
        'npm error Could not resolve dependency:',
      ],
      expected: /version requirements conflict/,
    },
    {
      name: 'a generic npm failure',
      lines: [
        'npm ERR! code E404',
        'npm ERR! 404 Not Found - GET https://registry',
      ],
      expected: /npm command failed/,
    },
    {
      name: 'jest failing tests',
      lines: ['Tests:       3 failed, 41 passed, 44 total'],
      expected: /^3 tests failed/,
    },
    {
      name: 'a single failing test reads in the singular',
      lines: ['Tests:       1 failed, 41 passed, 42 total'],
      expected: /^1 test failed/,
    },
    {
      name: 'vitest failing tests',
      lines: [' Tests  2 failed | 10 passed (12)'],
      expected: /^2 tests failed/,
    },
    {
      name: 'TypeScript compile errors',
      lines: [
        "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
        "src/b.ts(9,1): error TS2304: Cannot find name 'x'.",
      ],
      expected: /TypeScript found 2 compile errors/,
    },
    {
      name: 'a single TypeScript error',
      lines: ["src/a.ts(3,5): error TS2322: Type 'string' is not assignable."],
      expected: /TypeScript found 1 compile error\./,
    },
    {
      name: 'ESLint errors',
      lines: ['✖ 12 problems (9 errors, 3 warnings)'],
      expected: /ESLint found 9 errors \(12 problems in total\)/,
    },
    {
      name: 'a Docker build failure',
      lines: [
        'ERROR: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1',
      ],
      expected: /Docker image failed to build/,
    },
    {
      name: 'a Vercel token rejected',
      lines: ['Error: The specified token is not valid. Use `vercel login`.'],
      expected: /Vercel token is missing, invalid or expired/,
    },
    {
      name: 'Vercel credentials missing',
      lines: [
        'Error: No existing credentials found. Please run `vercel login`.',
      ],
      expected: /VERCEL_TOKEN/,
    },
    {
      name: 'a Render API key rejected',
      lines: ['Render API request failed: 401 Unauthorized'],
      expected: /Render API key/,
    },
  ];

  it.each(cases)('recognises $name', ({ lines, expected }) => {
    expect(classifyFailureHint(lines)).toMatch(expected);
  });

  it('prefers the root cause over the wrapper around it', () => {
    // A failing `npm test` ends in npm ERR! lines; the useful fact is the tests.
    const hint = classifyFailureHint([
      'Tests:       2 failed, 8 passed, 10 total',
      'npm ERR! Test failed.  See above for more details.',
    ]);
    expect(hint).toMatch(/^2 tests failed/);
  });

  it('prefers a compile error to the Docker build that surfaced it', () => {
    const hint = classifyFailureHint([
      "src/a.ts(3,5): error TS2322: Type 'string' is not assignable.",
      'ERROR: failed to solve: process "/bin/sh -c npm run build" did not complete successfully',
    ]);
    expect(hint).toMatch(/TypeScript found 1 compile error/);
  });

  it('gives no hint for an unrecognised failure', () => {
    expect(
      classifyFailureHint([
        'Something went wrong in a way nobody has seen before.',
        '##[error]Process completed with exit code 1.',
      ]),
    ).toBeNull();
  });

  it('gives no hint for an empty excerpt', () => {
    expect(classifyFailureHint([])).toBeNull();
  });

  it('does not report ESLint when the summary has zero errors', () => {
    expect(
      classifyFailureHint(['✖ 2 problems (0 errors, 2 warnings)']),
    ).toBeNull();
  });

  it('does not treat a passing test summary as a failure', () => {
    expect(
      classifyFailureHint(['Tests:       0 failed, 44 passed']),
    ).toBeNull();
  });
});
