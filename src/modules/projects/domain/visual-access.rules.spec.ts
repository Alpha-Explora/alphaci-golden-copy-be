import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import { canApproveVisualBaseline } from './visual-access.rules';

describe('canApproveVisualBaseline', () => {
  const ROLES: PlatformAppRole[] = ['admin', 'lead', 'qa', 'member'];
  const ALLOWED = ['admin', 'lead', 'member'];

  it.each(ROLES)('role=%s', (role) => {
    expect(canApproveVisualBaseline(role)).toBe(ALLOWED.includes(role));
  });

  it('keeps QA view-only', () => {
    expect(canApproveVisualBaseline('qa')).toBe(false);
  });

  it('fails closed for an unresolved or future role', () => {
    expect(canApproveVisualBaseline('auditor' as PlatformAppRole)).toBe(false);
    expect(canApproveVisualBaseline(null)).toBe(false);
    expect(canApproveVisualBaseline(undefined)).toBe(false);
  });
});
