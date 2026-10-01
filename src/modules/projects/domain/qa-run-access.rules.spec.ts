import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import type { QaChecklistTargetPersona } from '../application/qa-checklists/qa-checklists.contracts';
import {
  canCreateRun,
  canDispatchAutomation,
  canMergeQaPromotion,
  canReopenRun,
  canRequestRetest,
  canSetReturnedToDev,
  canSignOff,
  personaAllowsRole,
} from './qa-run-access.rules';

const ROLES: PlatformAppRole[] = ['admin', 'lead', 'qa', 'member'];
const PERSONAS: QaChecklistTargetPersona[] = ['developer', 'qa', 'all'];

/**
 * QA is the primary verifier and marks every item, developer items included;
 * Developers mark their own (developer) and shared (all) items, not QA-only.
 */
const EXPECTED_PERSONA_MATRIX: Record<
  QaChecklistTargetPersona,
  Record<PlatformAppRole, boolean>
> = {
  developer: { admin: true, lead: true, qa: true, member: true },
  qa: { admin: true, lead: true, qa: true, member: false },
  all: { admin: true, lead: true, qa: true, member: true },
};

describe('personaAllowsRole — full 3x4 persona/role matrix', () => {
  for (const persona of PERSONAS) {
    for (const role of ROLES) {
      const expected = EXPECTED_PERSONA_MATRIX[persona][role];
      it(`persona=${persona} role=${role} -> ${expected}`, () => {
        expect(personaAllowsRole(persona, role)).toBe(expected);
      });
    }
  }
});

describe('canCreateRun', () => {
  it('allows qa, lead, admin; forbids member', () => {
    expect(canCreateRun('qa')).toBe(true);
    expect(canCreateRun('lead')).toBe(true);
    expect(canCreateRun('admin')).toBe(true);
    expect(canCreateRun('member')).toBe(false);
  });
});

describe('canSetReturnedToDev', () => {
  it('allows qa, lead, admin; forbids member, regardless of item persona', () => {
    expect(canSetReturnedToDev('qa')).toBe(true);
    expect(canSetReturnedToDev('lead')).toBe(true);
    expect(canSetReturnedToDev('admin')).toBe(true);
    expect(canSetReturnedToDev('member')).toBe(false);
  });
});

describe('canRequestRetest', () => {
  it('allows member, lead, admin; forbids qa (deliberately)', () => {
    expect(canRequestRetest('member')).toBe(true);
    expect(canRequestRetest('lead')).toBe(true);
    expect(canRequestRetest('admin')).toBe(true);
    expect(canRequestRetest('qa')).toBe(false);
  });
});

describe('canSignOff', () => {
  it('allows qa, lead, admin; forbids member', () => {
    expect(canSignOff('qa')).toBe(true);
    expect(canSignOff('lead')).toBe(true);
    expect(canSignOff('admin')).toBe(true);
    expect(canSignOff('member')).toBe(false);
  });
});

describe('canReopenRun', () => {
  it('allows only lead and admin', () => {
    expect(canReopenRun('lead')).toBe(true);
    expect(canReopenRun('admin')).toBe(true);
    expect(canReopenRun('qa')).toBe(false);
    expect(canReopenRun('member')).toBe(false);
  });
});

describe('canDispatchAutomation', () => {
  it('allows qa, lead, admin; forbids member', () => {
    expect(canDispatchAutomation('qa')).toBe(true);
    expect(canDispatchAutomation('lead')).toBe(true);
    expect(canDispatchAutomation('admin')).toBe(true);
    expect(canDispatchAutomation('member')).toBe(false);
  });
});

describe('canMergeQaPromotion', () => {
  it('allows only lead and admin', () => {
    expect(canMergeQaPromotion('lead')).toBe(true);
    expect(canMergeQaPromotion('admin')).toBe(true);
    expect(canMergeQaPromotion('qa')).toBe(false);
    expect(canMergeQaPromotion('member')).toBe(false);
  });
});
