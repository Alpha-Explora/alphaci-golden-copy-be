export interface FriendlyMessage {
  severity: 'info' | 'warning' | 'error' | 'success';
  title: string;
  detail: string;
  hint: string;
  items?: { label: string; sub?: string }[];
}

export interface CiResults {
  tests?: {
    passed: number;
    failed: number;
    total: number;
    failures?: { name: string; message?: string }[];
  };
  coverage?: { pct: number; threshold: number };
  lint?: {
    errors: number;
    warnings: number;
    issues?: {
      rule?: string;
      file?: string;
      line?: number;
      message?: string;
    }[];
  };
  security?: {
    high: number;
    critical: number;
    items?: {
      package?: string;
      id?: string;
      title?: string;
      severity?: string;
    }[];
  };
}

type Stage = 'access' | 'quality' | 'package';
type Conclusion = 'success' | 'failure' | 'cancelled';

/** Maximum number of detail items surfaced in a FriendlyMessage. */
const ITEMS_CAP = 20;

function hasResults(results: CiResults): boolean {
  return (
    results.tests !== undefined ||
    results.coverage !== undefined ||
    results.lint !== undefined ||
    results.security !== undefined
  );
}

/**
 * Build a capped items array for a FriendlyMessage.
 * If the source array has more than ITEMS_CAP entries, a trailing summary item
 * ("…and N more") is appended instead of the overflow entries.
 */
function capItems(
  source: { label: string; sub?: string }[],
): { label: string; sub?: string }[] {
  if (source.length <= ITEMS_CAP) {
    return source;
  }
  const overflow = source.length - ITEMS_CAP;
  return [
    ...source.slice(0, ITEMS_CAP),
    { label: `…and ${String(overflow)} more` },
  ];
}

function reportedFailedJobs(rawLogs?: string): string[] {
  if (!rawLogs) return [];

  return rawLogs
    .split(/\r?\n/)
    .map((line) => line.replace(/^Failed GitHub Actions job:\s*/i, '').trim())
    .filter((line) => line.length > 0)
    .filter((line, index, lines) => lines.indexOf(line) === index)
    .slice(0, 5);
}

function unreportedFailureMessage(
  stage: Stage,
  rawLogs?: string,
): FriendlyMessage {
  const failedJobs = reportedFailedJobs(rawLogs);

  if (failedJobs.length > 0) {
    const firstJob = failedJobs[0]!.toLowerCase();
    const isLint = firstJob.includes('lint');
    const isTypecheck = firstJob.includes('type') || firstJob.includes('tsc');
    const isTest = firstJob.includes('test');
    const isBuild = firstJob.includes('build') || firstJob.includes('package');
    const isSecurity =
      firstJob.includes('sonar') ||
      firstJob.includes('security') ||
      firstJob.includes('audit');

    return {
      severity: 'error',
      title: isLint
        ? 'Lint check failed'
        : isTypecheck
          ? 'Type check failed'
          : isTest
            ? 'Tests failed'
            : isBuild
              ? 'Build or package step failed'
              : isSecurity
                ? 'Security or code-quality check failed'
                : `GitHub job "${failedJobs[0]}" failed`,
      detail: `GitHub reported ${failedJobs.length === 1 ? 'this failed job' : `${String(failedJobs.length)} failed jobs`} for the ${stage} stage.`,
      hint: isLint
        ? 'Run npm run lint locally, fix the reported violations, then re-run the workflow.'
        : isTypecheck
          ? 'Run npm run typecheck locally, fix the reported TypeScript errors, then re-run the workflow.'
          : isTest
            ? 'Run the failing test command locally, fix the first failure, then re-run the workflow.'
            : isBuild
              ? 'Run the project build locally, fix the first build error, then re-run the workflow.'
              : 'Open the workflow logs, fix the first failed job listed below, then re-run the workflow.',
      items: failedJobs.map((job) => ({ label: job })),
    };
  }

  const fallback: Record<Stage, FriendlyMessage> = {
    access: {
      severity: 'error',
      title: 'Access check failed before diagnostics were reported',
      detail:
        'GitHub confirmed the access workflow failed, but it did not provide the failing job or error output.',
      hint: 'Open the workflow logs. Check ALPHACI_TOKEN and GitHub App access to this repository, fix the first failed step, then re-run.',
    },
    quality: {
      severity: 'error',
      title: 'Quality check failed before diagnostics were reported',
      detail:
        'GitHub confirmed the quality workflow failed, but it did not provide test, lint, typecheck, or scan output.',
      hint: 'Open the workflow logs, fix the first failed quality step, then re-run. Updated ALPHACI workflows report the failed job here automatically.',
    },
    package: {
      severity: 'error',
      title: 'Build or package check failed before diagnostics were reported',
      detail:
        'GitHub confirmed the package workflow failed, but it did not provide the failed build step or error output.',
      hint: 'Open the workflow logs, fix the first failed build or package step, then re-run the workflow.',
    },
  };

  return fallback[stage];
}

export function translateResults(
  stage: Stage,
  conclusion: Conclusion,
  results: CiResults,
  rawLogs?: string,
): FriendlyMessage[] {
  const messages: FriendlyMessage[] = [];

  if (conclusion === 'cancelled') {
    messages.push({
      severity: 'info',
      title: 'Stage was cancelled',
      detail: 'The CI stage was cancelled before completing.',
      hint: 'Re-run the workflow when ready.',
    });
    return messages;
  }

  if (conclusion === 'failure' && !hasResults(results)) {
    messages.push(unreportedFailureMessage(stage, rawLogs));
    return messages;
  }

  const { tests, coverage, lint, security } = results;

  if (tests !== undefined) {
    if (tests.failed > 0) {
      const base: FriendlyMessage = {
        severity: 'error',
        title: `${String(tests.failed)} test(s) failed`,
        detail: `${String(tests.failed)} of ${String(tests.total)} tests failed.`,
        hint: 'Check the GitHub Actions output for failing test details.',
      };

      if (tests.failures !== undefined && tests.failures.length > 0) {
        const raw = tests.failures.map((f) => ({
          label: f.name,
          ...(f.message !== undefined && { sub: f.message }),
        }));
        messages.push({ ...base, items: capItems(raw) });
      } else {
        messages.push(base);
      }
    } else if (conclusion === 'success') {
      messages.push({
        severity: 'success',
        title: 'All tests passed',
        detail: `${String(tests.passed)} test(s) passed.`,
        hint: '',
      });
    }
  }

  if (coverage !== undefined && coverage.pct < coverage.threshold) {
    messages.push({
      severity: 'warning',
      title: 'Coverage below threshold',
      detail: `${String(coverage.pct)}% coverage but requires ${String(coverage.threshold)}%.`,
      hint: 'Add more tests to bring coverage up to the required threshold.',
    });
  }

  if (lint !== undefined) {
    if (lint.errors > 0) {
      const base: FriendlyMessage = {
        severity: 'error',
        title: `${String(lint.errors)} lint error(s)`,
        detail: `${String(lint.errors)} lint errors found.`,
        hint: 'Run `npm run lint -- --fix` to auto-fix issues.',
      };

      if (lint.issues !== undefined && lint.issues.length > 0) {
        const raw = lint.issues.map((issue) => {
          const label = issue.rule ?? 'lint';
          const filePart = issue.file ?? '';
          const linePart =
            issue.line !== undefined ? `:${String(issue.line)}` : '';
          const sub = `${filePart}${linePart}`;
          return {
            label,
            ...(sub !== '' && { sub }),
          };
        });
        messages.push({ ...base, items: capItems(raw) });
      } else {
        messages.push(base);
      }
    } else if (lint.warnings > 0) {
      messages.push({
        severity: 'warning',
        title: `${String(lint.warnings)} lint warning(s)`,
        detail: `${String(lint.warnings)} lint warnings found. No errors.`,
        hint: 'Consider fixing lint warnings to keep the codebase clean.',
      });
    }
  }

  if (security !== undefined) {
    if (security.critical > 0) {
      const base: FriendlyMessage = {
        severity: 'error',
        title: `${String(security.critical)} critical vulnerability(s)`,
        detail: `${String(security.critical)} critical security vulnerability(s) found.`,
        hint: 'Run `npm audit` to view details and apply fixes.',
      };

      if (security.items !== undefined && security.items.length > 0) {
        const raw = security.items
          .filter((item) => item.severity === 'critical')
          .map((item) => {
            const label = item.package ?? item.id ?? 'vulnerability';
            const parts: string[] = [];
            if (item.severity !== undefined) parts.push(item.severity);
            if (item.title !== undefined) parts.push(item.title);
            const sub = parts.join(' — ');
            return {
              label,
              ...(sub !== '' && { sub }),
            };
          });
        // Fall back to all items if the critical filter yields nothing
        // (e.g. severity field absent but critical count > 0)
        const source =
          raw.length > 0
            ? raw
            : security.items.map((item) => {
                const label = item.package ?? item.id ?? 'vulnerability';
                const parts: string[] = [];
                if (item.severity !== undefined) parts.push(item.severity);
                if (item.title !== undefined) parts.push(item.title);
                const sub = parts.join(' — ');
                return { label, ...(sub !== '' && { sub }) };
              });
        messages.push({ ...base, items: capItems(source) });
      } else {
        messages.push(base);
      }
    } else if (security.high > 0) {
      const base: FriendlyMessage = {
        severity: 'warning',
        title: `${String(security.high)} high-severity vulnerability(s)`,
        detail: `${String(security.high)} high-severity vulnerability(s) found.`,
        hint: 'Run `npm audit` to view details and apply fixes.',
      };

      if (security.items !== undefined && security.items.length > 0) {
        const raw = security.items.map((item) => {
          const label = item.package ?? item.id ?? 'vulnerability';
          const parts: string[] = [];
          if (item.severity !== undefined) parts.push(item.severity);
          if (item.title !== undefined) parts.push(item.title);
          const sub = parts.join(' — ');
          return {
            label,
            ...(sub !== '' && { sub }),
          };
        });
        messages.push({ ...base, items: capItems(raw) });
      } else {
        messages.push(base);
      }
    }
  }

  return messages;
}
