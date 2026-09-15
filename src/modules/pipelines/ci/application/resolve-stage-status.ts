import type { FriendlyMessage } from './translate-results';

/**
 * What a stage with no report actually means.
 *
 * A stage only appears in ci_run_reports once its `report-results` job runs, so
 * a stage that never reported has no row. Every one of those was rendered as
 * `pending`, which covered three different situations and told the user nothing:
 *
 *   really pending  the stage has not been reached yet, and will be
 *   blocked         an earlier stage failed, so this one will never run
 *   stalled         the stage before it succeeded, enough time has passed, and
 *                   still nothing arrived — the workflow did not start
 *
 * The third is the one that hurt. A workflow rejected at startup — a bad
 * `uses:` reference, an undeclared secret, a private repository another
 * organisation cannot read — never executes a single job, so `report-results`
 * cannot run and cannot report. The pipeline was broken and the product said
 * "pending" indefinitely.
 *
 * The stages run in order and each triggers the next, so the report rows of the
 * earlier stages already say which case applies. No call to GitHub is needed to
 * tell them apart. Naming *why* still needs GitHub, and belongs where a token
 * already exists; this decides *that* something is wrong.
 */

/*
 * Stage order lives in ./stages, which the translator also reads. Imported and
 * re-exported rather than forwarded straight through, so this module keeps a
 * local binding: `Record<StageId, ...>` is built here, and a bare
 * `export ... from` leaves nothing local for that mapped type to close over.
 */
import { STAGE_ORDER, type StageId } from './stages';

export { STAGE_ORDER, type StageId };

export type StageStatus =
  | 'success'
  | 'failure'
  | 'running'
  | 'cancelled'
  | 'pending'
  | 'blocked'
  | 'stalled';

/**
 * How long a stage may stay silent after the one before it succeeded.
 *
 * Generous on purpose. A queued run on a busy runner is still legitimately
 * pending, and calling it broken would be worse than saying nothing — the whole
 * point is to stop reporting a state that is not true. A workflow rejected at
 * startup fails in seconds, so anything past this window is not queueing.
 */
export const STALLED_AFTER_MS = 15 * 60 * 1000;

export interface ReportedStage {
  status: StageStatus;
  updatedAt: string;
}

/** A stage's resolved state, plus the message explaining it when it is not one. */
export interface ResolvedStage {
  status: StageStatus;
  friendlyMessages: FriendlyMessage[];
}

/**
 * A state after which no later stage will run.
 *
 * `stalled` belongs here. If a stage never started, nothing downstream did
 * either, and marking each of them stalled in turn would report one broken
 * pipeline as three separate problems. Naming the first one and calling the
 * rest consequences is what makes the view readable.
 */
function isTerminalFailure(status: StageStatus): boolean {
  return (
    status === 'failure' ||
    status === 'cancelled' ||
    status === 'blocked' ||
    status === 'stalled'
  );
}

const BLOCKED_MESSAGE = (blockedBy: StageId): FriendlyMessage => ({
  severity: 'info',
  title: 'Not run',
  detail: `The ${blockedBy} stage did not pass, so this stage was never triggered.`,
  hint: `Fix the ${blockedBy} stage and the rest of the pipeline will run.`,
});

/*
 * What we know is that nothing arrived. Why is a separate question.
 *
 * This used to answer it anyway - "the workflow was rejected before any job
 * ran" - and that was wrong the first time it was checked against a real
 * stalled stage. The package stage on stpetertestfe ran NINE jobs, failed on
 * the Vercel deploy, and reported in full; the report was simply filed under
 * `main`, because workflow_run reads the workflow FILE from the default
 * branch and main's copy still resolved the branch the old way. A reader
 * following this text went looking for a startup rejection that had never
 * happened, while the real failure sat one branch away with its own per-tool
 * detail.
 *
 * So the title says what is true - no report - and the causes are listed as
 * candidates rather than announced as the answer. The same mistake in the
 * failed-job hints cost the same kind of time, and the fix is the same one:
 * a product that cannot tell three causes apart should name three.
 */
const STALLED_MESSAGE: FriendlyMessage = {
  severity: 'error',
  title: 'Stage reported nothing',
  detail:
    'The stage before this one succeeded, but no report arrived from this stage. Either it never ran, or it ran and its report was recorded somewhere this view is not looking.',
  hint: 'Check the run on GitHub first: if jobs ran, the stage executed and the report went astray — most often to another branch, when the workflow on the default branch is older than the one that was pushed. If no jobs ran, the workflow was rejected at startup, usually a referenced workflow that cannot be resolved or a secret the called workflow does not declare.',
};

/**
 * Resolve every stage of one run, filling in the ones that never reported.
 *
 * @param reported  stages that posted a report, keyed by stage id
 * @param now       evaluation time, injected so the rule is testable
 */
export function resolveStages(
  reported: Partial<Record<StageId, ReportedStage>>,
  now: Date = new Date(),
): Record<StageId, ResolvedStage> {
  const resolved = {} as Record<StageId, ResolvedStage>;
  let blockedBy: StageId | undefined;
  let previous: { stage: StageId; state: ReportedStage } | undefined;

  for (const stage of STAGE_ORDER) {
    const report = reported[stage];

    if (report) {
      resolved[stage] = { status: report.status, friendlyMessages: [] };
      if (isTerminalFailure(report.status) && blockedBy === undefined) {
        blockedBy = stage;
      }
      previous = { stage, state: report };
      continue;
    }

    // No report. An earlier failure explains it completely.
    if (blockedBy !== undefined) {
      resolved[stage] = {
        status: 'blocked',
        friendlyMessages: [BLOCKED_MESSAGE(blockedBy)],
      };
      continue;
    }

    // Nothing before it has succeeded yet, so it genuinely has not been reached.
    if (!previous || previous.state.status !== 'success') {
      resolved[stage] = { status: 'pending', friendlyMessages: [] };
      continue;
    }

    const since = Date.parse(previous.state.updatedAt);
    const waited = Number.isNaN(since) ? 0 : now.getTime() - since;

    if (waited > STALLED_AFTER_MS) {
      resolved[stage] = {
        status: 'stalled',
        friendlyMessages: [STALLED_MESSAGE],
      };
      blockedBy = stage;
      continue;
    }

    resolved[stage] = { status: 'pending', friendlyMessages: [] };
  }

  return resolved;
}

/**
 * Overall status for a run, given its resolved stages.
 *
 * `stalled` counts as a failure: the pipeline stopped and will not continue on
 * its own. Treating it as anything softer would put the run back in the state
 * this module exists to remove.
 */
export function resolveOverallStatus(
  stages: readonly ResolvedStage[],
): 'success' | 'failure' | 'running' | 'cancelled' | 'partial' {
  const statuses = stages.map((stage) => stage.status);

  if (statuses.some((s) => s === 'failure' || s === 'stalled'))
    return 'failure';
  if (statuses.some((s) => s === 'cancelled')) return 'cancelled';
  if (statuses.some((s) => s === 'running')) return 'running';
  if (statuses.every((s) => s === 'success')) return 'success';
  return 'partial';
}
