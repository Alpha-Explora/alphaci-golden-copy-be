import type { QaRunSignoffRow } from '../../infrastructure/qa-runs.repository';
import type { QaRun, QaRunItem } from './qa-runs.contracts';
import {
  buildQaReport,
  buildQaReportDefects,
  buildQaReportSummary,
  toSignoffHistoryEntry,
} from './qa-report.mapper';
import { QA_REPORT_SCHEMA_VERSION } from './qa-report.contracts';

const item = (overrides: Partial<QaRunItem> = {}): QaRunItem => ({
  id: 'item-1',
  runId: 'run-1',
  position: 0,
  title: 'Smoke test login',
  description: null,
  targetPersona: 'all',
  verificationType: 'manual',
  testIdentifier: null,
  status: 'pending',
  notes: null,
  defectSeverity: null,
  reproductionSteps: null,
  fixRequest: null,
  verifiedBy: null,
  verifiedAt: null,
  rowVersion: 1,
  canUpdate: true,
  previous: null,
  automated: null,
  ...overrides,
});

function summaryFor(items: readonly QaRunItem[]) {
  const byStatus = {
    pending: 0,
    in_progress: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    returned_to_dev: 0,
  };
  let blockers = 0;
  for (const it of items) {
    byStatus[it.status] += 1;
    if (
      (it.status === 'failed' ||
        it.status === 'blocked' ||
        it.status === 'returned_to_dev') &&
      it.defectSeverity === 'blocker'
    ) {
      blockers += 1;
    }
  }
  const openDefects =
    byStatus.failed + byStatus.blocked + byStatus.returned_to_dev;
  return { total: items.length, byStatus, openDefects, blockers };
}

const run = (overrides: Partial<QaRun> = {}): QaRun => {
  const items = overrides.items ?? [item()];
  return {
    id: 'run-1',
    projectId: 'project-1',
    checklistId: 'checklist-1',
    checklistName: 'Release checklist',
    checklistVersion: 2,
    branch: 'main',
    commitSha: 'a'.repeat(40),
    commitSource: 'deployment',
    status: 'open',
    createdBy: { id: 'creator-1', login: 'creator' },
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-25T00:00:00.000Z',
    summary: summaryFor(items),
    signoff: null,
    items,
    permissions: {
      canUpdateItems: true,
      canReturnToDev: true,
      canRequestRetest: true,
      canSignOff: true,
      canReopen: false,
    },
    automation: { verify: null, quality: null },
    ...overrides,
  };
};

const signoffRow = (
  overrides: Partial<QaRunSignoffRow> = {},
): QaRunSignoffRow => ({
  id: 'signoff-1',
  run_id: 'run-1',
  verdict: 'REJECTED',
  summary: 'Did not pass',
  conditions: null,
  signed_by: 'qa-1',
  signed_by_login: 'qa-login',
  signed_at: '2026-09-25T01:00:00.000Z',
  report_json: {},
  superseded_at: '2026-09-25T02:00:00.000Z',
  superseded_by: 'lead-1',
  superseded_by_login: 'lead-login',
  ...overrides,
});

describe('buildQaReportSummary', () => {
  it('derives every count from run.summary, not a second pass over items', () => {
    const items = [
      item({ id: 'a', status: 'passed' }),
      item({ id: 'b', status: 'passed' }),
      item({ id: 'c', status: 'failed', defectSeverity: 'major' }),
      item({ id: 'd', status: 'pending' }),
    ];
    const summary = buildQaReportSummary(
      run({
        items,
        signoff: {
          id: 's',
          verdict: 'REJECTED',
          summary: null,
          conditions: null,
          signedBy: { id: 'x', login: 'x' },
          signedAt: '2026-09-25T00:00:00.000Z',
        },
      }),
    );

    expect(summary.totalItems).toBe(4);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.blocked).toBe(0);
    expect(summary.returnedToDev).toBe(0);
    expect(summary.pending).toBe(1);
    expect(summary.inProgress).toBe(0);
    expect(summary.openDefects).toBe(1);
    expect(summary.blockers).toBe(0);
    expect(summary.verdict).toBe('REJECTED');
  });

  it('rounds completionRate to 4 decimals', () => {
    const items = [
      item({ id: 'a', status: 'passed' }),
      item({ id: 'b', status: 'passed' }),
      item({ id: 'c', status: 'pending' }),
    ];
    const summary = buildQaReportSummary(run({ items }));
    // 2/3 = 0.66666... -> 0.6667
    expect(summary.completionRate).toBe(0.6667);
  });

  it('is 0 (not NaN) when there are no items', () => {
    const summary = buildQaReportSummary(run({ items: [] }));
    expect(summary.completionRate).toBe(0);
    expect(summary.totalItems).toBe(0);
  });

  it('verdict is null on an open run with no signoff', () => {
    const summary = buildQaReportSummary(run({ signoff: null }));
    expect(summary.verdict).toBeNull();
  });
});

describe('buildQaReportDefects', () => {
  it('includes only failed/blocked/returned_to_dev items', () => {
    const items = [
      item({ id: 'a', status: 'passed' }),
      item({ id: 'b', status: 'pending' }),
      item({ id: 'c', status: 'failed', defectSeverity: 'minor' }),
      item({ id: 'd', status: 'blocked', defectSeverity: 'blocker' }),
      item({ id: 'e', status: 'returned_to_dev', defectSeverity: 'major' }),
      item({ id: 'f', status: 'in_progress' }),
    ];
    const defects = buildQaReportDefects(run({ items }));
    // Sorted by severity (blocker > major > minor), not by the input order:
    // d (blocked/blocker), e (returned_to_dev/major), c (failed/minor).
    expect(defects.map((d) => d.status)).toEqual([
      'blocked',
      'returned_to_dev',
      'failed',
    ]);
  });

  it('orders by severity (blocker > major > minor > unrated), then position', () => {
    const items = [
      item({
        id: 'a',
        position: 0,
        title: 'minor-at-0',
        status: 'failed',
        defectSeverity: 'minor',
      }),
      item({
        id: 'b',
        position: 1,
        title: 'blocker-at-1',
        status: 'failed',
        defectSeverity: 'blocker',
      }),
      item({
        id: 'c',
        position: 2,
        title: 'major-at-2',
        status: 'blocked',
        defectSeverity: 'major',
      }),
      item({
        id: 'd',
        position: 3,
        title: 'blocker-at-3',
        status: 'blocked',
        defectSeverity: 'blocker',
      }),
    ];
    const defects = buildQaReportDefects(run({ items }));
    expect(defects.map((d) => d.title)).toEqual([
      'blocker-at-1',
      'blocker-at-3',
      'major-at-2',
      'minor-at-0',
    ]);
  });

  it('places a null (unrated) severity after every rated one, tie-broken by position', () => {
    // A defect can legitimately have no severity yet (e.g. 'blocked' with no
    // QA verdict recorded) -- the mapper must still order it safely rather
    // than throwing or sorting it first.
    const items = [
      item({
        id: 'a',
        position: 5,
        title: 'unrated-at-5',
        status: 'blocked',
        defectSeverity: null,
      }),
      item({
        id: 'b',
        position: 1,
        title: 'unrated-at-1',
        status: 'blocked',
        defectSeverity: null,
      }),
      item({
        id: 'c',
        position: 9,
        title: 'minor-at-9',
        status: 'failed',
        defectSeverity: 'minor',
      }),
    ];
    const defects = buildQaReportDefects(run({ items }));
    expect(defects.map((d) => d.title)).toEqual([
      'minor-at-9',
      'unrated-at-1',
      'unrated-at-5',
    ]);
  });

  it('carries fixRequest through unchanged (as in QaRunItem)', () => {
    const fixRequest = {
      requestedAt: '2026-09-24T00:00:00.000Z',
      requestedBy: { id: 'dev-1', login: 'dev' },
      note: 'Patched the race condition.',
    };
    const items = [
      item({ status: 'failed', defectSeverity: 'major', fixRequest }),
    ];
    const defects = buildQaReportDefects(run({ items }));
    expect(defects[0]?.fixRequest).toEqual(fixRequest);
  });

  it('tolerates a null checklistId (workspace deletion can remove the checklist)', () => {
    // Nothing in the mapper reads run.checklistId, but it must not throw
    // when it is null, since QaRunListItem.checklistId is string | null.
    expect(() =>
      buildQaReportDefects(run({ checklistId: null })),
    ).not.toThrow();
  });
});

describe('toSignoffHistoryEntry', () => {
  it('resolves supersededBy with a login when one is stored', () => {
    const entry = toSignoffHistoryEntry(signoffRow());
    expect(entry.supersededBy).toEqual({ id: 'lead-1', login: 'lead-login' });
    expect(entry.signedBy).toEqual({ id: 'qa-1', login: 'qa-login' });
    expect(entry.supersededAt).toBe('2026-09-25T02:00:00.000Z');
  });

  it('falls back to { id, login: null } for a pre-migration row with no login', () => {
    const entry = toSignoffHistoryEntry(
      signoffRow({ superseded_by: 'lead-1', superseded_by_login: null }),
    );
    expect(entry.supersededBy).toEqual({ id: 'lead-1', login: null });
  });
});

describe('buildQaReport', () => {
  it('assembles schemaVersion, frozen, project, run, and automatedResults from run.automation', () => {
    const theRun = run();
    const report = buildQaReport({
      generatedAt: '2026-09-25T03:00:00.000Z',
      frozen: true,
      project: { id: 'project-1', repoFullName: 'org/repo', name: 'repo' },
      run: theRun,
      signoffHistory: [],
    });

    expect(report.schemaVersion).toBe(QA_REPORT_SCHEMA_VERSION);
    expect(report.generatedAt).toBe('2026-09-25T03:00:00.000Z');
    expect(report.frozen).toBe(true);
    expect(report.project).toEqual({
      id: 'project-1',
      repoFullName: 'org/repo',
      name: 'repo',
    });
    expect(report.run).toBe(theRun);
    // The default run() fixture has automation: { verify: null, quality: null }.
    expect(report.automatedResults).toEqual({ verify: null, quality: null });
  });

  it('passes a populated run.automation through to automatedResults verbatim', () => {
    const verifyStage = {
      stage: 'verify' as const,
      status: 'success' as const,
      runId: 42,
      runUrl: 'https://github.com/org/repo/actions/runs/42',
      reportedAt: '2026-09-25T02:30:00.000Z',
      tests: {
        total: 3,
        passed: 3,
        failed: 0,
        failures: [],
        failuresTruncated: false,
      },
    };
    const theRun = run({ automation: { verify: verifyStage, quality: null } });
    const report = buildQaReport({
      generatedAt: '2026-09-25T03:00:00.000Z',
      frozen: false,
      project: { id: 'project-1', repoFullName: 'org/repo', name: 'repo' },
      run: theRun,
      signoffHistory: [],
    });

    expect(report.automatedResults).toEqual({
      verify: verifyStage,
      quality: null,
    });
  });

  it('tolerates a frozen run with no automation key at all (pre-Slice-5 report_json), reading it as null', () => {
    // A signed-off run's report_json cast straight to QaRun can predate this
    // slice and simply have no `automation` key -- `?? null` in the mapper
    // must not throw on `undefined`.
    const preSliceRun = run();
    delete (preSliceRun as { automation?: unknown }).automation;

    const report = buildQaReport({
      generatedAt: '2026-09-25T03:00:00.000Z',
      frozen: true,
      project: { id: 'project-1', repoFullName: 'org/repo', name: 'repo' },
      run: preSliceRun,
      signoffHistory: [],
    });

    expect(report.automatedResults).toBeNull();
  });
});
