import type {
  CoveredRepository,
  DeliveredRepository,
  DeliveryHow,
  ProjectIterationStatus,
} from '../application/qa-checklists/project-iterations.contracts';

/**
 * Pure rules for delivering a Project's Iteration (ITERATIONS_PLAN.md P4-P7).
 * An Iteration is delivered when EVERY covered repository's main contains the
 * signed-off uat head. No Nest, no I/O.
 */

/** One repository the delivering run captured. */
export interface RunCoverageRepository {
  projectId: string;
  repoFullName: string;
  /** The uat head the signed-off run captured. */
  headSha: string;
}

/**
 * The repositories a delivery must cover: those the signed-off run captured
 * that are STILL linked to the Project, in a stable order (by name). A
 * repository removed from the Project since the sign-off can no longer be
 * merged from it, so it must not block delivery forever.
 */
export function coveredRepositoriesOf(
  coverage: readonly RunCoverageRepository[],
  currentProjectIds: ReadonlySet<string>,
): RunCoverageRepository[] {
  return coverage
    .filter((row) => currentProjectIds.has(row.projectId))
    .slice()
    .sort((a, b) => a.repoFullName.localeCompare(b.repoFullName));
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * `delivery_json` is `{ repositories: [...] }`. Anything else (null, the
 * phase 1 bare array, junk) reads as the entries it holds, never as a throw.
 */
export function parseDeliveryEntries(json: unknown): DeliveredRepository[] {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === 'object'
      ? (json as { repositories?: unknown }).repositories
      : null;
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object',
    )
    .map((entry) => ({
      projectId: str(entry.projectId),
      repoFullName: str(entry.repoFullName),
      uatHeadSha: str(entry.uatHeadSha),
      mergeSha: typeof entry.mergeSha === 'string' ? entry.mergeSha : null,
      prNumber: typeof entry.prNumber === 'number' ? entry.prNumber : null,
      how: (entry.how === 'already_in_main'
        ? 'already_in_main'
        : 'merged') as DeliveryHow,
      at: typeof entry.at === 'string' ? entry.at : '',
    }));
}

/**
 * The stored entry that proves `repository` is delivered: same repository and,
 * while the Iteration is active, the same uat head the run captured (an entry
 * for an older head does not count once the head moved and was re-approved).
 * A delivered Iteration is frozen, so any entry of the repository counts.
 */
export function deliveryEntryFor(
  entries: readonly DeliveredRepository[],
  repository: { projectId: string; headSha: string | null },
  iterationStatus: ProjectIterationStatus,
): DeliveredRepository | null {
  return (
    entries.find(
      (entry) =>
        entry.projectId === repository.projectId &&
        (iterationStatus === 'delivered' ||
          repository.headSha === null ||
          entry.uatHeadSha === repository.headSha),
    ) ?? null
  );
}

/** Per-repository state for the covered repositories. */
export function describeCovered(
  covered: readonly RunCoverageRepository[],
  entries: readonly DeliveredRepository[],
  iterationStatus: ProjectIterationStatus,
): CoveredRepository[] {
  return covered.map((repository) => {
    const entry = deliveryEntryFor(entries, repository, iterationStatus);
    return {
      projectId: repository.projectId,
      repoFullName: repository.repoFullName,
      delivered: entry !== null,
      how: entry?.how ?? null,
    };
  });
}

/** Delivered when there is at least one covered repository and all of them are. */
export function isDeliveryComplete(
  covered: readonly RunCoverageRepository[],
  entries: readonly DeliveredRepository[],
  iterationStatus: ProjectIterationStatus,
): boolean {
  return (
    covered.length > 0 &&
    covered.every(
      (repository) =>
        deliveryEntryFor(entries, repository, iterationStatus) !== null,
    )
  );
}

/**
 * Does `main` contain the signed-off uat head?
 *
 * Compared as `compare/{uatHead}...main`: GitHub reports the status of the
 * HEAD of the comparison (main) relative to its BASE (the uat sha):
 *   ahead      main has commits the uat head lacks, and contains the uat head
 *   identical  main IS the uat head
 *   behind     main is an ANCESTOR of the uat head: the uat head is not in main
 *   diverged   neither contains the other
 * so only `ahead` and `identical` mean "already in main". (The plan's P4 text
 * had the directions the other way round.)
 */
export function mainContainsHead(
  status: 'ahead' | 'behind' | 'diverged' | 'identical' | null,
): boolean {
  return status === 'ahead' || status === 'identical';
}
