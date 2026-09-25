/**
 * API-facing shapes for the QA report export (Slice 4): GET
 * .../qa-runs/:runId/report?format=json|md. Kept free of Nest/pg imports,
 * same rule as qa-runs.contracts.ts -- this is the exact JSON body returned
 * for format=json, and the source the Markdown renderer reads from for
 * format=md.
 */

import type { QaChecklistTargetPersona } from '../qa-checklists/qa-checklists.contracts';
import type {
  QaActor,
  QaDefectSeverity,
  QaRun,
  QaRunItemFixRequest,
  QaVerdict,
} from './qa-runs.contracts';

export const QA_REPORT_SCHEMA_VERSION = 'qa-report/v1' as const;

export const QA_REPORT_FORMATS = ['json', 'md'] as const;
export type QaReportFormat = (typeof QA_REPORT_FORMATS)[number];

/** The item statuses that make an item a "defect" in the report. */
export type QaReportDefectStatus = 'failed' | 'blocked' | 'returned_to_dev';

export interface QaReportProject {
  id: string;
  repoFullName: string;
  /** The project's service_name when non-blank, else the repo's own name (last path segment of repoFullName). */
  name: string;
}

export interface QaReportSummary {
  totalItems: number;
  passed: number;
  failed: number;
  blocked: number;
  returnedToDev: number;
  pending: number;
  inProgress: number;
  /** passed / totalItems, 0..1, 0 when totalItems is 0, rounded to 4 decimals. */
  completionRate: number;
  openDefects: number;
  blockers: number;
  verdict: QaVerdict | null;
}

export interface QaReportDefect {
  position: number;
  title: string;
  status: QaReportDefectStatus;
  severity: QaDefectSeverity | null;
  notes: string | null;
  reproductionSteps: string | null;
  targetPersona: QaChecklistTargetPersona;
  fixRequest: QaRunItemFixRequest | null;
}

/**
 * One entry of run.signoffHistory: a SUPERSEDED sign-off (the active one, if
 * any, is already embedded as report.run.signoff). supersededBy.login is
 * null for a reopen recorded before superseded_by_login existed -- see
 * 20260925040000_qa_signoff_superseded_login.sql.
 */
export interface QaReportSignoffHistoryEntry {
  verdict: QaVerdict;
  summary: string | null;
  conditions: string | null;
  signedBy: QaActor;
  signedAt: string;
  supersededAt: string;
  supersededBy: { id: string; login: string | null } | null;
}

export interface QaReport {
  schemaVersion: typeof QA_REPORT_SCHEMA_VERSION;
  generatedAt: string;
  /** True when the run is signed off and `run` is the frozen report_json from the active signoff, not rebuilt. */
  frozen: boolean;
  project: QaReportProject;
  run: QaRun;
  summary: QaReportSummary;
  defects: QaReportDefect[];
  /** Reserved for the Playwright slice (Slice 5); always null today. */
  automatedResults: null;
  signoffHistory: QaReportSignoffHistoryEntry[];
}
