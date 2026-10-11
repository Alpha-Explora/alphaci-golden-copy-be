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
  QaAutomationTestResults,
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

/**
 * What the item names after its spec file, normalised to " > " joins, or null
 * when it names only a file ("e2e/checkout.spec.ts" has no specific test;
 * "e2e/checkout.spec.ts > pays by card" does).
 */
function deriveItemTestTitle(testIdentifier: string): string | null {
  const normalized = testIdentifier.replace(/ › /g, ' > ');
  const cutAt = normalized.indexOf(' > ');
  if (cutAt === -1) {
    return null;
  }
  const title = normalized
    .slice(cutAt + 3)
    .replace(/\s+/g, ' ')
    .trim();
  return title === '' ? null : title;
}

/** A reported test name's title below its spec file ("describe > test"), or '' for a bare file. */
function deriveReportedTitle(name: string): string {
  const cutAt = name.indexOf(' > ');
  return cutAt === -1
    ? ''
    : name
        .slice(cutAt + 3)
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Whether a reported test name is the very test the item names: same spec
 * file, and the item's title is the reported title or its tail (an item may
 * omit the describe blocks: "pays by card" matches "checkout > pays by card").
 */
function nameIsItemTest(
  reportedName: string,
  itemFile: string,
  itemTitle: string,
): boolean {
  if (
    !specFilesMatch(
      normalizeSpecPath(deriveFailureSpecFile(reportedName)),
      itemFile,
    )
  ) {
    return false;
  }
  const title = deriveReportedTitle(reportedName);
  return title === itemTitle || title.endsWith(` > ${itemTitle}`);
}

/**
 * The item's verdict when the pipeline reported WHICH tests passed
 * (`tests.passes` present). Nothing here is inferred: a pass needs a passing
 * test name, a failure needs a failing one, and a spec that is in neither list
 * did not run.
 *
 *  1. The item names a specific test: that test failing -> failed, that test
 *     passing -> passed. Neither -> fall through to the spec file, because an
 *     item's wording drifts from the test's title more often than the file moves.
 *  2. Spec file: any failure in it -> failed; else any passing test in it ->
 *     passed; else not_run - the file never executed (or its tests were
 *     filtered out), which the old failure-list inference reported as "passed".
 *
 * Truncation makes absence meaningless, so when the failure list is a prefix
 * (more failed than were named) or the pass list is a prefix (fewer names than
 * `passed`), "not in the lists" and "all passing in the file" both become
 * 'unknown' instead of a guess either way.
 */
function matchPlaywrightConfirmed(
  base: ReturnType<typeof baseResult>,
  tests: QaAutomationTestResults,
  passes: string[],
  testIdentifier: string,
): QaAutomatedResult {
  const itemFile = normalizeSpecPath(deriveItemSpecFile(testIdentifier));
  const itemTitle = deriveItemTestTitle(testIdentifier);
  const inItemFile = (name: string): boolean =>
    specFilesMatch(normalizeSpecPath(deriveFailureSpecFile(name)), itemFile);

  const asFailure = (failure: QaAutomationFailure): QaAutomatedResult => ({
    ...base,
    status: 'failed',
    scope: 'spec',
    matchedSpec: itemFile,
    failure: { name: failure.name, message: failure.message },
  });
  const passedResult = (): QaAutomatedResult => ({
    ...base,
    status: 'passed',
    scope: 'spec',
    matchedSpec: itemFile,
    failure: null,
  });

  if (itemTitle !== null) {
    const exactFailure = tests.failures.find((failure) =>
      nameIsItemTest(failure.name, itemFile, itemTitle),
    );
    if (exactFailure) {
      return asFailure(exactFailure);
    }
    if (passes.some((name) => nameIsItemTest(name, itemFile, itemTitle))) {
      return passedResult();
    }
  }

  const fileFailure = tests.failures.find((failure) =>
    inItemFile(failure.name),
  );
  if (fileFailure) {
    return asFailure(fileFailure);
  }

  const failuresIncomplete = tests.failuresTruncated;
  const passesIncomplete = passes.length < tests.passed;

  if (passes.some(inItemFile)) {
    // Something in the file passed and no failure in it was named. That is a
    // pass only when the failure list is complete.
    return failuresIncomplete
      ? {
          ...base,
          status: 'unknown',
          scope: 'spec',
          matchedSpec: itemFile,
          failure: null,
        }
      : passedResult();
  }

  return {
    ...base,
    status: failuresIncomplete || passesIncomplete ? 'unknown' : 'not_run',
    scope: 'spec',
    matchedSpec: itemFile,
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

  // An item that names no test has nothing to be matched against. The stage
  // verdict (the green suite beside it) is NOT evidence about this item - a
  // home-page smoke test says nothing about "consignment registers correctly" -
  // so it is reported as `unlinked` and left for a person to check. The stage
  // fields stay on the result so the UI can still show that verdict as context.
  if (!testIdentifier?.trim()) {
    return {
      ...base,
      status: 'unlinked',
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

  // The pipeline said which tests passed: decide from names, infer nothing.
  if (tests.passes !== undefined) {
    return matchPlaywrightConfirmed(base, tests, tests.passes, testIdentifier);
  }

  // Older pipeline: no list of passing tests. Keep the original inference (an
  // item passes when its spec is absent from the failure list) but SAY it is
  // an inference, because "absent from the failures" also covers a spec that
  // never ran. Failures are still named evidence and are not marked.
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
      inferred: true,
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
      inferred: true,
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
