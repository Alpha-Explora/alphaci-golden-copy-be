import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import {
  canAddEvidence,
  canAddFixProof,
  canCreateRun,
  canDispatchAutomation,
  canManageRequirements,
  canMergeQaPromotion,
  canReopenRun,
  canRequestRetest,
  canSetProgress,
  canSetReturnedToDev,
  canSetVerification,
  canSignOff,
} from './qa-run-access.rules';

const ROLES: PlatformAppRole[] = ['admin', 'lead', 'qa', 'member'];

/** The allow-list each rule must equal, over the four app roles. */
const EXPECTED: Array<
  [name: string, rule: (role: PlatformAppRole) => boolean, allowed: string[]]
> = [
  ['canManageRequirements', canManageRequirements, ['admin', 'lead']],
  ['canSetProgress', canSetProgress, ['admin', 'lead', 'member']],
  ['canSetVerification', canSetVerification, ['admin', 'lead', 'qa']],
  ['canSetReturnedToDev', canSetReturnedToDev, ['admin', 'lead', 'qa']],
  ['canCreateRun', canCreateRun, ['admin', 'lead', 'qa']],
  ['canSignOff', canSignOff, ['admin', 'lead', 'qa']],
  ['canDispatchAutomation', canDispatchAutomation, ['admin', 'lead', 'qa']],
  ['canReopenRun', canReopenRun, ['admin', 'lead']],
  ['canMergeQaPromotion', canMergeQaPromotion, ['admin', 'lead']],
  ['canRequestRetest', canRequestRetest, ['admin', 'lead', 'member']],
  ['canAddEvidence', canAddEvidence, ['admin', 'lead', 'qa']],
  ['canAddFixProof', canAddFixProof, ['admin', 'lead', 'member']],
];

describe.each(EXPECTED)('%s', (_name, rule, allowed) => {
  it.each(ROLES)('role=%s', (role) => {
    expect(rule(role)).toBe(allowed.includes(role));
  });

  it('fails closed for an unresolved role', () => {
    expect(rule('unknown' as PlatformAppRole)).toBe(false);
  });
});

describe('Progress and Verification are disjoint tracks', () => {
  it('QA verifies but never sets Progress; a developer sets Progress but never verifies', () => {
    expect(canSetProgress('qa')).toBe(false);
    expect(canSetVerification('qa')).toBe(true);
    expect(canSetProgress('member')).toBe(true);
    expect(canSetVerification('member')).toBe(false);
  });
});
