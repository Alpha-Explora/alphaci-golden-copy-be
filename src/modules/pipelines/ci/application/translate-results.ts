import type { StageId } from './stages';

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
  /**
   * Counts from gates that pass while still having found something.
   *
   * Advisory on dev, blocking on uat and main. The count is what separates
   * "passed, clean" from "passed, 3 findings, and uat will reject them".
   */
  findings?: {
    secrets?: number;
    forbiddenLicenses?: number;
    sbomComponents?: number;
  };
  /**
   * What SonarCloud reported, rather than only whether it passed.
   *
   * `gate` of UNKNOWN means the analysis ran and the gate could not be read,
   * which is deliberately not the same as a gate that passed.
   */
  sonar?: {
    gate?: string;
    failedConditions?: {
      metric: string;
      status?: string;
      actual?: string;
      threshold?: string;
    }[];
    measures?: Record<string, string>;
  };
  /** Every job in the stage and what it concluded — the per-tool view. */
  checks?: {
    name: string;
    conclusion: string;
    startedAt?: string;
    completedAt?: string;
  }[];
}

type Stage = StageId;
type Conclusion = 'success' | 'failure' | 'cancelled';
type MessageItem = { label: string; sub?: string };
type TestsResult = NonNullable<CiResults['tests']>;
type LintResult = NonNullable<CiResults['lint']>;
type SecurityResult = NonNullable<CiResults['security']>;
type FailedJobKind =
  | 'lint'
  | 'typecheck'
  | 'test'
  | 'build'
  | 'security'
  | 'unknown';

/** Maximum number of detail items surfaced in a FriendlyMessage. */
const ITEMS_CAP = 20;

const DEFAULT_FAILED_JOB_HINT =
  'Open the workflow logs, fix the first failed job listed below, then re-run the workflow.';

/** First matching kind wins — same precedence as the previous nested ternaries. */
const FAILED_JOB_KIND_NEEDLES: ReadonlyArray<{
  kind: Exclude<FailedJobKind, 'unknown'>;
  needles: readonly string[];
}> = [
  { kind: 'lint', needles: ['lint'] },
  { kind: 'typecheck', needles: ['type', 'tsc'] },
  { kind: 'test', needles: ['test'] },
  { kind: 'build', needles: ['build', 'package'] },
  { kind: 'security', needles: ['sonar', 'security', 'audit'] },
];

const FAILED_JOB_COPY: Record<
  Exclude<FailedJobKind, 'unknown'>,
  { title: string; hint: string }
> = {
  lint: {
    title: 'Lint check failed',
    hint: 'Run npm run lint locally, fix the reported violations, then re-run the workflow.',
  },
  typecheck: {
    title: 'Type check failed',
    hint: 'Run npm run typecheck locally, fix the reported TypeScript errors, then re-run the workflow.',
  },
  test: {
    title: 'Tests failed',
    hint: 'Run the failing test command locally, fix the first failure, then re-run the workflow.',
  },
  build: {
    title: 'Build or package step failed',
    hint: 'Run the project build locally, fix the first build error, then re-run the workflow.',
  },
  security: {
    title: 'Security or code-quality check failed',
    hint: DEFAULT_FAILED_JOB_HINT,
  },
};

/**
 * Build a capped items array for a FriendlyMessage.
 * If the source array has more than ITEMS_CAP entries, a trailing summary item
 * ("…and N more") is appended instead of the overflow entries.
 */
function capItems(source: MessageItem[]): MessageItem[] {
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

function classifyFailedJob(jobName: string): FailedJobKind {
  const job = jobName.toLowerCase();
  for (const rule of FAILED_JOB_KIND_NEEDLES) {
    if (rule.needles.some((needle) => job.includes(needle))) {
      return rule.kind;
    }
  }
  return 'unknown';
}

function failedJobCopy(
  kind: FailedJobKind,
  jobName: string,
): { title: string; hint: string } {
  if (kind !== 'unknown') {
    return FAILED_JOB_COPY[kind];
  }
  return {
    title: `GitHub job "${jobName}" failed`,
    hint: DEFAULT_FAILED_JOB_HINT,
  };
}

/**
 * One error GitHub recorded against a failed job.
 *
 * Sent by pipelines generated after failure capture was added; absent from
 * older ones, which is why every field is optional and the list may be empty.
 */
export interface CiAnnotation {
  path?: string;
  line?: number;
  title?: string;
  message?: string;
}

/**
 * Annotations as message items: the concrete errors, with where they are.
 *
 * `label` leads with the location because that is what someone acts on first —
 * the file and line they have to open. The message follows as context.
 */
function annotationItems(annotations: readonly CiAnnotation[]): MessageItem[] {
  return capItems(
    annotations.map((annotation) => {
      const where =
        annotation.path === undefined
          ? undefined
          : annotation.line === undefined
            ? annotation.path
            : `${annotation.path}:${String(annotation.line)}`;
      const text = annotation.message ?? annotation.title ?? '';

      return {
        label: where ?? annotation.title ?? text,
        ...(where !== undefined && text !== '' && { sub: text }),
      };
    }),
  );
}

function unreportedFailureMessage(
  stage: Stage,
  rawLogs?: string,
  annotations: readonly CiAnnotation[] = [],
): FriendlyMessage {
  const failedJobs = reportedFailedJobs(rawLogs);

  // Annotations are the actual errors, so they outrank the job name. A job
  // name says where to look; an annotation says what is wrong and on which
  // line, which is the whole point of not sending people to GitHub.
  if (annotations.length > 0) {
    // With a job name we can say which check failed. Without one, the
    // annotations still stand on their own — they name the files and lines.
    const copy =
      failedJobs.length > 0
        ? failedJobCopy(classifyFailedJob(failedJobs[0]!), failedJobs[0]!)
        : {
            title: `The ${stage} stage reported errors`,
            hint: DEFAULT_FAILED_JOB_HINT,
          };
    return {
      severity: 'error',
      title: copy.title,
      detail: `GitHub reported ${annotations.length === 1 ? '1 error' : `${String(annotations.length)} errors`} in the ${stage} stage.`,
      hint: copy.hint,
      items: annotationItems(annotations),
    };
  }

  if (failedJobs.length > 0) {
    const firstJob = failedJobs[0]!;
    const copy = failedJobCopy(classifyFailedJob(firstJob), firstJob);
    return {
      severity: 'error',
      title: copy.title,
      detail: `GitHub reported ${failedJobs.length === 1 ? 'this failed job' : `${String(failedJobs.length)} failed jobs`} for the ${stage} stage.`,
      hint: copy.hint,
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
    /*
     * Verify fails differently from the three before it, and the wording has to
     * say so. Those read source, so a failure is in the commit. This one drove
     * a DEPLOYED service, so the same red can mean the code is wrong, the
     * deployment is wrong, or the environment it was pointed at is wrong —
     * and sending someone to re-read the diff first is sending them to the
     * wrong place two times out of three.
     */
    verify: {
      severity: 'error',
      title: 'The deployed service failed its API checks',
      detail:
        'GitHub confirmed the verify workflow failed, but it did not provide the failing request or assertion.',
      hint: 'Check the deployment answered at all before reading the code: an environment that never started fails every request the same way. The uploaded results file lists each request and assertion.',
    },
  };

  return fallback[stage];
}

function toTestFailureItem(
  failure: NonNullable<TestsResult['failures']>[number],
): MessageItem {
  return {
    label: failure.name,
    ...(failure.message !== undefined && { sub: failure.message }),
  };
}

function pushTestMessages(
  messages: FriendlyMessage[],
  tests: TestsResult,
  conclusion: Conclusion,
): void {
  if (tests.failed > 0) {
    const base: FriendlyMessage = {
      severity: 'error',
      title: `${String(tests.failed)} test(s) failed`,
      detail: `${String(tests.failed)} of ${String(tests.total)} tests failed.`,
      hint: 'Check the GitHub Actions output for failing test details.',
    };

    if (tests.failures !== undefined && tests.failures.length > 0) {
      messages.push({
        ...base,
        items: capItems(tests.failures.map(toTestFailureItem)),
      });
    } else {
      messages.push(base);
    }
    return;
  }

  if (conclusion === 'success') {
    messages.push({
      severity: 'success',
      title: 'All tests passed',
      detail: `${String(tests.passed)} test(s) passed.`,
      hint: '',
    });
  }
}

function toLintIssueItem(
  issue: NonNullable<LintResult['issues']>[number],
): MessageItem {
  const label = issue.rule ?? 'lint';
  const filePart = issue.file ?? '';
  const linePart = issue.line !== undefined ? `:${String(issue.line)}` : '';
  const sub = `${filePart}${linePart}`;
  return {
    label,
    ...(sub !== '' && { sub }),
  };
}

function pushLintMessages(messages: FriendlyMessage[], lint: LintResult): void {
  if (lint.errors > 0) {
    const base: FriendlyMessage = {
      severity: 'error',
      title: `${String(lint.errors)} lint error(s)`,
      detail: `${String(lint.errors)} lint errors found.`,
      hint: 'Run `npm run lint -- --fix` to auto-fix issues.',
    };

    if (lint.issues !== undefined && lint.issues.length > 0) {
      messages.push({
        ...base,
        items: capItems(lint.issues.map(toLintIssueItem)),
      });
    } else {
      messages.push(base);
    }
    return;
  }

  if (lint.warnings > 0) {
    messages.push({
      severity: 'warning',
      title: `${String(lint.warnings)} lint warning(s)`,
      detail: `${String(lint.warnings)} lint warnings found. No errors.`,
      hint: 'Consider fixing lint warnings to keep the codebase clean.',
    });
  }
}

function toSecurityItem(
  item: NonNullable<SecurityResult['items']>[number],
): MessageItem {
  const label = item.package ?? item.id ?? 'vulnerability';
  const parts: string[] = [];
  if (item.severity !== undefined) parts.push(item.severity);
  if (item.title !== undefined) parts.push(item.title);
  const sub = parts.join(' — ');
  return {
    label,
    ...(sub !== '' && { sub }),
  };
}

type SonarResult = NonNullable<CiResults['sonar']>;

/**
 * Say what SonarCloud found, in the product, in words.
 *
 * "Quality gate failed" is the same non-answer as "the quality stage failed"
 * one level down: it tells a reader something is wrong and nothing about what,
 * and the only way on was to open SonarCloud. Each failed condition carries the
 * metric, the value it reached and the threshold it had to clear, so the
 * message can name the gap instead of pointing at a dashboard.
 */
function pushSonarMessages(
  messages: FriendlyMessage[],
  sonar: SonarResult,
): void {
  if (sonar.gate === 'ERROR') {
    const conditions = sonar.failedConditions ?? [];

    messages.push({
      severity: 'error',
      title: 'SonarCloud quality gate failed',
      detail:
        conditions.length > 0
          ? `${String(conditions.length)} quality gate condition(s) were not met.`
          : 'SonarCloud rejected the analysis against its quality gate.',
      hint: 'Fix the conditions listed below. Each shows the value reached and the value required.',
      ...(conditions.length > 0 && {
        items: capItems(
          conditions.map((condition) => ({
            label: `${condition.metric}: ${condition.actual ?? 'unknown'}`,
            // Omitted rather than set undefined: exactOptionalPropertyTypes
            // draws the distinction, and a present-but-undefined `sub`
            // serialises into the payload as an explicit null.
            ...(condition.threshold !== undefined && {
              sub: `required ${condition.threshold}`,
            }),
          })),
        ),
      }),
    });
  }

  /*
   * A gate that could not be read is reported, not ignored.
   *
   * It means the analysis ran and the verdict did not come back — a rate limit,
   * a permissions change, an API that moved. Passing over it in silence leaves
   * the stage looking clean on the strength of a check nobody actually heard
   * the result of.
   */
  if (sonar.gate === 'UNKNOWN') {
    messages.push({
      severity: 'warning',
      title: 'SonarCloud quality gate could not be read',
      detail:
        'The analysis ran, but its quality gate result could not be retrieved.',
      hint: 'Treat this stage as unverified by SonarCloud rather than as passing it. Check the SonarCloud token and the project key.',
    });
  }

  const measures = sonar.measures;
  if (measures === undefined) {
    return;
  }

  // Reported whatever the gate said: a gate can pass while the project still
  // carries bugs, and a reader looking for the number should not have to fail
  // the build first to be shown it.
  const counted: { key: string; label: string }[] = [
    { key: 'bugs', label: 'bug(s)' },
    { key: 'vulnerabilities', label: 'vulnerability(s)' },
    { key: 'security_hotspots', label: 'security hotspot(s)' },
    { key: 'code_smells', label: 'code smell(s)' },
  ];

  const found = counted
    .map(({ key, label }) => ({ label, value: Number(measures[key] ?? '0') }))
    .filter((entry) => Number.isFinite(entry.value) && entry.value > 0);

  if (found.length > 0) {
    messages.push({
      severity: sonar.gate === 'ERROR' ? 'warning' : 'info',
      title: 'SonarCloud findings',
      detail: found
        .map((entry) => `${String(entry.value)} ${entry.label}`)
        .join(', '),
      hint: 'These do not necessarily fail the gate. The gate decides on new code; these are the totals for the project.',
    });
  }
}

function pushSecurityMessages(
  messages: FriendlyMessage[],
  security: SecurityResult,
): void {
  if (security.critical > 0) {
    const base: FriendlyMessage = {
      severity: 'error',
      title: `${String(security.critical)} critical vulnerability(s)`,
      detail: `${String(security.critical)} critical security vulnerability(s) found.`,
      // Tool-neutral: this path now serves .NET as well, where the command
      // is `dotnet list package --vulnerable`, and naming the wrong one is
      // worse than naming none. The packages are listed below regardless.
      hint: 'Upgrade the packages listed below to a version without the advisory.',
    };

    if (security.items !== undefined && security.items.length > 0) {
      const raw = security.items
        .filter((item) => item.severity === 'critical')
        .map(toSecurityItem);
      // Fall back to all items if the critical filter yields nothing
      // (e.g. severity field absent but critical count > 0)
      const source = raw.length > 0 ? raw : security.items.map(toSecurityItem);
      messages.push({ ...base, items: capItems(source) });
    } else {
      messages.push(base);
    }
    return;
  }

  if (security.high > 0) {
    const base: FriendlyMessage = {
      severity: 'warning',
      title: `${String(security.high)} high-severity vulnerability(s)`,
      detail: `${String(security.high)} high-severity vulnerability(s) found.`,
      // Tool-neutral: this path now serves .NET as well, where the command
      // is `dotnet list package --vulnerable`, and naming the wrong one is
      // worse than naming none. The packages are listed below regardless.
      hint: 'Upgrade the packages listed below to a version without the advisory.',
    };

    if (security.items !== undefined && security.items.length > 0) {
      messages.push({
        ...base,
        items: capItems(security.items.map(toSecurityItem)),
      });
    } else {
      messages.push(base);
    }
  }
}

export function translateResults(
  stage: Stage,
  conclusion: Conclusion,
  results: CiResults,
  rawLogs?: string,
  annotations: readonly CiAnnotation[] = [],
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

  const { tests, coverage, lint, security, sonar } = results;

  if (tests !== undefined) {
    pushTestMessages(messages, tests, conclusion);
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
    pushLintMessages(messages, lint);
  }

  if (security !== undefined) {
    pushSecurityMessages(messages, security);
  }

  if (sonar !== undefined) {
    pushSonarMessages(messages, sonar);
  }

  /*
   * A failure must always be explained.
   *
   * This used to run only when `results` was empty, which quietly assumed that
   * any result data would account for the failure. It does not. A quality stage
   * that reported `{coverage: {pct: 100, threshold: 90}}` and failed on its
   * Sonar job satisfied that guard, passed every check below it — 100 is above
   * 90 — and returned NO messages at all. The stage showed as failed with
   * nothing said about why, and the `rawLogs` naming the failed job were
   * discarded. That is the single reason the product sent people to GitHub to
   * find out what broke.
   *
   * The condition is therefore about the messages, not the inputs: if nothing
   * above has already reported an error, the failure is still unexplained and
   * gets the generic account. A stage whose results DO explain it — failing
   * tests, lint errors, vulnerabilities — is left alone rather than given a
   * second, vaguer message saying the same thing.
   *
   * Placed first, because the reason a stage failed outranks a warning about
   * coverage that did not cause it.
   */
  if (
    conclusion === 'failure' &&
    !messages.some((message) => message.severity === 'error')
  ) {
    messages.unshift(unreportedFailureMessage(stage, rawLogs, annotations));
  }

  return messages;
}
