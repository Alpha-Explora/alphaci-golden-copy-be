import type { QaPromotionChecklist } from './qa-promotion.contracts';

/** The Project run behind a promotion, for the pull request body. */
export interface QaPromotionRunSummary {
  runId: string;
  repositories: ReadonlyArray<{
    repoFullName: string;
    /** The uat head the run captured; null when this repository joined after it. */
    runSha: string | null;
  }>;
}

/**
 * The body of the "Promote uat to main" pull request this feature opens,
 * listing each requirement the approving Project run covered and the
 * repositories (with the heads) it captured. Only ever called once the gate has
 * already confirmed the Project's latest signed-off run is Approved and
 * current -- runId/verdict fall back to "unknown" defensively rather than
 * throwing, since the type itself still allows null.
 */
export function buildQaPromotionPullRequestBody(
  checklists: QaPromotionChecklist[],
  headSha: string,
  run?: QaPromotionRunSummary,
): string {
  const sha7 = headSha.slice(0, 7);
  const lines = checklists.map(
    (checklist) =>
      `- **${checklist.name}** — run ${checklist.runId ?? 'unknown'}, ${
        checklist.verdict ?? 'unknown'
      } (${sha7})`,
  );

  const lead = [
    `Promoting \`uat\` (${sha7}) to \`main\`.`,
    '',
    'QA requirements approved by the Project run:',
    ...lines,
  ];
  if (!run) {
    return lead.join('\n');
  }
  return [
    ...lead,
    '',
    `Project run ${run.runId} covered:`,
    ...run.repositories.map(
      (repository) =>
        `- \`${repository.repoFullName}\` @ ${repository.runSha ? repository.runSha.slice(0, 7) : 'unknown'}`,
    ),
  ].join('\n');
}
