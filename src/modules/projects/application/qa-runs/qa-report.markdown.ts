/**
 * Pure QaReport -> GitHub-flavoured Markdown renderer for the export slice
 * (Slice 4). Deterministic given the report: no `new Date()`, no I/O, so it
 * is unit-testable on its own -- see qa-runs.controller.ts for where the
 * output is actually streamed back.
 */

import type {
  QaChecklistTargetPersona,
  QaChecklistVerificationType,
} from '../qa-checklists/qa-checklists.contracts';
import type {
  QaAutomationItemStatus,
  QaAutomationRunStatus,
  QaCommitSource,
  QaDefectSeverity,
  QaRunAutomation,
  QaRunItem,
  QaRunItemFixRequest,
  QaRunItemStatus,
  QaRunStatus,
  QaStageAutomation,
} from './qa-runs.contracts';
import type {
  QaReport,
  QaReportDefect,
  QaReportSignoffHistoryEntry,
  QaReportSummary,
} from './qa-report.contracts';

const EM_DASH = '—';

// ---------------------------------------------------------------------
// Escaping / formatting primitives
// ---------------------------------------------------------------------

/** For text embedded in a heading: newlines collapsed to a space (a literal newline would start a new block). */
function escapeInline(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** For prose outside a table (Notes/Summary/Conditions/fix-request note): newlines collapsed to `<br>`, no pipe escaping needed. */
function collapseNewlines(value: string): string {
  return value.replace(/\r\n|\r|\n/g, '<br>').trim();
}

/**
 * For a table cell: newlines collapsed to `<br>` (a bare newline would break
 * the row), then `|` escaped as `\|` (a bare pipe would add a column), then
 * trimmed -- the exact order the task spec gives for the Notes column,
 * applied to every free-text cell for consistency.
 */
function escapeTableCell(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim();
}

/** Notes column rule: escape as a table cell; empty (or originally null) becomes an em dash. */
function renderNotesCell(value: string | null): string {
  if (value === null) {
    return EM_DASH;
  }
  const escaped = escapeTableCell(value);
  return escaped.length > 0 ? escaped : EM_DASH;
}

/** A backtick fence longer than any backtick run already in `content`, so a reproduction-steps value can never prematurely close its own fence. */
function codeFence(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${content}\n${fence}`;
}

/** `iso` -> `YYYY-MM-DD HH:mm:ss UTC`. Falls back to the raw string if it does not parse (should not happen -- every input is a stored timestamptz). */
function formatUtcDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const [datePart, timePart] = date.toISOString().split('T');
  const time = (timePart ?? '').replace(/\.\d+Z$/, '').replace(/Z$/, '');
  return `${datePart} ${time} UTC`;
}

function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const headerRow = `| ${headers.join(' | ')} |`;
  const dividerRow = `| ${headers.map(() => '---').join(' | ')} |`;
  const bodyRows = rows.map((row) => `| ${row.join(' | ')} |`);
  return [headerRow, dividerRow, ...bodyRows].join('\n');
}

// ---------------------------------------------------------------------
// Label vocabularies
// ---------------------------------------------------------------------

const PERSONA_LABELS: Record<QaChecklistTargetPersona, string> = {
  developer: 'Developer',
  qa: 'QA Team',
  all: 'Everyone',
};

const VERIFICATION_LABELS: Record<QaChecklistVerificationType, string> = {
  manual: 'Manual check',
  playwright: 'Playwright E2E',
  unit_test: 'Unit test',
  bruno: 'Bruno API',
};

const STATUS_LABELS: Record<QaRunItemStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  returned_to_dev: 'Returned to dev',
};

const AUTOMATION_STAGE_LABELS: Record<QaStageAutomation['stage'], string> = {
  verify: 'Verify',
  quality: 'Quality',
};

const AUTOMATION_RUN_STATUS_LABELS: Record<QaAutomationRunStatus, string> = {
  success: 'Success',
  failure: 'Failure',
  running: 'Running',
  cancelled: 'Cancelled',
};

const AUTOMATION_ITEM_STATUS_LABELS: Record<QaAutomationItemStatus, string> = {
  passed: 'passed',
  failed: 'failed',
  unknown: 'unknown',
  not_run: 'not run',
  unlinked: 'not linked to a test',
};

const SEVERITY_LABELS: Record<'blocker' | 'major' | 'minor', string> = {
  blocker: 'Blocker',
  major: 'Major',
  minor: 'Minor',
};

function severityLabel(severity: QaDefectSeverity | null): string {
  return severity === null ? 'Unrated' : SEVERITY_LABELS[severity];
}

function commitSourceLabel(source: QaCommitSource): string {
  return source === 'deployment' ? 'Deployed' : 'Branch head';
}

function runStatusLabel(status: QaRunStatus): string {
  return status === 'open' ? 'Open' : 'Signed off';
}

// ---------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------

function renderHeader(report: QaReport): string {
  const heading = `# QA report — ${escapeInline(report.project.repoFullName)}`;
  const run = report.run;
  const sha7 = run.commitSha.slice(0, 7);
  const rows: string[][] = [
    ['Branch', escapeTableCell(run.branch)],
    ['Commit', sha7],
    ['Commit source', commitSourceLabel(run.commitSource)],
    [
      'Checklist',
      `${escapeTableCell(run.checklistName)} v${run.checklistVersion}`,
    ],
    ['Run status', runStatusLabel(run.status)],
    ['Verdict', run.signoff ? run.signoff.verdict : 'Not signed off'],
    [
      'Signed off by',
      run.signoff
        ? `@${run.signoff.signedBy.login}, ${formatUtcDateTime(run.signoff.signedAt)}`
        : EM_DASH,
    ],
    ['Generated', formatUtcDateTime(report.generatedAt)],
  ];
  return `${heading}\n\n${renderTable(['Field', 'Value'], rows)}`;
}

function renderExecutiveSummary(summary: QaReportSummary): string {
  // completionRate is already rounded to 4 decimals by the mapper; an
  // integer percent, floored, per the task spec.
  const percent = Math.floor(summary.completionRate * 100);
  const lines = [
    `- Completion: ${summary.passed} / ${summary.totalItems} passed (${percent}%)`,
    `- Open defects: ${summary.openDefects}`,
    `- Blockers: ${summary.blockers}`,
  ];
  return `## Executive summary\n\n${lines.join('\n')}`;
}

/** "Passed (auto: passed)" — the checklist table's only automation-related change. */
function statusCellWithAutomation(item: QaRunItem): string {
  const status = STATUS_LABELS[item.status];
  if (!item.automated) {
    return status;
  }
  return `${status} (auto: ${AUTOMATION_ITEM_STATUS_LABELS[item.automated.status]})`;
}

function renderChecklist(items: readonly QaRunItem[]): string {
  // Defensive re-sort: the renderer must be deterministic on its own, not
  // merely trust that its caller already ordered `run.items` by position.
  const sorted = [...items].sort((a, b) => a.position - b.position);
  const rows = sorted.map((item) => [
    // 1-based for a human-facing report; qa_run_items.position itself is
    // 0-based (CHECK ("position" >= 0)).
    String(item.position + 1),
    escapeTableCell(item.title),
    PERSONA_LABELS[item.targetPersona],
    VERIFICATION_LABELS[item.verificationType],
    statusCellWithAutomation(item),
    renderNotesCell(item.notes),
  ]);
  return `## Checklist\n\n${renderTable(
    ['#', 'Item', 'Persona', 'Verification', 'Status', 'Notes'],
    rows,
  )}`;
}

function automationStageRow(stage: QaStageAutomation): string[] {
  return [
    AUTOMATION_STAGE_LABELS[stage.stage],
    AUTOMATION_RUN_STATUS_LABELS[stage.status],
    stage.tests ? `${stage.tests.passed}/${stage.tests.total}` : EM_DASH,
    `[#${String(stage.runId)}](${stage.runUrl})`,
  ];
}

function renderAutomationFailures(
  stages: readonly QaStageAutomation[],
): string {
  const lines = stages.flatMap((stageReport) =>
    (stageReport.tests?.failures ?? []).map(
      (failure) =>
        `- **${AUTOMATION_STAGE_LABELS[stageReport.stage]}:** ${escapeInline(failure.name)} ${EM_DASH} ${escapeInline(failure.message)}`,
    ),
  );
  if (lines.length === 0) {
    return '### Failures\n\nNone.';
  }

  const truncatedStages = stages
    .filter((stageReport) => stageReport.tests?.failuresTruncated === true)
    .map((stageReport) => AUTOMATION_STAGE_LABELS[stageReport.stage]);
  const note =
    truncatedStages.length > 0
      ? `\n\n_Only the first 20 failures are shown for: ${truncatedStages.join(', ')}._`
      : '';

  return `### Failures\n\n${lines.join('\n')}${note}`;
}

function renderAutomatedResults(automation: QaRunAutomation | null): string {
  const stages = automation
    ? [automation.verify, automation.quality].filter(
        (stageReport): stageReport is QaStageAutomation => stageReport !== null,
      )
    : [];

  if (stages.length === 0) {
    return '## Automated results\n\nNot available yet.';
  }

  const table = renderTable(
    ['Stage', 'Status', 'Tests', 'Run'],
    stages.map(automationStageRow),
  );

  return `## Automated results\n\n${table}\n\n${renderAutomationFailures(stages)}`;
}

function renderFixRequest(fixRequest: QaRunItemFixRequest): string {
  const date = formatUtcDateTime(fixRequest.requestedAt);
  const base = `Marked fixed by @${fixRequest.requestedBy.login} on ${date}`;
  return fixRequest.note
    ? `${base}: ${collapseNewlines(fixRequest.note)}`
    : `${base}.`;
}

function renderDefect(defect: QaReportDefect): string {
  const parts = [
    `### ${severityLabel(defect.severity)} — ${escapeInline(defect.title)}`,
    `**Status:** ${STATUS_LABELS[defect.status]}`,
    `**Notes:** ${defect.notes ? collapseNewlines(defect.notes) : EM_DASH}`,
    `**Reproduction steps:**\n\n${
      defect.reproductionSteps ? codeFence(defect.reproductionSteps) : EM_DASH
    }`,
  ];
  if (defect.fixRequest) {
    parts.push(`**Fix request:** ${renderFixRequest(defect.fixRequest)}`);
  }
  return parts.join('\n\n');
}

function renderDefects(defects: readonly QaReportDefect[]): string {
  if (defects.length === 0) {
    return '## Defects\n\nNo open defects.';
  }
  return `## Defects\n\n${defects.map(renderDefect).join('\n\n')}`;
}

function renderSignoffHistoryEntry(entry: QaReportSignoffHistoryEntry): string {
  const signedBy = `@${entry.signedBy.login}`;
  const supersededBy = entry.supersededBy
    ? entry.supersededBy.login
      ? `@${entry.supersededBy.login}`
      : `user ${entry.supersededBy.id}`
    : 'unknown';
  return `- ${entry.verdict} by ${signedBy} on ${formatUtcDateTime(entry.signedAt)} — superseded ${formatUtcDateTime(entry.supersededAt)} by ${supersededBy}`;
}

function renderSignoff(report: QaReport): string {
  const run = report.run;
  const blocks: string[] = ['## Sign-off'];

  if (run.signoff) {
    const fields = [`**Verdict:** ${run.signoff.verdict}`];
    if (run.signoff.summary) {
      fields.push(`**Summary:** ${collapseNewlines(run.signoff.summary)}`);
    }
    if (run.signoff.verdict === 'CONDITIONAL') {
      fields.push(
        `**Conditions:** ${
          run.signoff.conditions
            ? collapseNewlines(run.signoff.conditions)
            : EM_DASH
        }`,
      );
    }
    fields.push(
      `**Signed off by:** @${run.signoff.signedBy.login} on ${formatUtcDateTime(run.signoff.signedAt)}`,
    );
    blocks.push(fields.join('\n\n'));
  } else {
    blocks.push('Not signed off.');
  }

  if (report.signoffHistory.length > 0) {
    blocks.push('### Previous sign-offs');
    blocks.push(
      report.signoffHistory.map(renderSignoffHistoryEntry).join('\n'),
    );
  }

  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

export function renderQaReportMarkdown(report: QaReport): string {
  const sections = [
    renderHeader(report),
    renderExecutiveSummary(report.summary),
    renderChecklist(report.run.items),
    renderAutomatedResults(report.automatedResults),
    renderDefects(report.defects),
    renderSignoff(report),
  ];
  return `${sections.join('\n\n')}\n`;
}
