/**
 * Pure row -> API-contract mapping shared by the repository-scope (legacy,
 * read-only) and Project-scope run services. No Nest, no I/O.
 */

import type {
  QaRunItemRow,
  QaRunSignoffRow,
} from '../../infrastructure/qa-runs.repository';
import {
  QA_OPEN_DEFECT_STATUSES,
  type QaAutomatedResult,
  type QaRunItem,
  type QaRunItemPrevious,
  type QaRunItemStatus,
  type QaRunSummaryCounts,
  type QaSignoff,
} from './qa-runs.contracts';

export function computeSummary(items: QaRunItemRow[]): QaRunSummaryCounts {
  const byStatus: Record<QaRunItemStatus, number> = {
    pending: 0,
    in_progress: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    returned_to_dev: 0,
  };
  let blockers = 0;
  for (const item of items) {
    byStatus[item.status] += 1;
    if (
      QA_OPEN_DEFECT_STATUSES.includes(item.status) &&
      item.defect_severity === 'blocker'
    ) {
      blockers += 1;
    }
  }
  const openDefects = QA_OPEN_DEFECT_STATUSES.reduce(
    (sum, status) => sum + byStatus[status],
    0,
  );
  return { total: items.length, byStatus, openDefects, blockers };
}

export function toSignoff(row: QaRunSignoffRow): QaSignoff {
  return {
    id: row.id,
    verdict: row.verdict,
    summary: row.summary,
    conditions: row.conditions,
    signedBy: { id: row.signed_by, login: row.signed_by_login },
    signedAt: row.signed_at,
  };
}

export function toRunItem(
  row: QaRunItemRow,
  previous: QaRunItemPrevious | null,
  canUpdate: boolean,
  automated: QaAutomatedResult | null,
): QaRunItem {
  return {
    id: row.id,
    runId: row.run_id,
    position: row.position,
    title: row.title,
    description: row.description,
    targetPersona: row.target_persona,
    verificationType: row.verification_type,
    testIdentifier: row.test_identifier,
    status: row.status,
    notes: row.notes,
    defectSeverity: row.defect_severity,
    reproductionSteps: row.reproduction_steps,
    fixRequest: row.fix_requested_at
      ? {
          requestedAt: row.fix_requested_at,
          requestedBy: {
            id: row.fix_requested_by as string,
            login: row.fix_requested_by_login as string,
          },
          note: row.fix_note,
        }
      : null,
    verifiedBy: row.verified_by
      ? { id: row.verified_by, login: row.verified_by_login as string }
      : null,
    verifiedAt: row.verified_at,
    rowVersion: row.row_version,
    canUpdate,
    previous,
    automated,
  };
}
