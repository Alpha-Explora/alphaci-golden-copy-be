/**
 * Pure QaRun -> QaReport mapping for the export slice (Slice 4). No Nest, no
 * DB access, no `new Date()` -- every input (including `generatedAt`) is
 * passed in, so this is deterministic and unit-testable on its own.
 *
 * summary/defects are always derived from `run.items` /
 * `run.summary` -- never from a second, independently-fetched copy of the
 * items -- so a frozen report (run === the signoff's stored report_json)
 * derives its summary/defects from those same frozen items, and never mixes
 * in anything live except what the caller passes as generatedAt/project/
 * signoffHistory.
 */

import type { QaRunSignoffRow } from '../../infrastructure/qa-runs.repository';
import type { QaRun, QaRunItem, QaRunItemStatus } from './qa-runs.contracts';
import {
  QA_REPORT_SCHEMA_VERSION,
  type QaReport,
  type QaReportDefect,
  type QaReportDefectStatus,
  type QaReportProject,
  type QaReportSignoffHistoryEntry,
  type QaReportSummary,
} from './qa-report.contracts';

const DEFECT_STATUSES: readonly QaReportDefectStatus[] = [
  'failed',
  'blocked',
  'returned_to_dev',
];

function isDefectStatus(
  status: QaRunItemStatus,
): status is QaReportDefectStatus {
  return (DEFECT_STATUSES as readonly QaRunItemStatus[]).includes(status);
}

/** blocker > major > minor > unrated (null), matching the report's defect ordering rule. */
const SEVERITY_RANK: Record<'blocker' | 'major' | 'minor', number> = {
  blocker: 0,
  major: 1,
  minor: 2,
};

function severityRank(severity: QaRunItem['defectSeverity']): number {
  return severity === null ? 3 : SEVERITY_RANK[severity];
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function buildQaReportSummary(run: QaRun): QaReportSummary {
  const { byStatus, total, openDefects, blockers } = run.summary;
  return {
    totalItems: total,
    passed: byStatus.passed,
    failed: byStatus.failed,
    blocked: byStatus.blocked,
    returnedToDev: byStatus.returned_to_dev,
    pending: byStatus.pending,
    inProgress: byStatus.in_progress,
    completionRate: total > 0 ? round4(byStatus.passed / total) : 0,
    openDefects,
    blockers,
    verdict: run.signoff?.verdict ?? null,
  };
}

export function buildQaReportDefects(run: QaRun): QaReportDefect[] {
  return run.items
    .filter((item): item is QaRunItem & { status: QaReportDefectStatus } =>
      isDefectStatus(item.status),
    )
    .map((item) => ({
      position: item.position,
      title: item.title,
      status: item.status,
      severity: item.defectSeverity,
      notes: item.notes,
      reproductionSteps: item.reproductionSteps,
      targetPersona: item.targetPersona,
      fixRequest: item.fixRequest,
    }))
    .sort((a, b) => {
      const rankDiff = severityRank(a.severity) - severityRank(b.severity);
      return rankDiff !== 0 ? rankDiff : a.position - b.position;
    });
}

/**
 * A superseded qa_run_signoffs row -> its report shape. supersededAt is
 * asserted non-null: the caller only ever passes rows already filtered to
 * `superseded_at IS NOT NULL` (QaRunsRepository.listSupersededSignoffs).
 */
export function toSignoffHistoryEntry(
  row: QaRunSignoffRow,
): QaReportSignoffHistoryEntry {
  return {
    verdict: row.verdict,
    summary: row.summary,
    conditions: row.conditions,
    signedBy: { id: row.signed_by, login: row.signed_by_login },
    signedAt: row.signed_at,
    supersededAt: row.superseded_at as string,
    supersededBy: row.superseded_by
      ? { id: row.superseded_by, login: row.superseded_by_login }
      : null,
  };
}

export interface BuildQaReportInput {
  generatedAt: string;
  frozen: boolean;
  project: QaReportProject;
  run: QaRun;
  signoffHistory: QaReportSignoffHistoryEntry[];
}

export function buildQaReport(input: BuildQaReportInput): QaReport {
  const { run } = input;
  return {
    schemaVersion: QA_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    frozen: input.frozen,
    project: input.project,
    run,
    summary: buildQaReportSummary(run),
    defects: buildQaReportDefects(run),
    // A report frozen before this slice shipped has no `automation` key at
    // all (old report_json cast straight to QaRun) — `?? null` tolerates
    // that absence the same as a run whose stages never reported.
    automatedResults: run.automation ?? null,
    signoffHistory: input.signoffHistory,
  };
}
