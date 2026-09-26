import type { QaPromotionChecklist } from '../application/qa-runs/qa-promotion.contracts';
import type { QaVerdict } from '../application/qa-runs/qa-runs.contracts';

/**
 * Plain function, not an injectable class -- same reasoning as
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
