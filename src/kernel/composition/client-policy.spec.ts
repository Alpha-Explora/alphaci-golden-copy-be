import {
  applyClientPolicy,
  assertPolicyAppliesTo,
  parseClientId,
} from './client-policy.js';
import { PACK_MANIFESTS } from './manifests.js';

const validPolicy = {
  clientId: 'northwind',
  displayName: 'Northwind Industries',
  edition: 'enterprise',
  disabledCapabilities: ['runtime.preview-deployments'],
} as const;

describe('parseClientId', () => {
  it('treats an unset or blank value as no client', () => {
    expect(parseClientId(undefined)).toBeNull();
    expect(parseClientId('   ')).toBeNull();
  });

  it('trims a valid slug and rejects anything else', () => {
    expect(parseClientId('  northwind ')).toBe('northwind');
    expect(() => parseClientId('North Wind')).toThrow(/Invalid ALPHACI_CLIENT/);
    expect(() => parseClientId('-leading')).toThrow(/Invalid ALPHACI_CLIENT/);
  });
});

describe('assertPolicyAppliesTo', () => {
  it('rejects a policy written for another edition', () => {
    expect(() =>
      assertPolicyAppliesTo(validPolicy, PACK_MANIFESTS.edu, 'test'),
    ).toThrow(/declares edition 'enterprise' but this deployment runs 'edu'/);
  });

  it('rejects removing a capability the edition never had', () => {
    const policy = {
      ...validPolicy,
      disabledCapabilities: ['identity.lms-lti'],
    } as const;

    expect(() =>
      assertPolicyAppliesTo(policy, PACK_MANIFESTS.enterprise, 'test'),
    ).toThrow(/does not contain/);
  });
});

describe('applyClientPolicy', () => {
  it('returns the same manifest when nothing is narrowed', () => {
    const empty = { ...validPolicy, disabledCapabilities: [] } as const;

    expect(applyClientPolicy(PACK_MANIFESTS.enterprise, null)).toBe(
      PACK_MANIFESTS.enterprise,
    );
    expect(applyClientPolicy(PACK_MANIFESTS.enterprise, empty)).toBe(
      PACK_MANIFESTS.enterprise,
    );
  });

  it('removes only the declared keys and keeps registry order', () => {
    const policy = {
      ...validPolicy,
      disabledCapabilities: [
        'runtime.preview-deployments',
        'platform.data-residency',
      ],
    } as const;
    const narrowed = applyClientPolicy(PACK_MANIFESTS.enterprise, policy);
    const expected = PACK_MANIFESTS.enterprise.capabilities.filter(
      (key) =>
        key !== 'runtime.preview-deployments' &&
        key !== 'platform.data-residency',
    );

    expect(narrowed.capabilities).toEqual(expected);
    expect(narrowed.edition).toBe('enterprise');
  });
});
