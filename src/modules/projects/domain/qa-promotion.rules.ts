import type { QaPromotionChecklist } from '../application/qa-runs/qa-promotion.contracts';
import type {
  QaHeadStatus,
  QaVerdict,
} from '../application/qa-runs/qa-runs.contracts';

/**
 * Plain functions, not injectable classes -- same reasoning as
 * qa-run-access.rules.ts: this has no dependency to wire, so a function
 * keeps it pure data in, data out, and exhaustively unit-testable without a
 * DI container.
 *
 * The gate, verbatim from the task contract:
 *   headSha = the CURRENT head of the QA branch on GitHub (the branch tip,
 *     not a deployed commit). Unreadable -> headSha null, eligible false,
 *     reason "Could not read the uat branch head".
 *   checklists = every non-archived checklist shared to the project (already
 *     filtered by the caller's repository query -- this function trusts its
 *     input list is that set). None -> eligible false, reason "No QA
 *     checklist is shared to this project".
 *   For each checklist: approvedForHead = a run exists for (project,
 *     checklist, branch, headSha) AND it is signed off AND its active
 *     sign-off verdict is APPROVED. A run approved on an OLDER commit does
 *     not count -- the caller only ever looks a run up by the CURRENT
 *     headSha, so it is indistinguishable from "no run" here.
 *   eligible = headSha known AND >=1 checklist AND every checklist
 *     approvedForHead.
 */

export interface QaPromotionRunCandidate {
  id: string;
  status: 'open' | 'signed_off';
  /** The run's active sign-off verdict; null when open, or (defensively) signed off with no active sign-off row. */
  activeVerdict: QaVerdict | null;
}

export interface QaPromotionChecklistCandidate {
  id: string;
  name: string;
  /** The run for (project, checklist, branch, headSha) exactly -- null when none exists for this commit. */
  run: QaPromotionRunCandidate | null;
}

export interface QaPromotionGateInput {
  headSha: string | null;
  checklists: QaPromotionChecklistCandidate[];
}

export interface QaPromotionGateResult {
  checklists: QaPromotionChecklist[];
  eligible: boolean;
  reasons: string[];
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function evaluateChecklist(
  candidate: QaPromotionChecklistCandidate,
  headSha: string | null,
  reasons: string[],
): QaPromotionChecklist {
  const run = candidate.run;
  const base = {
    id: candidate.id,
    name: candidate.name,
    runId: run?.id ?? null,
  };

  if (headSha === null) {
    // The top-level "Could not read the uat branch head" reason already
    // covers this; a per-checklist reason here would only repeat it.
    return { ...base, verdict: null, runStatus: null, approvedForHead: false };
  }

  if (!run) {
    reasons.push(
      `"${candidate.name}": no QA run on uat @ ${shortSha(headSha)}`,
    );
    return { ...base, verdict: null, runStatus: null, approvedForHead: false };
  }

  if (run.status === 'open') {
    reasons.push(`"${candidate.name}": run not signed off yet`);
    return {
      ...base,
      verdict: null,
      runStatus: 'open',
      approvedForHead: false,
    };
  }

  if (run.activeVerdict === 'APPROVED') {
    return {
      ...base,
      verdict: 'APPROVED',
      runStatus: 'signed_off',
      approvedForHead: true,
    };
  }
  if (run.activeVerdict === 'REJECTED') {
    reasons.push(`"${candidate.name}": signed off Rejected`);
    return {
      ...base,
      verdict: 'REJECTED',
      runStatus: 'signed_off',
      approvedForHead: false,
    };
  }
  if (run.activeVerdict === 'CONDITIONAL') {
    reasons.push(
      `"${candidate.name}": signed off Conditional (only Approved counts)`,
    );
    return {
      ...base,
      verdict: 'CONDITIONAL',
      runStatus: 'signed_off',
      approvedForHead: false,
    };
  }

  // Defensive: signed_off with no recorded active verdict. Should not
  // happen (a signed_off run always has an active sign-off row), but this
  // keeps the function total rather than throwing on a data inconsistency.
  reasons.push(`"${candidate.name}": signed off with no recorded verdict`);
  return {
    ...base,
    verdict: null,
    runStatus: 'signed_off',
    approvedForHead: false,
  };
}

export function evaluateQaPromotionGate(
  input: QaPromotionGateInput,
): QaPromotionGateResult {
  const reasons: string[] = [];

  if (input.headSha === null) {
    reasons.push('Could not read the uat branch head');
  }
  if (input.checklists.length === 0) {
    reasons.push('No QA checklist is shared to this project');
  }

  const checklists = input.checklists.map((candidate) =>
    evaluateChecklist(candidate, input.headSha, reasons),
  );

  const eligible =
    input.headSha !== null &&
    input.checklists.length > 0 &&
    checklists.every((checklist) => checklist.approvedForHead);

  return { checklists, eligible, reasons };
}

// ---------------------------------------------------------------------
// Per-Project gate (docs/design/project-requirements.md, section 3)
// ---------------------------------------------------------------------

/**
 * A repository may merge uat to main only when the LATEST SIGNED-OFF Project
 * run is APPROVED and still current for EVERY repository of the Project:
 *   - every repository's uat head was readable;
 *   - the Project has at least one requirement, and a signed-off run exists;
 *   - that run's active verdict is APPROVED (Rejected and Conditional block);
 *   - the run has a coverage row for every repository of the Project, and each
 *     captured head equals the repository's head now. A repository that moved,
 *     or that joined the Project after the run, makes the run stale for all;
 *   - the run PASSED every item the Iteration's requirements hold now (an
 *     item added after the run started was never verified), and no
 *     requirement changed after the sign-off. A delivered Iteration therefore
 *     never holds unfinished work, so the next one starts empty.
 *
 * Using the latest signed-off run (not "any approved run") means a later
 * Rejected sign-off on newer heads blocks even when an older run was approved.
 * A single-repository Project degenerates to the old per-repository rule: one
 * head, one run, the same verdict check. Open runs never count.
 */
export interface QaProjectGateRepository {
  projectId: string;
  repoFullName: string;
  /** The uat head now; null when it could not be read. */
  currentSha: string | null;
}

export interface QaProjectGateRun {
  id: string;
  /** The run's active sign-off verdict; null only on a data inconsistency (defensive). */
  verdict: QaVerdict | null;
  signedAt: string;
  /** The heads the run captured when it started. */
  coverage: ReadonlyArray<{ projectId: string; headSha: string }>;
}

export interface QaProjectGateInput {
  repositories: readonly QaProjectGateRepository[];
  requirementCount: number;
  latestSignedOffRun: QaProjectGateRun | null;
  /** Items of the Iteration's active requirements the signed-off run did not pass (0 without a run). */
  itemsNotPassed: number;
  /**
   * Items of the signed-off run the Product owner has not passed yet (0
   * without a run, ADR-0014 amendment 12). Optional for callers that predate
   * acceptance; absent counts as none.
   */
  itemsNotAccepted?: number;
  /** A requirement was created, edited, archived or had items changed after the sign-off. */
  requirementsChangedAfterSignoff: boolean;
}

export interface QaProjectGateResult {
  eligible: boolean;
  reasons: string[];
  repositories: QaHeadStatus[];
  run: {
    id: string;
    verdict: QaVerdict;
    signedAt: string;
    stale: boolean;
  } | null;
}

function pluralItems(count: number): string {
  return count === 1
    ? '1 requirement item is'
    : `${String(count)} requirement items are`;
}

function repoLabel(repoFullName: string): string {
  return repoFullName.split('/').pop() || repoFullName;
}

export function evaluateProjectPromotionGate(
  input: QaProjectGateInput,
): QaProjectGateResult {
  const reasons: string[] = [];
  const run = input.latestSignedOffRun;
  const captured = new Map(
    (run?.coverage ?? []).map((row) => [row.projectId, row.headSha]),
  );

  const repositories: QaHeadStatus[] = input.repositories.map((repository) => {
    const runSha = run ? (captured.get(repository.projectId) ?? null) : null;
    const moved =
      run !== null &&
      repository.currentSha !== null &&
      runSha !== repository.currentSha;
    return {
      projectId: repository.projectId,
      repoFullName: repository.repoFullName,
      runSha,
      currentSha: repository.currentSha,
      moved,
    };
  });

  for (const repository of input.repositories) {
    if (repository.currentSha === null) {
      reasons.push(
        `Could not read the uat head of "${repoLabel(repository.repoFullName)}"`,
      );
    }
  }
  if (input.requirementCount === 0) {
    reasons.push('This Project has no QA requirements');
  }

  let stale = false;
  if (!run) {
    reasons.push('No QA run covers the current uat heads');
  } else {
    stale = repositories.some((repository) => repository.moved);
    if (run.verdict === 'REJECTED') {
      reasons.push('Latest sign-off is Rejected');
    } else if (run.verdict === 'CONDITIONAL') {
      reasons.push('Latest sign-off is Conditional (only Approved counts)');
    } else if (run.verdict === null) {
      reasons.push('Latest sign-off has no recorded verdict');
    }
    for (const repository of repositories) {
      if (!repository.moved) {
        continue;
      }
      const label = repoLabel(repository.repoFullName);
      reasons.push(
        repository.runSha === null
          ? `Project run is stale: "${label}" was added to the Project after the run`
          : `Project run is stale: "${label}" moved from ${shortSha(repository.runSha)} to ${shortSha(repository.currentSha as string)}`,
      );
    }
    if (input.itemsNotPassed > 0) {
      reasons.push(
        `${pluralItems(input.itemsNotPassed)} not passed in the signed-off QA run: a Product owner reopens the run so QA verifies them`,
      );
    }
    if (input.requirementsChangedAfterSignoff) {
      reasons.push(
        'Requirements changed after QA signed off: a Product owner reopens the run so QA verifies them',
      );
    }
    const notAccepted = input.itemsNotAccepted ?? 0;
    if (notAccepted > 0) {
      reasons.push(
        notAccepted === 1
          ? '1 item is waiting for the Product owner to pass it'
          : `${String(notAccepted)} items are waiting for the Product owner to pass them`,
      );
    }
  }

  const eligible =
    reasons.length === 0 &&
    run !== null &&
    run.verdict === 'APPROVED' &&
    !stale;

  return {
    eligible,
    reasons,
    repositories,
    run:
      run && run.verdict
        ? {
            id: run.id,
            verdict: run.verdict,
            signedAt: run.signedAt,
            stale,
          }
        : null,
  };
}
