/**
 * A plain-English explanation for failures whose log text is recognisable.
 *
 * The excerpt shows what a tool printed, which is exactly right for someone who
 * reads CI logs and not enough for someone who does not. "The 'login' field
 * requires one of the following scopes: ['read:org']" is a complete diagnosis
 * to an engineer and noise to everybody else. This turns the handful of
 * signatures that account for most real failures into one sentence saying what
 * is wrong and what to do about it.
 *
 * Pure and IO-free. It only READS the excerpt the caller already has, so it is
 * table-driven and testable against captured log lines. Unknown failures get
 * `null`, never a guess: a wrong hint is worse than none, because it sends
 * someone looking in the wrong place with the authority of the product behind
 * it.
 *
 * ORDER MATTERS, first match wins. Root causes (a missing scope, a type error,
 * a failing test) come before the generic wrappers that surround them: a failed
 * Docker build prints the compiler error that caused it, and a failed
 * `npm test` ends in `npm ERR!` lines, so matching the wrapper first would
 * explain the envelope and hide the letter.
 */

export interface FailureHintRule {
  /** For tests and logs; never shown. */
  id: string;
  /** Returns the hint, or null when this rule does not recognise the text. */
  match: (lines: readonly string[], text: string) => string | null;
}

/** `requires one of the following scopes: ['read:org']` -> ['read:org']. */
const SCOPE_LIST = /following scopes?:?\s*\[([^\]]*)\]/i;

function parseScopes(text: string): string[] {
  const listed = SCOPE_LIST.exec(text)?.[1];
  if (!listed) return [];
  return [...listed.matchAll(/['"]?([A-Za-z0-9_:.-]+)['"]?/g)]
    .map((match) => match[1] ?? '')
    .filter((scope) => scope !== '');
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function firstCount(text: string, pattern: RegExp): number | null {
  const found = pattern.exec(text)?.[1];
  return found === undefined ? null : Number(found);
}

export const FAILURE_HINT_RULES: readonly FailureHintRule[] = [
  {
    id: 'token-missing-scope',
    match: (_lines, text) => {
      if (
        !/has not been granted the required scopes|requires one of the following scopes/i.test(
          text,
        )
      ) {
        return null;
      }
      const scopes = parseScopes(text);
      if (scopes.length === 0) {
        return "The workflow's token is missing a permission scope GitHub requires for this request. Use a token that has it, then re-run.";
      }
      const named = scopes.join(', ');
      return scopes.length === 1
        ? `The workflow's token is missing the ${named} scope, so GitHub refused the request. Use a token that has the ${named} scope, then re-run.`
        : `The workflow's token is missing a required scope (any one of: ${named}), so GitHub refused the request. Use a token that has one of them, then re-run.`;
    },
  },
  {
    id: 'resource-not-accessible',
    match: (_lines, text) =>
      /Resource not accessible by (integration|personal access token)/i.test(
        text,
      )
        ? 'GitHub refused the request because the token the workflow ran with lacks permission for it. Grant the GitHub App or token the permission this step needs (for example write access to pull requests or contents), then re-run.'
        : null,
  },
  {
    id: 'rate-limit',
    match: (_lines, text) =>
      /API rate limit exceeded|secondary rate limit|rate limit exceeded|HTTP 429|429 Too Many Requests/i.test(
        text,
      )
        ? 'A service rate-limited the workflow. This is usually temporary: wait a few minutes and re-run.'
        : null,
  },
  {
    id: 'vercel-auth',
    match: (lines, text) => {
      const direct =
        /The specified token is not valid|No existing credentials found/i.test(
          text,
        );
      const named = lines.some(
        (line) =>
          /\bvercel\b/i.test(line) &&
          /(invalid token|token is not valid|unauthori[sz]ed|forbidden|not authori[sz]ed|\b40[13]\b|credentials)/i.test(
            line,
          ),
      );
      return direct || named
        ? 'The deploy was rejected because the Vercel token is missing, invalid or expired. Update the VERCEL_TOKEN secret with a valid token, then re-run.'
        : null;
    },
  },
  {
    id: 'render-auth',
    match: (lines) =>
      lines.some(
        (line) =>
          /\brender\b/i.test(line) &&
          /(unauthori[sz]ed|invalid.*(api )?key|forbidden|not authori[sz]ed|\b40[13]\b)/i.test(
            line,
          ),
      )
        ? 'The deploy was rejected because the Render API key is missing, invalid or lacks access to the service. Update the RENDER_API_KEY secret, then re-run.'
        : null,
  },
  {
    id: 'npm-dependency-resolution',
    match: (_lines, text) =>
      /\bERESOLVE\b|npm (ERR!|error) (code )?ERESOLVE|Could not resolve dependency/i.test(
        text,
      )
        ? "npm could not install the project's dependencies because their version requirements conflict. Fix the conflicting versions in package.json (or the lockfile), then re-run."
        : null,
  },
  {
    id: 'typescript-errors',
    match: (_lines, text) => {
      const count = text.match(/\berror TS\d+\b/g)?.length ?? 0;
      return count > 0
        ? `TypeScript found ${String(count)} compile ${plural(count, 'error', 'errors')}. The file and line of each is listed above; fix ${plural(count, 'it', 'them')} and re-run.`
        : null;
    },
  },
  {
    id: 'eslint-errors',
    match: (_lines, text) => {
      // `✖ 12 problems (9 errors, 3 warnings)`: a warnings-only run is not a failure.
      const summary = /\b(\d+) problems? \((\d+) error/.exec(text);
      const problems = Number(summary?.[1] ?? 0);
      const errors = Number(summary?.[2] ?? 0);
      return errors > 0
        ? `ESLint found ${String(errors)} ${plural(errors, 'error', 'errors')} (${String(problems)} ${plural(problems, 'problem', 'problems')} in total). Fix what is listed above and re-run.`
        : null;
    },
  },
  {
    id: 'test-failures',
    match: (_lines, text) => {
      // Jest prints `Tests:       2 failed, 10 passed`, Vitest `Tests  2 failed`.
      const failed = firstCount(text, /\bTests:?\s+(\d+) failed/i);
      if (failed === null || failed === 0) return null;
      return `${String(failed)} ${plural(failed, 'test', 'tests')} failed. The failing ${plural(failed, 'test and its assertion are', 'tests and their assertions are')} listed above; fix ${plural(failed, 'it', 'them')} and re-run.`;
    },
  },
  {
    id: 'docker-build',
    match: (_lines, text) =>
      /ERROR: failed to (solve|build)|executor failed running|did not complete successfully: exit code|docker build.*(failed|returned a non-zero)/i.test(
        text,
      )
        ? 'The Docker image failed to build. The build step that failed is shown above; fix it (often a missing file, a failing install, or a compile error) and re-run.'
        : null,
  },
  {
    id: 'npm-error',
    match: (_lines, text) =>
      /npm ERR!|npm error /.test(text)
        ? 'An npm command failed. The reason npm gave is shown above; fix it and re-run.'
        : null,
  },
];

/**
 * A one-sentence explanation of a failure, or null when nothing is recognised.
 *
 * `lines` are the cleaned excerpt lines (see `extractFailureExcerpt`).
 */
export function classifyFailureHint(lines: readonly string[]): string | null {
  if (lines.length === 0) return null;
  const text = lines.join('\n');
  for (const rule of FAILURE_HINT_RULES) {
    const hint = rule.match(lines, text);
    if (hint) return hint;
  }
  return null;
}
