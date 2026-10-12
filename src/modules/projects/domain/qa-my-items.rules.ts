import type { QaProgress } from '../application/qa-checklists/qa-requirements.contracts';
import type { QaRunItemStatus } from '../application/qa-runs/qa-runs.contracts';

/** The buckets of GET /delivery-projects/:id/qa/my-items. */
export type QaMyItemsBucket = 'returned' | 'inProgress' | 'todo' | 'readyForQa';

/**
 * Which My QA items bucket one requirement item belongs to, or null when it
 * is in none (done, and QA already decided it).
 *
 * The single definition of the feed's rule. The feed itself
 * (QaProjectRunsService.myItems) and the team overview's `readyForQa` count
 * (QaRequirementsService.overview) both call it, so the two cannot disagree
 * about what "ready for QA" means.
 *
 * `runItemStatus` is the item's Verification status on the run being read, or
 * null when that run has no run item for it (or there is no run). Order
 * matters: a returned run item wins over Progress, and Progress `todo` /
 * `in_progress` win over a pending run item. Only a `done` item whose run
 * item is pending (or missing) is QA's queue; one that is passed, failed or
 * blocked is not in any bucket.
 *
 * A plain function, not a class: undecorated classes under domain/ get no
 * constructor args from Nest.
 */
export function bucketMyQaItem(
  progress: QaProgress,
  runItemStatus: QaRunItemStatus | null,
): QaMyItemsBucket | null {
  if (runItemStatus === 'returned_to_dev') {
    return 'returned';
  }
  if (progress === 'in_progress') {
    return 'inProgress';
  }
  if (progress === 'todo') {
    return 'todo';
  }
  if (runItemStatus === null || runItemStatus === 'pending') {
    return 'readyForQa';
  }
  return null;
}
