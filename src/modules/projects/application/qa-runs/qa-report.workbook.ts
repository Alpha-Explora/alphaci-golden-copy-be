/**
 * QA report -> Excel workbook (.xlsx), the third format of GET
 * .../qa-runs/:runId/report beside JSON and Markdown. It reads the same
 * report the other formats read, v1 (a repository run) or v2 (a Project run),
 * so the workbook says exactly what the PDF and the JSON say.
 *
 * `qaReportSheets` is pure and deterministic (no I/O, no `new Date()`) and
 * is what the spec checks; `renderQaReportWorkbook` only lays those rows out
 * with exceljs. No GitHub links: run URLs stay out of every sheet.
 */

import { Workbook } from 'exceljs';

import type { QaChecklistTargetPersona } from '../qa-checklists/qa-checklists.contracts';
import type { QaReport, QaReportDefect } from './qa-report.contracts';
import {
  TEST_CASE_STATUS_LABELS,
  type QaProjectReport,
} from './qa-project-report';
import type {
  QaAutomatedResult,
  QaAutomationItemStatus,
  QaAutomationRunStatus,
  ProjectQaRunItem,
  QaRunAutomation,
  QaRunItem,
  QaRunItemStatus,
  QaStageAutomation,
} from './qa-runs.contracts';

export const QA_REPORT_XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss';
const PERCENT_FORMAT = '0.0%';
/** Excel refuses a cell longer than this. */
const MAX_CELL_LENGTH = 32_767;

/** A number or date that carries its own Excel number format. */
export interface QaFormattedCell {
  value: number | Date;
  numFmt: string;
}

export type QaSheetCell = string | number | null | QaFormattedCell;

export interface QaSheetColumn {
  header: string;
  width: number;
  /** Long free text: wrap it instead of widening the column. */
  wrap?: boolean;
}

export interface QaSheet {
  name: string;
  columns: QaSheetColumn[];
  rows: QaSheetCell[][];
}

type AnyQaReport = QaReport | QaProjectReport;

const STATUS_LABELS: Record<QaRunItemStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  returned_to_dev: 'Returned to dev',
};

const AUTOMATED_LABELS: Record<QaAutomationItemStatus, string> = {
  passed: 'Passed',
  failed: 'Failed',
  unknown: 'Unknown',
  not_run: 'Not run',
  unlinked: 'No test linked',
};

const STAGE_STATUS_LABELS: Record<QaAutomationRunStatus, string> = {
  success: 'Passed',
  failure: 'Failed',
  running: 'Running',
  cancelled: 'Cancelled',
};

const PERSONA_LABELS: Record<QaChecklistTargetPersona, string> = {
  developer: 'Developer',
  qa: 'QA Team',
  all: 'Everyone',
};

const VERIFICATION_LABELS: Record<string, string> = {
  manual: 'Manual check',
  playwright: 'Playwright E2E',
  unit_test: 'Unit test',
  bruno: 'Bruno API',
};

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function when(iso: string | null | undefined): QaFormattedCell | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : { value: date, numFmt: DATE_FORMAT };
}

function isProjectReport(report: AnyQaReport): report is QaProjectReport {
  return report.schemaVersion === 'qa-report/v2';
}

function automatedLabel(result: QaAutomatedResult | null): string | null {
  if (!result) {
    return null;
  }
  const label = AUTOMATED_LABELS[result.status];
  return result.inferred ? `${label} (inferred)` : label;
}

function summarySheet(report: AnyQaReport): QaSheet {
  const { run, summary } = report;
  const project = isProjectReport(report);
  const rows: QaSheetCell[][] = [
    ['Project', report.project.name],
    ...(project
      ? []
      : [['Repository', report.project.repoFullName] as QaSheetCell[]]),
    ['Run', run.id],
    ...(project && report.run.iteration
      ? [['Iteration', report.run.iteration.number] as QaSheetCell[]]
      : []),
    ['Branch', run.branch],
    ...(project ? [] : [['Commit', report.run.commitSha] as QaSheetCell[]]),
    ['Run status', run.status === 'open' ? 'Open' : 'Signed off'],
    ['Started (UTC)', when(run.createdAt)],
    ['Started by', run.createdBy.login],
    ['Generated (UTC)', when(report.generatedAt)],
    ['Frozen at sign-off', report.frozen ? 'Yes' : 'No'],
    ['Verdict', summary.verdict ?? 'Not signed off'],
    ['Items', summary.totalItems],
    ['Passed', summary.passed],
    ['Failed', summary.failed],
    ['Blocked', summary.blocked],
    ['Returned to dev', summary.returnedToDev],
    ['In progress', summary.inProgress],
    ['Pending', summary.pending],
    ['Completion', { value: summary.completionRate, numFmt: PERCENT_FORMAT }],
    ['Open defects', summary.openDefects],
    ['Blockers', summary.blockers],
  ];
  return {
    name: 'Summary',
    columns: [
      { header: 'Field', width: 22 },
      { header: 'Value', width: 60, wrap: true },
    ],
    rows,
  };
}

function repositoriesSheet(report: QaProjectReport): QaSheet {
  return {
    name: 'Repositories',
    columns: [
      { header: 'Repository', width: 44 },
      { header: 'uat head at run start', width: 44 },
    ],
    rows: report.repositories.map((repository) => [
      repository.repoFullName,
      repository.headSha,
    ]),
  };
}

function requirementKind(kind: 'functional' | 'system' | null): string | null {
  if (kind === 'functional') {
    return 'Feature';
  }
  return kind === 'system' ? 'System requirement' : null;
}

function checklistSheet(report: AnyQaReport): QaSheet {
  const project = isProjectReport(report);
  const columns: QaSheetColumn[] = [
    { header: '#', width: 6 },
    ...(project
      ? [
          { header: 'Requirement', width: 28, wrap: true },
          { header: 'Kind', width: 18 },
        ]
      : []),
    { header: 'Item', width: 40, wrap: true },
    ...(project
      ? [{ header: 'Acceptance criteria', width: 40, wrap: true }]
      : []),
    { header: 'For', width: 12 },
    { header: 'Verification', width: 16 },
    { header: 'Status', width: 16 },
    { header: 'Automated result', width: 18 },
    { header: 'Verified by', width: 18 },
    { header: 'Verified at (UTC)', width: 20 },
    { header: 'Severity', width: 10 },
    { header: 'Notes', width: 40, wrap: true },
    { header: 'Reproduction steps', width: 40, wrap: true },
    ...(project ? [{ header: 'Screenshots', width: 12 }] : []),
  ];
  // A v1 item lacks the requirement fields; the v2-only columns are skipped for it.
  const items: Array<QaRunItem & Partial<ProjectQaRunItem>> = report.run.items;
  const rows = items.map((item): QaSheetCell[] => [
    item.position + 1,
    ...(project
      ? [
          item.requirementName ?? 'Removed requirement',
          requirementKind(item.requirementKind ?? null),
        ]
      : []),
    item.title,
    ...(project ? [item.acceptanceCriteria ?? null] : []),
    PERSONA_LABELS[item.targetPersona],
    VERIFICATION_LABELS[item.verificationType] ?? item.verificationType,
    STATUS_LABELS[item.status],
    automatedLabel(item.automated),
    item.verifiedBy?.login ?? null,
    when(item.verifiedAt),
    item.defectSeverity ? capitalise(item.defectSeverity) : null,
    item.notes,
    item.reproductionSteps,
    ...(project ? [item.attachmentCount ?? 0] : []),
  ]);
  return { name: 'Checklist', columns, rows };
}

function defectsSheet(report: AnyQaReport): QaSheet {
  const project = isProjectReport(report);
  const defects: Array<QaReportDefect & { requirementName?: string | null }> =
    report.defects;
  return {
    name: 'Defects',
    columns: [
      { header: 'Severity', width: 10 },
      { header: '#', width: 6 },
      { header: 'Item', width: 40, wrap: true },
      ...(project ? [{ header: 'Requirement', width: 28, wrap: true }] : []),
      { header: 'Status', width: 16 },
      { header: 'Notes', width: 40, wrap: true },
      { header: 'Reproduction steps', width: 40, wrap: true },
      { header: 'Fix requested by', width: 18 },
      { header: 'Fix requested at (UTC)', width: 20 },
      { header: 'Fix note', width: 40, wrap: true },
    ],
    rows: defects.map((defect) => [
      defect.severity ? capitalise(defect.severity) : 'Unrated',
      defect.position + 1,
      defect.title,
      ...(project ? [defect.requirementName ?? null] : []),
      STATUS_LABELS[defect.status],
      defect.notes,
      defect.reproductionSteps,
      defect.fixRequest?.requestedBy.login ?? null,
      when(defect.fixRequest?.requestedAt),
      defect.fixRequest?.note ?? null,
    ]),
  };
}

const STAGE_LABELS = { verify: 'Verify', quality: 'Quality' } as const;

/**
 * One row per test case of every story (Project reports only). Omitted when
 * no story has a test case, so older and simpler reports keep their tabs.
 */
function testCasesSheet(report: QaProjectReport): QaSheet | null {
  const rows: QaSheetCell[][] = report.run.items.flatMap((item) =>
    (item.testCategories ?? []).flatMap((category) =>
      category.testCases.map((testCase) => [
        item.position + 1,
        item.title,
        category.name,
        testCase.title,
        testCase.expectedResult,
        TEST_CASE_STATUS_LABELS[testCase.status],
        testCase.verifiedBy?.login ?? null,
        when(testCase.verifiedAt),
        testCase.notes,
      ]),
    ),
  );
  if (rows.length === 0) return null;
  return {
    name: 'Test cases',
    columns: [
      { header: '#', width: 6 },
      { header: 'Story', width: 40, wrap: true },
      { header: 'Category', width: 20, wrap: true },
      { header: 'Test case', width: 40, wrap: true },
      { header: 'Expected result', width: 40, wrap: true },
      { header: 'Result', width: 14 },
      { header: 'Verified by', width: 18 },
      { header: 'Verified at (UTC)', width: 20 },
      { header: 'Notes', width: 40, wrap: true },
    ],
    rows,
  };
}

function stageRows(
  repository: string,
  stage: QaStageAutomation,
): QaSheetCell[][] {
  const head = [
    repository,
    STAGE_LABELS[stage.stage],
    STAGE_STATUS_LABELS[stage.status],
    when(stage.reportedAt),
  ];
  const tests = stage.tests;
  if (!tests) {
    return [
      [...head, null, null, null, 'No test counts reported', null, null, null],
    ];
  }
  if (tests.cases && tests.cases.length > 0) {
    return tests.cases.map((testCase) => [
      ...head,
      testCase.title,
      testCase.file ?? null,
      testCase.project ?? null,
      capitalise(testCase.status),
      testCase.durationMs === undefined
        ? null
        : { value: testCase.durationMs / 1000, numFmt: '0.00' },
      testCase.retries ?? null,
      testCase.error?.message ?? null,
    ]);
  }
  // Older pipelines report only the failures (and maybe the passing titles).
  const failed = tests.failures.map((failure): QaSheetCell[] => [
    ...head,
    failure.name,
    null,
    null,
    'Failed',
    null,
    null,
    failure.message,
  ]);
  const passed = (tests.passes ?? []).map((title): QaSheetCell[] => [
    ...head,
    title,
    null,
    null,
    'Passed',
    null,
    null,
    null,
  ]);
  const rows = [...failed, ...passed];
  return rows.length > 0
    ? rows
    : [
        [
          ...head,
          null,
          null,
          null,
          `${tests.passed} passed, ${tests.failed} failed of ${tests.total}`,
          null,
          null,
          null,
        ],
      ];
}

function automationSources(
  report: AnyQaReport,
): Array<{ repository: string; automation: QaRunAutomation }> {
  if (isProjectReport(report)) {
    const byRepository = report.run.automationByRepository ?? [];
    if (byRepository.length > 0) {
      return byRepository.map((entry) => ({
        repository: entry.repoFullName,
        automation: entry.automation,
      }));
    }
    return report.automatedResults
      ? [
          {
            repository: report.project.name,
            automation: report.automatedResults,
          },
        ]
      : [];
  }
  return report.automatedResults
    ? [
        {
          repository: report.project.repoFullName,
          automation: report.automatedResults,
        },
      ]
    : [];
}

function automatedTestsSheet(report: AnyQaReport): QaSheet {
  const rows = automationSources(report).flatMap(({ repository, automation }) =>
    [automation.verify, automation.quality]
      .filter((stage): stage is QaStageAutomation => stage !== null)
      .flatMap((stage) => stageRows(repository, stage)),
  );
  return {
    name: 'Automated tests',
    columns: [
      { header: 'Repository', width: 32 },
      { header: 'Stage', width: 10 },
      { header: 'Stage result', width: 12 },
      { header: 'Reported at (UTC)', width: 20 },
      { header: 'Test', width: 60, wrap: true },
      { header: 'File', width: 32 },
      { header: 'Browser', width: 12 },
      { header: 'Result', width: 26 },
      { header: 'Duration (s)', width: 12 },
      { header: 'Retries', width: 8 },
      { header: 'Error', width: 60, wrap: true },
    ],
    rows,
  };
}

function signoffSheet(report: AnyQaReport): QaSheet {
  const active = report.run.signoff;
  const rows: QaSheetCell[][] = [
    ...(active
      ? [
          [
            'Active',
            active.verdict,
            active.signedBy.login,
            when(active.signedAt),
            active.summary,
            active.conditions,
            null,
            null,
          ] as QaSheetCell[],
        ]
      : []),
    ...report.signoffHistory.map((entry): QaSheetCell[] => [
      'Superseded',
      entry.verdict,
      entry.signedBy.login,
      when(entry.signedAt),
      entry.summary,
      entry.conditions,
      when(entry.supersededAt),
      entry.supersededBy?.login ?? null,
    ]),
  ];
  return {
    name: 'Sign-off',
    columns: [
      { header: 'State', width: 12 },
      { header: 'Verdict', width: 14 },
      { header: 'Signed by', width: 18 },
      { header: 'Signed at (UTC)', width: 20 },
      { header: 'Summary', width: 40, wrap: true },
      { header: 'Conditions', width: 40, wrap: true },
      { header: 'Superseded at (UTC)', width: 20 },
      { header: 'Reopened by', width: 18 },
    ],
    rows,
  };
}

/** Every sheet of the workbook, in tab order. Pure: the same report gives the same rows. */
export function qaReportSheets(report: AnyQaReport): QaSheet[] {
  const testCases = isProjectReport(report) ? testCasesSheet(report) : null;
  return [
    summarySheet(report),
    ...(isProjectReport(report) ? [repositoriesSheet(report)] : []),
    checklistSheet(report),
    ...(testCases ? [testCases] : []),
    defectsSheet(report),
    automatedTestsSheet(report),
    signoffSheet(report),
  ];
}

/** A report frozen before a field existed lacks that key; its cell stays empty. */
function cellValue(
  cell: QaSheetCell | undefined,
): string | number | Date | null {
  if (cell === null || cell === undefined) {
    return null;
  }
  if (typeof cell === 'number') {
    return cell;
  }
  if (typeof cell === 'string') {
    return cell.length > MAX_CELL_LENGTH
      ? cell.slice(0, MAX_CELL_LENGTH)
      : cell;
  }
  return cell.value;
}

/** The report as an .xlsx file: one sheet per section, header row frozen and filterable. */
export async function renderQaReportWorkbook(
  report: AnyQaReport,
): Promise<Buffer> {
  const workbook = new Workbook();
  const generated = new Date(report.generatedAt);
  workbook.creator = 'ALPHACI';
  workbook.created = generated;
  workbook.modified = generated;

  for (const sheet of qaReportSheets(report)) {
    const worksheet = workbook.addWorksheet(sheet.name, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    worksheet.columns = sheet.columns.map((column) => ({
      header: column.header,
      width: column.width,
      style: {
        alignment: { vertical: 'top', wrapText: column.wrap === true },
      },
    }));
    worksheet.getRow(1).font = { bold: true };
    for (const cells of sheet.rows) {
      const row = worksheet.addRow(cells.map(cellValue));
      cells.forEach((cell: QaSheetCell | undefined, index) => {
        if (cell !== null && typeof cell === 'object') {
          row.getCell(index + 1).numFmt = cell.numFmt;
        }
      });
    }
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheet.columns.length },
    };
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
