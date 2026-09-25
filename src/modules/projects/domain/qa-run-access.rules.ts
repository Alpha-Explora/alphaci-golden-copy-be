import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import type { QaChecklistTargetPersona } from '../application/qa-checklists/qa-checklists.contracts';

/**
 * Plain functions, not an injectable class: same reasoning as
 * preview-surface.rule.ts — undecorated classes under domain/ get no
 * constructor args from Nest, and none of these rules has a dependency to
 * wire, so a function keeps them pure data in, data out.
 *
 * The permission matrix, verbatim from the task contract:
 *   PATCH by item.targetPersona: developer -> member|lead|admin;
 *                                 qa        -> qa|lead|admin;
 *                                 all       -> qa|member|lead|admin.
 *   Setting status 'returned_to_dev': qa|lead|admin only, regardless of persona.
 *   Creating a run, and signing off: qa|lead|admin.
 *   request-retest: member|lead|admin (deliberately NOT qa — QA flags a
 *     defect, member/lead/admin says it is fixed and ready to re-check).
 *   Reopening a signed-off run: lead|admin only.
 */

/** Whether `role` may PATCH an item whose checklist item persona is `persona`. */
export function personaAllowsRole(
  persona: QaChecklistTargetPersona,
  role: PlatformAppRole,
): boolean {
  if (role === 'admin' || role === 'lead') {
    return true;
  }
  if (persona === 'all') {
    return true;
  }
  if (persona === 'developer') {
    return role === 'member';
  }
  // persona === 'qa'
  return role === 'qa';
}

export function canCreateRun(role: PlatformAppRole): boolean {
  return role === 'qa' || role === 'lead' || role === 'admin';
}

/** Setting an item's status TO 'returned_to_dev' — QA feedback, regardless of the item's persona. */
export function canSetReturnedToDev(role: PlatformAppRole): boolean {
  return role === 'qa' || role === 'lead' || role === 'admin';
}

export function canRequestRetest(role: PlatformAppRole): boolean {
  return role === 'member' || role === 'lead' || role === 'admin';
}

export function canSignOff(role: PlatformAppRole): boolean {
  return role === 'qa' || role === 'lead' || role === 'admin';
}

export function canReopenRun(role: PlatformAppRole): boolean {
  return role === 'lead' || role === 'admin';
}
