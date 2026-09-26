import type { QaPromotionChecklist } from './qa-promotion.contracts';

/**
 * The body of the "Promote uat to main" pull request this feature opens,
 * listing each checklist that approved the commit being promoted. Only ever
 * called once the gate has already confirmed every checklist is
 * approvedForHead -- runId/verdict fall back to "unknown" defensively rather
 * than throwing, since the type itself still allows null.
 */
export function buildQaPromotionPullRequestBody(
  checklists: QaPromotionChecklist[],
  headSha: string,
): string {
  const sha7 = headSha.slice(0, 7);
  const lines = checklists.map(
    (checklist) =>
      `- **${checklist.name}** — run ${checklist.runId ?? 'unknown'}, ${
        checklist.verdict ?? 'unknown'
      } (${sha7})`,
  );

  return [
    `Promoting \`uat\` (${sha7}) to \`main\`.`,
    '',
    'QA checklists approved on this commit:',
    ...lines,
  ].join('\n');
}
