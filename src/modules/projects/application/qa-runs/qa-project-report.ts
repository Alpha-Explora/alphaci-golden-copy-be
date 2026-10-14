/**
 * QA report v2: the export of a Project run (docs/design/project-requirements.md,
 * section 2.4). v1 plus `repositories[]` (name, head SHA the run captured) and
 * the requirement name and kind on every item and defect. Pure and
 * deterministic: no Nest, no I/O, no `new Date()` - every input, including
 * `generatedAt`, is passed in. A signed-off report is built from the run frozen
 * into the sign-off, never rebuilt, so it cannot change after the fact.
 */

import type {
  QaReportDefect,
  QaReportSignoffHistoryEntry,
  QaReportSummary,
} from './qa-report.contracts';
import { buildQaReportDefects, buildQaReportSummary } from './qa-report.mapper';
import type {
  ProjectQaRun,
  ProjectQaRunItem,
  QaRunAutomation,
  QaRunItemStatus,
} from './qa-runs.contracts';

export const QA_PROJECT_REPORT_SCHEMA_VERSION = 'qa-report/v2' as const;

export interface QaProjectReportRepository {
  projectId: string;
  repoFullName: string;
  /** The repository's own name (last path segment of repoFullName). */
  name: string;
  /** The uat head the run captured when it started. */
  headSha: string | null;
}

export interface QaProjectReportDefect extends QaReportDefect {
  requirementName: string | null;
  requirementKind: 'functional' | 'system' | null;
}

export interface QaProjectReport {
  schemaVersion: typeof QA_PROJECT_REPORT_SCHEMA_VERSION;
  generatedAt: string;
  /** True when the run is signed off and `run` is the frozen report_json, not rebuilt. */
  frozen: boolean;
  project: { id: string; name: string };
  repositories: QaProjectReportRepository[];
  run: ProjectQaRun;
  summary: QaReportSummary;
  defects: QaProjectReportDefect[];
  automatedResults: QaRunAutomation | null;
  signoffHistory: QaReportSignoffHistoryEntry[];
}

export interface BuildQaProjectReportInput {
  generatedAt: string;
  frozen: boolean;
  run: ProjectQaRun;
  signoffHistory: QaReportSignoffHistoryEntry[];
}

function repoName(repoFullName: string): string {
  return repoFullName.split('/').pop() || repoFullName;
}

export function buildQaProjectReport(
  input: BuildQaProjectReportInput,
): QaProjectReport {
  const { run } = input;
  const itemsByPosition = new Map(
    run.items.map((item) => [item.position, item]),
  );
  return {
    schemaVersion: QA_PROJECT_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    frozen: input.frozen,
    project: { id: run.deliveryProjectId, name: run.deliveryProjectName },
    repositories: run.repositories.map((repository) => ({
      projectId: repository.projectId,
      repoFullName: repository.repoFullName,
      name: repoName(repository.repoFullName),
      headSha: repository.runSha,
    })),
    run,
    summary: buildQaReportSummary(run),
    defects: buildQaReportDefects(run).map((defect) => {
      const item = itemsByPosition.get(defect.position);
      return {
        ...defect,
        requirementName: item?.requirementName ?? null,
        requirementKind: item?.requirementKind ?? null,
      };
    }),
    // A report frozen before automation existed has no key at all; treat as null.
    automatedResults: run.automation ?? null,
    signoffHistory: input.signoffHistory,
  };
}

// ---------------------------------------------------------------------
// Filename and Markdown
// ---------------------------------------------------------------------

function sanitizeFilenamePart(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-$/, '');
  return cleaned || 'unknown';
}

/** `QA-Report-<project>-<run7>.<json|md>`, every part sanitised to [A-Za-z0-9._-]. */
export function buildQaProjectReportFilename(
  report: QaProjectReport,
  format: 'json' | 'md',
): string {
  const project = sanitizeFilenamePart(report.project.name);
  const run = sanitizeFilenamePart(report.run.id.slice(0, 7));
  return `QA-Report-${project}-${run}.${format}`;
}

const EM_DASH = '—';

const STATUS_LABELS: Record<QaRunItemStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  returned_to_dev: 'Returned to dev',
};

function cell(value: string | null): string {
  if (value === null) {
    return EM_DASH;
  }
  const escaped = value
    .replace(/\r\n|\r|\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim();
  return escaped.length > 0 ? escaped : EM_DASH;
}

function inline(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function utc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const [datePart, timePart] = date.toISOString().split('T');
  return `${datePart} ${(timePart ?? '').replace(/\.\d+Z$/, '').replace(/Z$/, '')} UTC`;
}

function itemsByRequirement(
  items: readonly ProjectQaRunItem[],
): Array<{ name: string; kind: string; items: ProjectQaRunItem[] }> {
  const groups: Array<{
    key: string;
    name: string;
    kind: string;
    items: ProjectQaRunItem[];
  }> = [];
  for (const item of items) {
    const key = item.requirementId ?? `deleted:${item.requirementName ?? ''}`;
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      group = {
        key,
        name: item.requirementName ?? 'Removed requirement',
        kind:
          item.requirementKind === 'functional'
            ? 'Feature'
            : item.requirementKind === 'system'
              ? 'System requirement'
              : 'Requirement',
        items: [],
      };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

const ATTACHMENT_KIND_LABELS: Record<string, string> = {
  evidence: 'QA evidence',
  fix_proof: 'Fix proof',
  automated: 'Automated',
};

/**
 * One "<QA evidence | Fix proof>: <caption>" line per attachment, under the
 * item it belongs to. A report frozen before attachments existed has no
 * `attachments` key.
 */
function screenshotLines(items: readonly ProjectQaRunItem[]): string[] {
  const lines = items.flatMap((item) =>
    (item.attachments ?? []).map(
      (attachment) =>
        `- #${item.position + 1} ${inline(item.title)} - ${
          ATTACHMENT_KIND_LABELS[attachment.kind] ?? 'Screenshot'
        }: ${attachment.caption ? inline(attachment.caption) : '(no caption)'}`,
    ),
  );
  return lines.length > 0 ? ['', ...lines] : [];
}

export function renderQaProjectReportMarkdown(report: QaProjectReport): string {
  const { run, summary } = report;
  const sections: string[] = [];

  sections.push(
    [
      `# QA Report - ${inline(report.project.name)}`,
      '',
      `- **Run:** ${run.id} (${run.status === 'open' ? 'open' : 'signed off'})`,
      `- **Branch:** ${run.branch}`,
      `- **Started:** ${utc(run.createdAt)} by ${run.createdBy.login}`,
      `- **Generated:** ${utc(report.generatedAt)}${report.frozen ? ' (frozen at sign-off)' : ''}`,
    ].join('\n'),
  );

  sections.push(
    [
      '## Repositories',
      '',
      table(
        ['Repository', 'uat head at run start'],
        report.repositories.map((repository) => [
          cell(repository.repoFullName),
          repository.headSha
            ? `\`${repository.headSha.slice(0, 7)}\``
            : EM_DASH,
        ]),
      ),
    ].join('\n'),
  );

  sections.push(
    [
      '## Executive summary',
      '',
      `- **Verdict:** ${summary.verdict ?? 'Not signed off'}`,
      `- **Items:** ${summary.totalItems} (${summary.passed} passed, ${summary.failed} failed, ${summary.blocked} blocked, ${summary.returnedToDev} returned to dev, ${summary.pending} pending)`,
      `- **Completion:** ${(summary.completionRate * 100).toFixed(1)}%`,
      `- **Open defects:** ${summary.openDefects} (${summary.blockers} blocker${summary.blockers === 1 ? '' : 's'})`,
    ].join('\n'),
  );

  const checklist = itemsByRequirement(run.items).map((group) =>
    [
      `### ${inline(group.name)} (${group.kind})`,
      '',
      table(
        ['#', 'Item', 'Acceptance criteria', 'Status', 'Verified by', 'Notes'],
        group.items.map((item) => [
          String(item.position + 1),
          cell(item.title),
          cell(item.acceptanceCriteria),
          STATUS_LABELS[item.status],
          cell(item.verifiedBy?.login ?? null),
          cell(item.notes),
        ]),
      ),
      ...screenshotLines(group.items),
    ].join('\n'),
  );
  sections.push(['## Checklist', '', ...checklist].join('\n'));

  if (report.defects.length > 0) {
    sections.push(
      [
        '## Defects',
        '',
        table(
          ['Severity', 'Item', 'Requirement', 'Status', 'Notes'],
          report.defects.map((defect) => [
            defect.severity ?? 'Unrated',
            cell(defect.title),
            cell(defect.requirementName),
            STATUS_LABELS[defect.status],
            cell(defect.notes),
          ]),
        ),
      ].join('\n'),
    );
  }

  if (run.signoff) {
    const signoff = run.signoff;
    sections.push(
      [
        '## Sign-off',
        '',
        `- **Verdict:** ${signoff.verdict}`,
        `- **Signed by:** ${signoff.signedBy.login} at ${utc(signoff.signedAt)}`,
        ...(signoff.summary
          ? [`- **Summary:** ${inline(signoff.summary)}`]
          : []),
        ...(signoff.conditions
          ? [`- **Conditions:** ${inline(signoff.conditions)}`]
          : []),
      ].join('\n'),
    );
  }

  if (report.signoffHistory.length > 0) {
    sections.push(
      [
        '## Sign-off history',
        '',
        table(
          ['Verdict', 'Signed by', 'Signed at', 'Superseded at'],
          report.signoffHistory.map((entry) => [
            entry.verdict,
            cell(entry.signedBy.login),
            utc(entry.signedAt),
            utc(entry.supersededAt),
          ]),
        ),
      ].join('\n'),
    );
  }

  return `${sections.join('\n\n')}\n`;
}
