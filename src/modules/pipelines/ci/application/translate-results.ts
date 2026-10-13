import type { CiTestCase } from '#kernel/ports/ci-stage-results.port';
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
    /** Every browser test with its detail, when the pipeline reports it. */
    cases?: CiTestCase[];
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
    /** Could not be determined — not forbidden, but not cleared either. */
    undeterminedLicenses?: number;
    /** Rule and location only. Never the secret value. */
    secretItems?: { rule?: string; file?: string; line?: number }[];
    licenseItems?: { package?: string; version?: string; license?: string }[];
  };
  /**
   * What SonarCloud reported, rather than only whether it passed.
   *
   * `gate` of UNKNOWN means the analysis ran and the gate could not be read,
   * which is deliberately not the same as a gate that passed.
   */
  sonar?: {
    gate?: string;
    /** A setting stopped the analysis, rather than the code failing it. */
    blockedBy?: string;
    failedConditions?: {
      metric: string;
      status?: string;
      actual?: string;
      threshold?: string;
    }[];
    measures?: Record<string, string>;
    /** The most severe issues on new code, at most 20. */
    issues?: {
      rule: string;
      severity?: string;
      type?: string;
      message: string;
      file?: string;
      line?: number;
    }[];
  };
  /**
   * The stage left its work out on purpose, and says why. Reported as a
   * success (the stage did not fail) and read back as not run.
   */
  skipped?: { reason: string };
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
  | 'publish'
  | 'security'
  | 'deployment'
  | 'schema'
  | 'targets'
  | 'promotion'
  | 'unknown';

/*
 * ANSI escape sequences (colour, bold, cursor) that a test runner or compiler
 * prints into its output. Playwright colours its assertion messages, and the
 * codes arrived in the product as `[31m`-style noise around the words. Built
 * from the character code rather than written as a literal so the control
 * character is not in the source, which `no-control-regex` rightly rejects.
 */
const ESCAPE = String.fromCharCode(27);
const ANSI_SEQUENCE = new RegExp(
  String.raw`${ESCAPE}\[[0-9;?]*[ -/]*[@-~]`,
  'g',
);

/** Remove ANSI escape sequences from text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE, '');
}

/** `stripAnsi` over every string inside a value of any shape. */
export function stripAnsiDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return stripAnsi(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => stripAnsiDeep(entry)) as T;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, stripAnsiDeep(entry)]),
    ) as T;
  }
  return value;
}

/** `Program.cs:null` is a location with the line missing. Drop the `:null`. */
function dropNullLine(text: string): string {
  return text.replace(/:null(?=\s|$)/g, '');
}

/**
 * Messages as they should be shown, whenever they were written.
 *
 * Applied at ingest AND on read. Ingest alone would fix new reports and leave
 * every stored one with its escape codes and its `:null` locations; reading
 * through the same function makes history benefit without a backfill.
 */
export function cleanMessages(
  messages: readonly FriendlyMessage[],
): FriendlyMessage[] {
  return messages.map((message) => ({
    ...message,
    title: stripAnsi(message.title),
    detail: stripAnsi(message.detail),
    hint: stripAnsi(message.hint),
    ...(message.items !== undefined && {
      items: message.items.map((item) => ({
        label: dropNullLine(stripAnsi(item.label)),
        ...(item.sub !== undefined && {
          sub: dropNullLine(stripAnsi(item.sub)),
        }),
      })),
    }),
  }));
}

/**
 * Re-label a STORED verify failure that was filed under the wrong kind.
 *
 * Messages are written at ingest, so history keeps whatever the translator said
 * then. For verify that was "Tests failed - run the failing test command
 * locally" on a run that never got past waiting for the deployment, because
 * the job id (`api-tests-uat`) contains `test`. The failed step is stored in
 * `rawLogs`, so the correct copy can be put back on read, without a backfill.
 * Only the title and hint are replaced, and only where the stored message still
 * carries the misleading copy; the detail and items are left as they were.
 */
export function reclassifyStoredFailure(
  stage: Stage,
  messages: readonly FriendlyMessage[],
  rawLogs: string | null | undefined,
): FriendlyMessage[] {
  const first = reportedFailedJobs(rawLogs ?? undefined)[0];
  if (first === undefined) {
    return [...messages];
  }

  const kind = classifyFailedJob(first, stage);
  if (kind !== 'deployment' && kind !== 'schema' && kind !== 'targets') {
    return [...messages];
  }

  const copy = FAILED_JOB_COPY[kind];
  const stale = new Set([
    FAILED_JOB_COPY.test.title,
    `GitHub job "${first}" failed`,
  ]);

  return messages.map((message) =>
    message.severity === 'error' && stale.has(message.title)
      ? { ...message, title: copy.title, hint: copy.hint }
      : message,
  );
}

/** What a stage that left its work out on purpose shows in place of results. */
export function skippedMessage(reason: string): FriendlyMessage {
  return {
    severity: 'info',
    title: 'Not run',
    detail: reason,
    hint: 'This is not a failure of the code. Once the missing piece exists, the next run tests it.',
  };
}

/** Maximum number of detail items surfaced in a FriendlyMessage. */
const ITEMS_CAP = 20;

const DEFAULT_FAILED_JOB_HINT =
  'Open the workflow logs, fix the first failed job listed below, then re-run the workflow.';

/**
 * First matching kind wins.
 *
 * `publish` leads deliberately. A container job is called "Docker Build &
 * Push", so matching `build` first classified a failed REGISTRY PUSH as a
 * build error and told the reader to build locally - which succeeds, proves
 * nothing, and sends them looking in their own code for a fault that was
 * never there. Shipping an artifact and compiling one fail for unrelated
 * reasons and cannot share a remedy.
 */
const FAILED_JOB_KIND_NEEDLES: ReadonlyArray<{
  kind: Exclude<FailedJobKind, 'unknown'>;
  needles: readonly string[];
}> = [
  /*
   * Named for what the job DOES, never for a provider. Provider names belong
   * inside the runtime module - check:provider-encapsulation enforces that,
   * and correctly rejected an earlier version of this list that spelled out
   * two of them. They were redundant anyway: every provider deploy job is
   * generated as `deploy-<provider>-...`, so `deploy` already catches them,
   * and a provider added later is caught without touching this file.
   */
  {
    kind: 'publish',
    needles: ['docker', 'deploy', 'registry', 'publish', 'image'],
  },
  { kind: 'lint', needles: ['lint'] },
  { kind: 'typecheck', needles: ['type', 'tsc'] },
  { kind: 'test', needles: ['test'] },
  { kind: 'build', needles: ['build', 'package'] },
  {
    kind: 'security',
    needles: ['sonar', 'security', 'audit', 'licen', 'secret', 'sbom'],
  },
];

/**
 * A step name that says the deployed service never answered.
 *
 * Matched on the STEP, not the job. The job is `api-tests-uat`, which contains
 * `test`, so classifying by id alone filed a failure to wait for the
 * deployment under "Tests failed - run the failing test command locally":
 * advice that cannot help, because nothing was tested.
 */
const DEPLOYMENT_WAIT_STEP =
  /wait for .*(deploy|health|service)|health ?check/i;

/** A step name that says no OpenAPI document could be located. */
const SCHEMA_STEP = /locate schema|openapi|swagger/i;

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
  /*
   * No local reproduction step, because there usually is not one. These jobs
   * fail on registry credentials, a cache the runner could not reserve, a
   * provider quota or a provider outage - none of which a local build can
   * show. Naming that is the useful part: it tells the reader the fault is
   * probably not in their code, which is the opposite of what they were
   * being told before.
   */
  publish: {
    title: 'Image or deployment step failed',
    hint: 'This step ships the artifact rather than compiling it, so a local build will not reproduce it. Open the stage in the project view for the error output.',
  },
  security: {
    title: 'Security or code-quality check failed',
    hint: DEFAULT_FAILED_JOB_HINT,
  },
  /*
   * The post-deploy tests never started: they poll the deployed service until
   * it answers its health check, and it did not. The fault is the deployment
   * (crashed on start, still cold, wrong address), not the code under test.
   */
  deployment: {
    title: 'The deployment never became healthy',
    hint: 'The post-deploy tests wait for the deployed service to answer its health check, and it never did, so nothing was tested. Check the deploy step of the package stage and the hosting provider logs for a service that failed to start, then run the pipeline again.',
  },
  schema: {
    title: 'No OpenAPI document found',
    hint: 'The contract tests need an OpenAPI document and could not find one in the repository. Commit one (openapi.json or swagger.json at the service root) or publish it from the running service, then run the pipeline again.',
  },
  targets: {
    title: 'The deployed service could not be located',
    hint: 'The post-deploy tests could not work out where the service is deployed, so nothing was tested. Provision hosting for this project in ALPHACI, or restore the repository variable named in the job output, then run the pipeline again.',
  },
  promotion: {
    title: 'The promotion pull request could not be created',
    hint: 'The build and deploy passed, but the pull request into the next branch failed. The reason is listed below: usually a token that may not open pull requests, or a branch protection rule that rejected it.',
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

/**
 * The job id, which is the only part of the name we choose.
 *
 * A reported job reads `<id> / <Display Name> > <step>`, and the two halves
 * after the id are not ours: the display name comes from the reusable
 * workflow and ends with the repository's own name. That is not cosmetic.
 * "production-gate / Production Readiness - stpetertest" was classified as a
 * TEST failure, because the repository is called stpetertest and the needle
 * `test` matched inside it - so a failed production gate told the reader to
 * go and run their tests. Any project whose name contains `test`, `build` or
 * `lint` inherited the same fault.
 */
function failedJobId(jobName: string): string {
  return (jobName.split(' > ')[0] ?? jobName).split(' / ')[0]!.trim();
}

/** The step a reported job failed in, when the report names one. */
function failedStepName(jobName: string): string {
  const index = jobName.indexOf(' > ');
  return index === -1 ? '' : jobName.slice(index + 3).trim();
}

function classifyFailedJob(jobName: string, stage?: Stage): FailedJobKind {
  const job = failedJobId(jobName).toLowerCase();

  /*
   * The step outranks the job id, in the verify stage above all: every job
   * there is called `*-tests-*`, so the id alone says "a test failed" for a
   * run that never got as far as testing anything.
   */
  const step = failedStepName(jobName);
  if (stage === 'verify' || stage === undefined) {
    if (DEPLOYMENT_WAIT_STEP.test(step)) {
      return 'deployment';
    }
    if (SCHEMA_STEP.test(step)) {
      return 'schema';
    }
  }
  if (job === 'resolve-targets') {
    return 'targets';
  }
  if (job.startsWith('promote-to-')) {
    return 'promotion';
  }

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
  stage?: Stage,
): { title: string; hint: string } {
  /*
   * A verify test that really failed drove a DEPLOYED service, so "run the
   * failing test command locally" points at the wrong place: the same red can
   * be the code, the deployment or the environment.
   */
  if (kind === 'test' && stage === 'verify') {
    return {
      title: 'Post-deploy tests failed',
      hint: 'These tests drive the deployed service, so the failure can be the code, the deployment or its environment. The reasons listed below say which request or assertion failed.',
    };
  }
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
  path?: string | null;
  line?: number | null;
  title?: string | null;
  message?: string | null;
  /**
   * GitHub's severity: 'failure', 'warning' or 'notice'.
   *
   * The same diagnostic means different things per branch. On dev a formatter
   * reports warnings and the job still passes; on uat that identical
   * annotation is what fails the build. Without the level, advice and a block
   * are indistinguishable.
   */
  level?: string | null;
}

/**
 * A line number that is a number. The payload carries `null` for an annotation
 * with no line, and `Program.cs:null` is what a template literal made of it.
 */
function hasLine(line: unknown): line is number {
  return typeof line === 'number' && Number.isFinite(line);
}

function isWorkflowLevel(path: string | undefined | null): boolean {
  return path !== undefined && path !== null && path.startsWith('.github');
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
      const text = annotation.message ?? annotation.title ?? '';

      /*
       * A workflow-level `::error::` is attributed to `.github`, which is the
       * folder the workflow file sits in and not a place anyone can fix. Its
       * message IS the finding ("Repository variable VERCEL_ALIAS is not set"),
       * so it leads, with no location to mislead.
       */
      if (isWorkflowLevel(annotation.path) && text !== '') {
        return { label: text };
      }

      const where =
        annotation.path === undefined || annotation.path === null
          ? undefined
          : hasLine(annotation.line)
            ? `${annotation.path}:${String(annotation.line)}`
            : annotation.path;

      return {
        label: where ?? annotation.title ?? text,
        ...(where !== undefined && text !== '' && { sub: text }),
      };
    }),
  );
}

/**
 * Diagnostics that did not stop this stage, said out loud anyway.
 *
 * These were collected and then dropped. The message below only ever ran when a
 * failure had nothing else to explain it, so on dev — where the gates are
 * advisory and the stage therefore concludes SUCCESS — the annotations were
 * fetched, sent, stored, and never shown. The one branch where there is still
 * time to act on a diagnostic was the one branch that never displayed one.
 *
 * It also covers a failure that already has an explanation: tests failing does
 * not make twelve formatter diagnostics uninteresting, and the old guard threw
 * them away because an error message already existed.
 */
function advisoryAnnotationMessage(
  stage: Stage,
  conclusion: Conclusion,
  annotations: readonly CiAnnotation[],
): FriendlyMessage {
  const blocking = conclusion === 'failure';
  const count = annotations.length;
  const noun = count === 1 ? 'diagnostic' : 'diagnostics';

  return {
    // Never an error on a stage that passed. Marking a green stage red in the
    // summary would be its own lie, in the opposite direction.
    severity: blocking ? 'error' : 'warning',
    title: blocking
      ? `${String(count)} more ${noun} in the ${stage} stage`
      : `${String(count)} ${noun} reported without failing this stage`,
    detail: blocking
      ? `Reported alongside the failure above.`
      : `The ${stage} stage passed. These were reported as advice on this branch.`,
    hint: blocking
      ? 'Each names the file and line it was raised on.'
      : 'Warnings are advisory on the working branch and fail the build on uat and main. Fixing them here costs nothing; leaving them blocks the promotion.',
    items: annotationItems(annotations),
  };
}

/**
 * Every failed job: the ones the stage named, then any the per-tool list adds.
 *
 * The workflow only names five, and on a repository where the failed-job lookup
 * is not permitted it names none, while `checks` carries every job with its
 * conclusion. Taking both is what lets a failed audit be recognised, and every
 * failed job listed, whichever of the two the pipeline managed to send.
 */
function failedJobsOf(
  rawLogs: string | undefined,
  checks: CiResults['checks'],
): string[] {
  const named = reportedFailedJobs(rawLogs);
  const seen = new Set(named.map((job) => failedJobId(job).toLowerCase()));
  const extra: string[] = [];

  for (const check of checks ?? []) {
    if (check.conclusion !== 'failure') {
      continue;
    }
    const id = failedJobId(check.name).toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      extra.push(check.name);
    }
  }

  return [...named, ...extra];
}

/**
 * Whether an error message already produced from `results` accounts for a
 * failed job, so the job is not listed a second time.
 *
 * Each rule mirrors one `push*Messages` above and only claims jobs that
 * message really explains: failing tests explain the test jobs, lint errors the
 * lint job, and so on. Anything else - a type check, a build, the licence scan
 * when no forbidden licence was reported - is not covered and gets listed.
 */
function coveredJobPredicate(
  results: CiResults,
  auditFailed: boolean,
): (jobId: string) => boolean {
  const needles: string[] = [];
  if ((results.tests?.failed ?? 0) > 0) needles.push('test');
  if ((results.lint?.errors ?? 0) > 0) needles.push('lint');
  if (
    (results.security?.critical ?? 0) > 0 ||
    ((results.security?.high ?? 0) > 0 && auditFailed)
  ) {
    needles.push('audit', 'security');
  }
  if ((results.findings?.secrets ?? 0) > 0) needles.push('secret');
  if ((results.findings?.forbiddenLicenses ?? 0) > 0) needles.push('licen');
  if (
    results.sonar?.gate === 'ERROR' ||
    results.sonar?.blockedBy === 'automatic-analysis'
  ) {
    needles.push('sonar');
  }

  return (jobId) => {
    const id = jobId.toLowerCase();
    return needles.some((needle) => id.includes(needle));
  };
}

function otherFailedJobsMessage(
  stage: Stage,
  jobs: readonly string[],
): FriendlyMessage {
  const first = jobs[0]!;
  const copy = failedJobCopy(classifyFailedJob(first, stage), first, stage);
  const single = jobs.length === 1;

  return {
    severity: 'error',
    title: single ? copy.title : `${String(jobs.length)} other jobs failed`,
    detail: single
      ? 'This job failed as well, and nothing above accounts for it.'
      : `${String(jobs.length)} more jobs failed in the ${stage} stage, and nothing above accounts for them.`,
    hint: single ? copy.hint : DEFAULT_FAILED_JOB_HINT,
    items: capItems(jobs.map((job) => ({ label: job }))),
  };
}

function unreportedFailureMessage(
  stage: Stage,
  failedJobs: readonly string[],
  annotations: readonly CiAnnotation[] = [],
): FriendlyMessage {
  // Annotations are the actual errors, so they outrank the job name. A job
  // name says where to look; an annotation says what is wrong and on which
  // line, which is the whole point of not sending people to GitHub.
  if (annotations.length > 0) {
    // With a job name we can say which check failed. Without one, the
    // annotations still stand on their own — they name the files and lines.
    const copy =
      failedJobs.length > 0
        ? failedJobCopy(
            classifyFailedJob(failedJobs[0]!, stage),
            failedJobs[0]!,
            stage,
          )
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
    const copy = failedJobCopy(
      classifyFailedJob(firstJob, stage),
      firstJob,
      stage,
    );
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
  const linePart = hasLine(issue.line) ? `:${String(issue.line)}` : '';
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

type FindingsResult = NonNullable<CiResults['findings']>;

/**
 * Say which secret and which licence, not how many.
 *
 * These counts were collected and stored and never turned into anything a
 * reader sees. Even shown, "3 findings" is barely better than a red tick: it
 * reports that a problem exists and leaves locating it as homework, which is
 * the trip to GitHub this is meant to replace.
 *
 * Severity follows the branch, not the finding. On dev these gates are
 * advisory — the job passes — so an error here would contradict a stage the
 * product just called green. The hint carries the part that matters instead:
 * it blocks at the promotion.
 */
function pushFindingsMessages(
  messages: FriendlyMessage[],
  findings: FindingsResult,
  conclusion: Conclusion,
): void {
  const blocking = conclusion === 'failure';

  const secrets = findings.secrets ?? 0;
  if (secrets > 0) {
    const items = findings.secretItems ?? [];

    messages.push({
      severity: blocking ? 'error' : 'warning',
      title: `${String(secrets)} committed secret(s)`,
      detail: blocking
        ? `${String(secrets)} secret(s) were found in the working tree.`
        : `${String(secrets)} secret(s) were found. Not blocking on this branch.`,
      // Rotation first. Removing the line does not un-leak anything that has
      // already been pushed, and a secret treated as fixed because it is gone
      // from HEAD is still live wherever it was published.
      hint: 'Rotate each secret first — deleting the line does not revoke a credential that has already been pushed — then remove it from the code and use a repository secret.',
      ...(items.length > 0 && {
        items: capItems(
          items.map((item) => ({
            label:
              item.file === undefined
                ? (item.rule ?? 'secret')
                : hasLine(item.line)
                  ? `${item.file}:${String(item.line)}`
                  : item.file,
            ...(item.rule !== undefined && { sub: item.rule }),
          })),
        ),
      }),
    });
  }

  const forbidden = findings.forbiddenLicenses ?? 0;
  if (forbidden > 0) {
    const items = findings.licenseItems ?? [];

    messages.push({
      severity: blocking ? 'error' : 'warning',
      title: `${String(forbidden)} package(s) under a forbidden licence`,
      detail: blocking
        ? `${String(forbidden)} dependency licence(s) are not permitted.`
        : `${String(forbidden)} dependency licence(s) are not permitted. Not blocking on this branch.`,
      hint: 'Replace the package, or record an exception, before promoting to uat.',
      ...(items.length > 0 && {
        items: capItems(
          items.map((item) => ({
            label: `${item.package ?? 'unknown'}${
              item.version === undefined ? '' : `@${item.version}`
            }`,
            ...(item.license !== undefined && { sub: item.license }),
          })),
        ),
      }),
    });
  }

  /*
   * Reported, never counted as forbidden.
   *
   * A licence nobody could read is not a licence nobody needs to read. Folding
   * it into the forbidden count would invent a violation; dropping it silently
   * would clear a dependency on the strength of a question nobody answered.
   */
  const undetermined = findings.undeterminedLicenses ?? 0;
  if (undetermined > 0) {
    messages.push({
      severity: 'info',
      title: `${String(undetermined)} package licence(s) could not be determined`,
      detail:
        'These are not forbidden. The scanner could not read a licence for them.',
      hint: 'Check them by hand if your policy requires every dependency to be cleared. A package that declares no licence is not the same as one that permits use.',
    });
  }
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
  /*
   * A setting stopped the analysis, so the code was never judged.
   *
   * This has to lead. Everything else this function can say describes an
   * analysis that ran; when the scanner refused to start, a gate status or a
   * measure count is either stale or absent, and reporting those first tells
   * the reader to go and fix code that was never looked at.
   *
   * It bites every new project rather than once per organisation: SonarCloud
   * turns automatic analysis on by default for new projects, and the switch
   * that would disable it for all of them is Enterprise-plan only.
   */
  if (sonar.blockedBy === 'automatic-analysis') {
    messages.push({
      severity: 'error',
      title: 'SonarCloud is set to analyse this project itself',
      detail:
        'Automatic Analysis is enabled for this project, and SonarCloud refuses to run a CI analysis alongside it. The code was not analysed.',
      hint: "In SonarCloud open this project, then Administration > Analysis Method, and unselect 'Enabled for this project'. Keep the CI analysis: Automatic Analysis cannot read a coverage report, so the coverage gate would stop meaning anything.",
    });
    return;
  }

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
  auditFailed: boolean,
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
      /*
       * An error when the audit job FAILED. The audit blocks on high as well as
       * critical on the branches where it is blocking, so the high-severity
       * findings are the reason the stage is red; calling them a warning hid
       * the cause of a failure behind advice. On a branch where the audit
       * passed they remain what they are, a warning.
       */
      severity: auditFailed ? 'error' : 'warning',
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

  /*
   * The stage left its work out on purpose and said why. It is not a result:
   * there is nothing to translate, only the reason to show.
   */
  if (results.skipped !== undefined) {
    return cleanMessages([skippedMessage(results.skipped.reason)]);
  }

  const { tests, coverage, lint, security, sonar, findings } = results;

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

  const failedJobs = failedJobsOf(rawLogs, results.checks);
  const auditFailed = failedJobs.some((job) =>
    /audit|security/.test(failedJobId(job).toLowerCase()),
  );

  if (security !== undefined) {
    pushSecurityMessages(messages, security, auditFailed);
  }

  if (findings !== undefined) {
    pushFindingsMessages(messages, findings, conclusion);
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
  const alreadyExplained = messages.some(
    (message) => message.severity === 'error',
  );

  if (conclusion === 'failure' && !alreadyExplained) {
    messages.unshift(unreportedFailureMessage(stage, failedJobs, annotations));
  }

  /*
   * Every failed job, not only the first one that explains itself.
   *
   * One message used to stand in for the whole stage: Sonar failing its gate
   * made the stage "explained", and a failed licence scan and a failed lint job
   * beside it were never mentioned - so the reader fixed Sonar, pushed, and
   * met the next one. The jobs a message above already accounts for are left
   * out; the rest are listed. When nothing explained the failure and there are
   * no annotations, the message above already lists every job.
   */
  if (
    conclusion === 'failure' &&
    (alreadyExplained || annotations.length > 0)
  ) {
    const covered = coveredJobPredicate(results, auditFailed);
    const uncovered = failedJobs.filter((job) => !covered(failedJobId(job)));
    if (uncovered.length > 0) {
      messages.push(otherFailedJobsMessage(stage, uncovered));
    }
  }

  if (
    !(conclusion === 'failure' && !alreadyExplained) &&
    annotations.length > 0
  ) {
    /*
     * Everything else that carries annotations: a stage that passed, and a
     * failure that already explained itself. Appended rather than unshifted —
     * the reason a stage failed still leads, and advice follows it.
     */
    messages.push(advisoryAnnotationMessage(stage, conclusion, annotations));
  }

  return cleanMessages(messages);
}
