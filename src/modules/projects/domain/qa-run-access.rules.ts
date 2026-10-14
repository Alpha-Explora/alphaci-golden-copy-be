import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';

export { canManageRequirements } from '#kernel/rules/persona-access.rules';

/**
 * Plain functions, not an injectable class: same reasoning as
 * preview-surface.rule.ts — undecorated classes under domain/ get no
 * constructor args from Nest, and none of these rules has a dependency to
 * wire, so a function keeps them pure data in, data out. Every check is an
 * allow-list: an unresolved or future role gets nothing.
 *
 * The permission matrix (docs/design/project-requirements.md, section 4.1):
 *   Creating/editing requirements (canManageRequirements): lead|admin.
 *   Setting an item's Progress (todo / in_progress / done): member|lead|admin.
 *     QA does not write Progress; it verifies.
 *   Setting an item's Verification (pending / passed / failed / blocked /
 *     returned_to_dev): qa|lead|admin. Developers lose it - they report
 *     Progress and QA decides.
 *   Creating a run, signing off, dispatching automation: qa|lead|admin.
 *   Reopening a signed-off run, merging to main: lead|admin only.
 *   request-retest (compatibility alias that sets Progress to done):
 *     member|lead|admin.
 */

/** Setting an item's Progress: the developer track. */
export function canSetProgress(role: PlatformAppRole): boolean {
  return role === 'member' || role === 'lead' || role === 'admin';
}

/** Setting an item's Verification: the QA track. */
export function canSetVerification(role: PlatformAppRole): boolean {
  return role === 'qa' || role === 'lead' || role === 'admin';
}

export function canCreateRun(role: PlatformAppRole): boolean {
  return role === 'qa' || role === 'lead' || role === 'admin';
}

/** Setting an item's status TO 'returned_to_dev' — QA feedback. */
export function canSetReturnedToDev(role: PlatformAppRole): boolean {
  return role === 'qa' || role === 'lead' || role === 'admin';
}

/** The request-retest alias, kept for the frontend that predates Progress. */
export function canRequestRetest(role: PlatformAppRole): boolean {
  return role === 'member' || role === 'lead' || role === 'admin';
}

export function canSignOff(role: PlatformAppRole): boolean {
  return role === 'qa' || role === 'lead' || role === 'admin';
}

export function canReopenRun(role: PlatformAppRole): boolean {
  return role === 'lead' || role === 'admin';
}

/** Dispatching the verify workflow's Playwright run: same set as creating a run and signing off. */
export function canDispatchAutomation(role: PlatformAppRole): boolean {
  return role === 'qa' || role === 'lead' || role === 'admin';
}

/** Merging a QA-approved uat commit to main: lead|admin only, same set as reopening a signed-off run. */
export function canMergeQaPromotion(role: PlatformAppRole): boolean {
  return role === 'lead' || role === 'admin';
}

/** Attaching screenshot evidence to a run item: the Verification track (qa|lead|admin). */
export function canAddEvidence(role: PlatformAppRole): boolean {
  return role === 'qa' || role === 'lead' || role === 'admin';
}

/**
 * Deleting a human attachment someone else uploaded: lead|admin only. The
 * uploader may always delete their own while the run is open (the service
 * checks the uploader, since a role alone cannot).
 */
export function canRemoveAnyAttachment(role: PlatformAppRole): boolean {
  return role === 'lead' || role === 'admin';
}
