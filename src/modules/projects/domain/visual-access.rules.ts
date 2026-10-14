import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';

/**
 * Plain functions, not an injectable class, and allow-lists only, for the same
 * reasons as qa-run-access.rules.ts: undecorated classes under domain/ get no
 * constructor args from Nest, and a rule written by exclusion ("anyone but
 * qa") silently hands every role added later the power to change what the
 * product treats as correct. An unresolved or future role gets nothing.
 *
 * Visual baselines (the screenshots a Playwright run is compared against):
 *   Viewing the Visual tab: anyone who can see the project (not a role rule).
 *   Approving a changed or new snapshot as the new baseline: member (Developer),
 *     lead (Product owner), admin. QA reviews and reports defects but does not
 *     decide that a visual change is intended - that is the author's or the
 *     owner's call - so QA, and every other role, is view-only.
 */
const VISUAL_APPROVER_ROLES: readonly PlatformAppRole[] = [
  'member',
  'lead',
  'admin',
];

export function canApproveVisualBaseline(
  role: PlatformAppRole | null | undefined,
): boolean {
  return role != null && VISUAL_APPROVER_ROLES.includes(role);
}
