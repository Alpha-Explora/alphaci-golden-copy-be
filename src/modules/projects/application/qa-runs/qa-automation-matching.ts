/**
 * Pure item <-> automated-result matcher for the Playwright/automated
 * verification slice (Slice 5). No Nest, no I/O: takes a checklist item's
 * shape plus the run's QaRunAutomation (already fetched) and returns the
 * QaAutomatedResult to attach to that item, or null for a manual item.
 *
 * Sign-off stays manual; this is display only, per the task contract.
 */

import type { QaChecklistVerificationType } from '../qa-checklists/qa-checklists.contracts';
import type {
  QaAutomatedResult,
  QaAutomationFailure,
  QaAutomationItemStatus,
  QaAutomationSource,
  QaRunAutomation,
  QaStageAutomation,
} from './qa-runs.contracts';

export interface QaAutomationMatchableItem {
  verificationType: QaChecklistVerificationType;
  testIdentifier: string | null;
}

// ---------------------------------------------------------------------
// Spec-path derivation and comparison
// ---------------------------------------------------------------------

/**
 * The item's spec file, per the task rule: the text before the first
 * " › " or " > " separator in test_identifier, trimmed. Whichever
 * separator appears first wins; an identifier with neither is the whole
 * string (a bare file path).
 */
function deriveItemSpecFile(testIdentifier: string): string {
  const arrowIndex = testIdentifier.indexOf(' › ');
  const angleIndex = testIdentifier.indexOf(' > ');
  const candidates = [arrowIndex, angleIndex].filter((index) => index >= 0);
  if (candidates.length === 0) {
    return testIdentifier.trim();
  }
  const cutAt = Math.min(...candidates);
  return testIdentifier.slice(0, cutAt).trim();
}

/** The failure name's first segment: suite titles are " > "-joined, and the first is always the spec file. */
function deriveFailureSpecFile(failureName: string): string {
  const cutAt = failureName.indexOf(' > ');
  return (cutAt === -1 ? failureName : failureName.slice(0, cutAt)).trim();
}

/** backslashes -> '/', strip a leading './' — applied to both sides before comparing. */
function normalizeSpecPath(path: string): string {
  const forwardSlashes = path.replace(/\\/g, '/');
  return forwardSlashes.startsWith('./')
    ? forwardSlashes.slice(2)
    : forwardSlashes;
}

/** Equal, or one is the other with a directory prefix — "checkout.spec.ts" matches "e2e/checkout.spec.ts". */
function specFilesMatch(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

// ---------------------------------------------------------------------
// Building one QaAutomatedResult
// ---------------------------------------------------------------------

function stageLevelStatus(
  stageStatus: QaStageAutomation['status'],
): QaAutomationItemStatus {
  if (stageStatus === 'running' || stageStatus === 'cancelled') {
    return 'unknown';
  }
  return stageStatus === 'success' ? 'passed' : 'failed';
}

function baseResult(
  source: QaAutomationSource,
  stage: QaStageAutomation['stage'],
  report: QaStageAutomation | null,
): Omit<QaAutomatedResult, 'status' | 'scope' | 'matchedSpec' | 'failure'> {
  return {
    source,
    stage,
    runId: report?.runId ?? null,
    runUrl: report?.runUrl ?? null,
    reportedAt: report?.reportedAt ?? null,
  };
}

/** bruno and unit_test: stage-level only, never a per-spec match. */
function matchStageLevel(
  source: QaAutomationSource,
  report: QaStageAutomation | null,
): QaAutomatedResult {
  const stage = source === 'unit_test' ? 'quality' : 'verify';
  const base = baseResult(source, stage, report);
  if (!report) {
    return {
      ...base,
      status: 'not_run',
      scope: 'stage',
      matchedSpec: null,
      failure: null,
    };
  }
  if (report.status === 'running' || report.status === 'cancelled') {
    return {
      ...base,
      status: 'unknown',
      scope: 'stage',
      matchedSpec: null,
      failure: null,
    };
  }
  return {
    ...base,
    status: stageLevelStatus(report.status),
    scope: 'stage',
    matchedSpec: null,
    failure: null,
  };
}

function matchPlaywright(
  testIdentifier: string | null,
  report: QaStageAutomation | null,
): QaAutomatedResult {
  const base = baseResult('playwright', 'verify', report);

  if (!report) {
    return {
      ...base,
      status: 'not_run',
      scope: 'stage',
      matchedSpec: null,
      failure: null,
    };
  }
  if (report.status === 'running' || report.status === 'cancelled') {
    return {
      ...base,
      status: 'unknown',
      scope: 'stage',
      matchedSpec: null,
      failure: null,
    };
  }

  const tests = report.tests;
  if (!tests || tests.total === 0) {
    return {
      ...base,
      status: stageLevelStatus(report.status),
      scope: 'stage',
      matchedSpec: null,
      failure: null,
    };
  }

  if (!testIdentifier) {
    return {
      ...base,
      status: tests.failed === 0 ? 'passed' : 'failed',
      scope: 'stage',
      matchedSpec: null,
      failure: null,
    };
  }

  const itemFile = normalizeSpecPath(deriveItemSpecFile(testIdentifier));
  const match = tests.failures.find((failure) =>
    specFilesMatch(
      normalizeSpecPath(deriveFailureSpecFile(failure.name)),
      itemFile,
    ),
  );

  if (match) {
    const failure: QaAutomationFailure = {
      name: match.name,
      message: match.message,
    };
    return {
      ...base,
      status: 'failed',
      scope: 'spec',
      matchedSpec: itemFile,
      failure,
    };
  }

  if (tests.failed === 0) {
    return {
      ...base,
      status: 'passed',
      scope: 'suite',
      matchedSpec: null,
      failure: null,
    };
  }

  if (!tests.failuresTruncated) {
    // Its file is not among the (complete) failures list, so it passed.
    return {
      ...base,
      status: 'passed',
      scope: 'spec',
      matchedSpec: itemFile,
      failure: null,
    };
  }

  return {
    ...base,
    status: 'unknown',
    scope: 'suite',
    matchedSpec: null,
    failure: null,
  };
}

/**
 * Match one checklist item against the run's automation. Manual items
 * always return null; every other verification type returns a populated
 * QaAutomatedResult, even when nothing ran yet (status 'not_run').
 */
export function matchAutomatedResult(
  item: QaAutomationMatchableItem,
  automation: QaRunAutomation,
): QaAutomatedResult | null {
  switch (item.verificationType) {
    case 'manual':
      return null;
    case 'playwright':
      return matchPlaywright(item.testIdentifier, automation.verify);
    case 'bruno':
      return matchStageLevel('bruno', automation.verify);
    case 'unit_test':
      return matchStageLevel('unit_test', automation.quality);
  }
}
