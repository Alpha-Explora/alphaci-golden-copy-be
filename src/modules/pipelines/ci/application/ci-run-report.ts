/**
 * CI run report: the export of one pipeline execution (a repository, a branch
 * and a commit), for the developer who has to fix what failed.
 *
 * It is the stored run as the Pipeline runs tab shows it, reshaped failures
 * first. Pure and deterministic: no Nest, no I/O, no `new Date()` - every
 * input, including `generatedAt`, is passed in.
 *
 * Two things are left out on purpose:
 *   - raw logs. They are free text captured from CI and can contain a secret
 *     the scanner did not recognise. The report says whether logs exist
 *     (`hasLogs`) and the in-app run view stays the one place to read them.
 *   - GitHub links. ALPHACI is the only UI; the run id is enough to ask for
 *     the log in-app.
 */

import type {
  RunGroup,
  StageCheck,
  StageReport,
  StageResults,
} from './ci-run.types';
import type { FriendlyMessage } from './translate-results';

export const CI_RUN_REPORT_SCHEMA_VERSION = 'ci-run-report/v1' as const;

export type CiRunReportFormat = 'json' | 'md';

export interface CiRunReportStage {
  stage: StageReport['stage'];
  status: StageReport['status'];
  /** The GitHub run this stage executed in. */
  runId: number;
  /** Null for a stage that never reported. */
  reportedAt: string | null;
  messages: FriendlyMessage[];
  checks: StageCheck[];
  results: StageResults | null;
  hasLogs: boolean;
}

export interface CiRunReportFailure {
  stage: StageReport['stage'];
  severity: FriendlyMessage['severity'];
  title: string;
  detail: string;
  hint: string;
  items: { label: string; sub?: string }[];
}

export interface CiRunReportSummary {
  stages: number;
  passed: number;
  failed: number;
  inProgress: number;
  /** Not run: pending, blocked by an earlier failure, stalled or cancelled. */
  notRun: number;
}

export interface CiRunReport {
  schemaVersion: typeof CI_RUN_REPORT_SCHEMA_VERSION;
  generatedAt: string;
  repoFullName: string;
  branch: string;
  commitSha: string;
  startedAt: string;
  overallStatus: RunGroup['overallStatus'];
  summary: CiRunReportSummary;
  /** What to fix, first: the stages that failed, with the reason and the way out. */
  failures: CiRunReportFailure[];
  /** Every stage in pipeline order, with its figures. */
  stages: CiRunReportStage[];
}

export interface BuildCiRunReportInput {
  generatedAt: string;
  run: RunGroup;
}

function summarize(stages: ReadonlyArray<StageReport>): CiRunReportSummary {
  const count = (statuses: ReadonlyArray<StageReport['status']>) =>
    stages.filter((stage) => statuses.includes(stage.status)).length;
  return {
    stages: stages.length,
    passed: count(['success']),
    failed: count(['failure']),
    inProgress: count(['running']),
    notRun: count(['pending', 'blocked', 'stalled', 'cancelled']),
  };
}

/** A failed stage explains itself with its error messages; any message, when it has none. */
function failuresOf(stage: StageReport): CiRunReportFailure[] {
  if (stage.status !== 'failure') {
    return [];
  }
  const errors = stage.friendlyMessages.filter(
    (message) => message.severity === 'error',
  );
  const explaining = errors.length > 0 ? errors : stage.friendlyMessages;
  return explaining.map((message) => ({
    stage: stage.stage,
    severity: message.severity,
    title: message.title,
    detail: message.detail,
    hint: message.hint,
    items: message.items ?? [],
  }));
}

function toReportStage(stage: StageReport): CiRunReportStage {
  return {
    stage: stage.stage,
    status: stage.status,
    runId: stage.runId,
    reportedAt: stage.updatedAt === '' ? null : stage.updatedAt,
    messages: stage.friendlyMessages,
    checks: stage.checks,
    results: stage.results ?? null,
    hasLogs: stage.rawLogs !== null && stage.rawLogs !== '',
  };
}

export function buildCiRunReport(input: BuildCiRunReportInput): CiRunReport {
  const { run } = input;
  return {
    schemaVersion: CI_RUN_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    repoFullName: run.repoFullName,
    branch: run.branch,
    commitSha: run.commitSha,
    startedAt: run.startedAt,
    overallStatus: run.overallStatus,
    summary: summarize(run.stages),
    failures: run.stages.flatMap(failuresOf),
    stages: run.stages.map(toReportStage),
  };
}

// ---------------------------------------------------------------------
// Filename
// ---------------------------------------------------------------------

function sanitizeFilenamePart(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-$/, '');
  return cleaned || 'unknown';
}

const SHA_LENGTH = 7;

/** `CI-Results-<repo>-<branch>-<sha7>.<json|md>`, every part sanitised to [A-Za-z0-9._-]. */
export function buildCiRunReportFilename(
  report: Pick<CiRunReport, 'repoFullName' | 'branch' | 'commitSha'>,
  format: CiRunReportFormat,
): string {
  const repo = sanitizeFilenamePart(
    report.repoFullName.split('/').pop() ?? report.repoFullName,
  );
  const branch = sanitizeFilenamePart(report.branch);
  const sha = sanitizeFilenamePart(report.commitSha.slice(0, SHA_LENGTH));
  return `CI-Results-${repo}-${branch}-${sha}.${format}`;
}

// ---------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------

const EM_DASH = '—';

const STATUS_LABELS: Record<StageReport['status'], string> = {
  success: 'Passed',
  failure: 'Failed',
  running: 'Running',
  cancelled: 'Cancelled',
  pending: 'Not run yet',
  blocked: 'Blocked by an earlier failure',
  stalled: 'Stalled',
};

const OVERALL_LABELS: Record<RunGroup['overallStatus'], string> = {
  success: 'Passed',
  failure: 'Failed',
  running: 'Running',
  cancelled: 'Cancelled',
  partial: 'Partial',
};

const STAGE_TITLES: Record<StageReport['stage'], string> = {
  access: 'Access',
  quality: 'Quality',
  package: 'Package',
  verify: 'Verify',
};

/** A table cell: one line, pipes escaped, EM DASH when empty. */
function cell(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return EM_DASH;
  }
  const escaped = value
    .replace(/\r\n|\r|\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim();
  return escaped.length > 0 ? escaped : EM_DASH;
}

/** A line of prose in a list: newlines folded so it stays one bullet. */
function line(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').trim();
}

function failureLines(failure: CiRunReportFailure): string[] {
  const out = [
    `### ${STAGE_TITLES[failure.stage]}: ${line(failure.title)}`,
    '',
  ];
  if (failure.detail) {
    out.push(line(failure.detail), '');
  }
  if (failure.hint) {
    out.push(`**Fix:** ${line(failure.hint)}`, '');
  }
  for (const item of failure.items) {
    out.push(
      item.sub
        ? `- ${line(item.label)}: ${line(item.sub)}`
        : `- ${line(item.label)}`,
    );
  }
  if (failure.items.length > 0) {
    out.push('');
  }
  return out;
}

function testsLines(results: StageResults): string[] {
  const { tests } = results;
  if (!tests) {
    return [];
  }
  const head = `- **Tests:** ${String(tests.passed)} / ${String(tests.total)} passed${
    tests.failed > 0 ? `, ${String(tests.failed)} failed` : ''
  }`;
  const failed = (tests.failures ?? []).map((failure) =>
    failure.message
      ? `  - ${line(failure.name)}: ${line(failure.message)}`
      : `  - ${line(failure.name)}`,
  );
  return [head, ...failed];
}

function coverageLines(results: StageResults): string[] {
  const { coverage } = results;
  return coverage
    ? [
        `- **Coverage:** ${String(coverage.pct)}% (threshold ${String(coverage.threshold)}%)`,
      ]
    : [];
}

function lintLines(results: StageResults): string[] {
  const { lint } = results;
  return lint
    ? [
        `- **Lint:** ${String(lint.errors)} errors, ${String(lint.warnings)} warnings`,
      ]
    : [];
}

function securityLines(results: StageResults): string[] {
  const { security } = results;
  return security
    ? [
        `- **Dependency vulnerabilities:** ${String(security.critical)} critical, ${String(security.high)} high`,
      ]
    : [];
}

function findingsLines(results: StageResults): string[] {
  const { findings } = results;
  if (!findings) {
    return [];
  }
  const parts: string[] = [];
  if (findings.secrets !== undefined) {
    parts.push(`${String(findings.secrets)} secrets`);
  }
  if (findings.forbiddenLicenses !== undefined) {
    parts.push(`${String(findings.forbiddenLicenses)} forbidden licences`);
  }
  if (findings.undeterminedLicenses !== undefined) {
    parts.push(
      `${String(findings.undeterminedLicenses)} undetermined licences`,
    );
  }
  return parts.length > 0 ? [`- **Findings:** ${parts.join(', ')}`] : [];
}

function sonarLines(results: StageResults): string[] {
  const { sonar } = results;
  if (!sonar) {
    return [];
  }
  const head = `- **Quality gate:** ${sonar.gate ?? EM_DASH}${
    sonar.blockedBy ? ` (blocked by ${line(sonar.blockedBy)})` : ''
  }`;
  const conditions = (sonar.failedConditions ?? []).map((condition) => {
    const detail = [
      condition.actual !== undefined ? `actual ${condition.actual}` : null,
      condition.threshold !== undefined
        ? `threshold ${condition.threshold}`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(', ');
    return detail
      ? `  - ${line(condition.metric)}: ${detail}`
      : `  - ${line(condition.metric)}`;
  });
  return [head, ...conditions];
}

function figuresLines(results: StageResults | null): string[] {
  if (!results) {
    return [];
  }
  return [
    ...testsLines(results),
    ...coverageLines(results),
    ...lintLines(results),
    ...securityLines(results),
    ...findingsLines(results),
    ...sonarLines(results),
  ];
}

function checksTable(checks: ReadonlyArray<StageCheck>): string[] {
  if (checks.length === 0) {
    return [];
  }
  return [
    '| Check | Result |',
    '| --- | --- |',
    ...checks.map(
      (check) => `| ${cell(check.name)} | ${cell(check.conclusion)} |`,
    ),
    '',
  ];
}

function stageSection(stage: CiRunReportStage): string[] {
  const figures = figuresLines(stage.results);
  const out = [
    `### ${STAGE_TITLES[stage.stage]} — ${STATUS_LABELS[stage.status]}`,
    '',
  ];
  if (figures.length > 0) {
    out.push(...figures, '');
  }
  out.push(...checksTable(stage.checks));
  if (figures.length === 0 && stage.checks.length === 0) {
    out.push('No figures were reported for this stage.', '');
  }
  return out;
}

export function renderCiRunReportMarkdown(report: CiRunReport): string {
  const { summary } = report;
  const lines: string[] = [
    `# CI results: ${report.repoFullName} · ${report.branch} @ ${report.commitSha.slice(0, SHA_LENGTH)}`,
    '',
    `**Result:** ${OVERALL_LABELS[report.overallStatus]} · ${String(summary.passed)} of ${String(summary.stages)} stages passed` +
      `${summary.failed > 0 ? `, ${String(summary.failed)} failed` : ''}` +
      `${summary.notRun > 0 ? `, ${String(summary.notRun)} not run` : ''}`,
    '',
    `Started ${report.startedAt} · Generated ${report.generatedAt}`,
    '',
  ];

  lines.push('## Failures', '');
  if (report.failures.length === 0) {
    lines.push('No failed stages.', '');
  } else {
    for (const failure of report.failures) {
      lines.push(...failureLines(failure));
    }
  }

  lines.push('## Stages', '');
  lines.push('| Stage | Status | Reported |', '| --- | --- | --- |');
  for (const stage of report.stages) {
    lines.push(
      `| ${STAGE_TITLES[stage.stage]} | ${STATUS_LABELS[stage.status]} | ${cell(stage.reportedAt)} |`,
    );
  }
  lines.push('');

  for (const stage of report.stages) {
    lines.push(...stageSection(stage));
  }

  lines.push(`_${report.schemaVersion}_`, '');
  return lines.join('\n');
}
