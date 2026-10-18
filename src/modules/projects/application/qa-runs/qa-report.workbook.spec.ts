import { Workbook } from 'exceljs';

import { buildQaProjectReport } from './qa-project-report';
import type { QaReport } from './qa-report.contracts';
import { qaReportSheets, renderQaReportWorkbook } from './qa-report.workbook';
import type {
  ProjectQaRun,
  ProjectQaRunItem,
  QaRunAutomation,
} from './qa-runs.contracts';

const item = (overrides: Partial<ProjectQaRunItem> = {}): ProjectQaRunItem =>
  ({
    id: 'ri-1',
    runId: 'run-1',
    position: 0,
    title: 'Pay by card',
    description: null,
    targetPersona: 'all',
    verificationType: 'playwright',
    testIdentifier: 'checkout.spec.ts',
    status: 'passed',
    notes: '=SUM(A1)',
    defectSeverity: null,
    reproductionSteps: null,
    fixRequest: null,
    verifiedBy: { id: 'qa-1', login: 'qa' },
    verifiedAt: '2026-10-01T00:00:00.000Z',
    rowVersion: 2,
    canUpdate: false,
    previous: null,
    automated: {
      source: 'playwright',
      stage: 'verify',
      status: 'passed',
      scope: 'spec',
      matchedSpec: 'checkout.spec.ts',
      failure: null,
      runId: 7,
      runUrl: 'https://github.com/acme/web/actions/runs/7',
      reportedAt: '2026-10-01T00:00:00.000Z',
    },
    sourceItemId: 'item-1',
    requirementId: 'req-1',
    requirementName: 'Checkout',
    requirementKind: 'functional',
    acceptanceCriteria: 'Receipt shown',
    progress: 'done',
    attachmentCount: 2,
    ...overrides,
  }) as ProjectQaRunItem;

const webAutomation: QaRunAutomation = {
  verify: {
    stage: 'verify',
    status: 'failure',
    runId: 7,
    runUrl: 'https://github.com/acme/web/actions/runs/7',
    reportedAt: '2026-10-01T00:30:00.000Z',
    tests: {
      total: 2,
      passed: 1,
      failed: 1,
      failures: [],
      failuresTruncated: false,
      cases: [
        {
          title: 'visual.e2e-spec.ts > home page matches',
          file: 'tests/e2e/visual.e2e-spec.ts',
          project: 'chromium',
          status: 'failed',
          durationMs: 1600,
          error: { message: 'Screenshot differs' },
        },
        {
          title: 'checkout.spec.ts > pays',
          file: 'tests/e2e/checkout.spec.ts',
          project: 'chromium',
          status: 'passed',
          durationMs: 955,
        },
      ],
    },
  },
  quality: null,
};

/** An older pipeline: failures only, no cases. */
const apiAutomation: QaRunAutomation = {
  verify: null,
  quality: {
    stage: 'quality',
    status: 'failure',
    runId: 8,
    runUrl: 'https://github.com/acme/api/actions/runs/8',
    reportedAt: '2026-10-01T00:40:00.000Z',
    tests: {
      total: 3,
      passed: 2,
      failed: 1,
      failures: [{ name: 'orders > rejects', message: 'expected 400' }],
      failuresTruncated: false,
    },
  },
};

const run = (items: ProjectQaRunItem[]): ProjectQaRun =>
  ({
    id: 'abcdef0123',
    scope: 'project',
    deliveryProjectId: 'dp-1',
    deliveryProjectName: 'Checkout',
    iteration: { id: 'it-2', number: 2, status: 'active' },
    branch: 'uat',
    status: 'open',
    createdBy: { id: 'qa-1', login: 'qa' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T01:00:00.000Z',
    summary: {
      total: items.length,
      byStatus: {
        pending: 0,
        in_progress: 0,
        passed: 1,
        failed: 1,
        blocked: 0,
        returned_to_dev: 0,
      },
      openDefects: 1,
      blockers: 0,
    },
    signoff: null,
    repositories: [
      {
        projectId: 'p-web',
        repoFullName: 'acme/web',
        runSha: 'a'.repeat(40),
        currentSha: 'a'.repeat(40),
        moved: false,
      },
    ],
    stale: false,
    requirementsChanged: false,
    items,
    permissions: {
      canSetVerification: true,
      canSignOff: true,
      canReopen: false,
      canDispatch: true,
    },
    attachments: { enabled: true, canAdd: true },
    automation: webAutomation,
    automationByRepository: [
      {
        projectId: 'p-web',
        repoFullName: 'acme/web',
        automation: webAutomation,
      },
      {
        projectId: 'p-api',
        repoFullName: 'acme/api',
        automation: apiAutomation,
      },
    ],
  }) as ProjectQaRun;

const report = buildQaProjectReport({
  generatedAt: '2026-10-01T02:00:00.000Z',
  frozen: false,
  run: run([
    item(),
    item({
      id: 'ri-2',
      position: 1,
      title: 'Refund',
      status: 'failed',
      defectSeverity: 'major',
      notes: 'Amount wrong',
      automated: null,
      verificationType: 'manual',
      requirementName: null,
      requirementKind: null,
    }),
  ]),
  signoffHistory: [],
});

const sheet = (name: string) => {
  const found = qaReportSheets(report).find((s) => s.name === name);
  if (!found) throw new Error(`no sheet ${name}`);
  return found;
};

describe('QA report workbook', () => {
  it('has one sheet per report section, in order', () => {
    expect(qaReportSheets(report).map((s) => s.name)).toEqual([
      'Summary',
      'Repositories',
      'Checklist',
      'Defects',
      'Automated tests',
      'Sign-off',
    ]);
  });

  it('lists every checklist item with its requirement and automated result', () => {
    const checklist = sheet('Checklist');
    expect(checklist.columns.map((c) => c.header)).toContain('Requirement');
    const [first, second] = checklist.rows;
    expect(first?.slice(0, 4)).toEqual([
      1,
      'Checkout',
      'Feature',
      'Pay by card',
    ]);
    expect(first).toContain('Passed');
    expect(first).toContain('=SUM(A1)');
    expect(second?.slice(0, 3)).toEqual([2, 'Removed requirement', null]);
    expect(second).toContain('Failed');
  });

  it('lists every reported test per repository, and failures from older pipelines', () => {
    const tests = sheet('Automated tests').rows;
    expect(tests.map((row) => [row[0], row[1], row[4], row[7]])).toEqual([
      [
        'acme/web',
        'Verify',
        'visual.e2e-spec.ts > home page matches',
        'Failed',
      ],
      ['acme/web', 'Verify', 'checkout.spec.ts > pays', 'Passed'],
      ['acme/api', 'Quality', 'orders > rejects', 'Failed'],
    ]);
    expect(tests[0]?.[10]).toBe('Screenshot differs');
  });

  it('never carries a GitHub link', () => {
    const cells = qaReportSheets(report).flatMap((s) => s.rows.flat());
    expect(
      cells.some(
        (cell) => typeof cell === 'string' && cell.includes('github.com'),
      ),
    ).toBe(false);
  });

  it('leaves the requirement columns out of a repository (v1) report', () => {
    const v1 = {
      ...report,
      schemaVersion: 'qa-report/v1',
      project: { id: 'p-web', repoFullName: 'acme/web', name: 'web' },
      run: { ...report.run, commitSha: 'b'.repeat(40) },
      automatedResults: webAutomation,
    } as unknown as QaReport;
    const names = qaReportSheets(v1).map((s) => s.name);
    expect(names).not.toContain('Repositories');
    const checklist = qaReportSheets(v1).find((s) => s.name === 'Checklist');
    expect(checklist?.columns.map((c) => c.header)).not.toContain(
      'Requirement',
    );
    expect(checklist?.rows[0]?.[1]).toBe('Pay by card');
  });

  it('writes a real .xlsx that Excel readers open', async () => {
    const buffer = await renderQaReportWorkbook(report);
    const workbook = new Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((w) => w.name)).toContain('Automated tests');
    const summary = workbook.getWorksheet('Summary');
    expect(summary?.getRow(1).getCell(1).value).toBe('Field');
    expect(summary?.getRow(2).values).toEqual([
      undefined,
      'Project',
      'Checkout',
    ]);
    const notes = workbook.getWorksheet('Checklist');
    // A note that looks like a formula stays text.
    expect(notes?.getRow(2).values).toContain('=SUM(A1)');
  });
});
