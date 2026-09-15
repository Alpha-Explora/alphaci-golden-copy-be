import {
  applyClientPolicy,
  assertPolicyAppliesTo,
  parseClientId,
  parseClientPolicyDocument,
} from './client-policy.js';
import { PACK_MANIFESTS } from './manifests.js';

const validDocument = {
  clientId: 'northwind',
  displayName: 'Northwind Industries',
  edition: 'enterprise',
  disabledCapabilities: ['runtime.preview-deployments'],
};

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

describe('parseClientPolicyDocument', () => {
  it('accepts a valid document', () => {
    expect(parseClientPolicyDocument(validDocument, 'test')).toEqual({
      clientId: 'northwind',
      displayName: 'Northwind Industries',
      edition: 'enterprise',
      disabledCapabilities: ['runtime.preview-deployments'],
    });
  });

  it('falls back to the client id when no display name is given', () => {
    const policy = parseClientPolicyDocument(
      { ...validDocument, displayName: '  ' },
      'test',
    );

    expect(policy.displayName).toBe('northwind');
  });

  it('rejects a field that would add rather than remove', () => {
    expect(() =>
      parseClientPolicyDocument(
        { ...validDocument, enabledCapabilities: ['identity.sso-scim'] },
        'test',
      ),
    ).toThrow(/may only remove capabilities/);
  });

  it('rejects a document that is not an object', () => {
    expect(() => parseClientPolicyDocument([], 'test')).toThrow(
      /must contain a JSON object/,
    );
    expect(() => parseClientPolicyDocument(null, 'test')).toThrow(
      /must contain a JSON object/,
    );
  });

  it('rejects an unknown edition, an unknown key, and a repeated key', () => {
    expect(() =>
      parseClientPolicyDocument(
        { ...validDocument, edition: 'partner' },
        'test',
      ),
    ).toThrow(/invalid edition/);
    expect(() =>
      parseClientPolicyDocument(
        { ...validDocument, disabledCapabilities: ['runtime.teleporter'] },
        'test',
      ),
    ).toThrow(/unknown capability/);
    expect(() =>
      parseClientPolicyDocument(
        {
          ...validDocument,
          disabledCapabilities: [
            'runtime.preview-deployments',
            'runtime.preview-deployments',
          ],
        },
        'test',
      ),
    ).toThrow(/twice/);
  });

  it('requires disabledCapabilities to be an array of strings', () => {
    expect(() =>
      parseClientPolicyDocument(
        { ...validDocument, disabledCapabilities: 'all' },
        'test',
      ),
    ).toThrow(/as an array/);
    expect(() =>
      parseClientPolicyDocument(
        { ...validDocument, disabledCapabilities: [7] },
        'test',
      ),
    ).toThrow(/non-string capability key/);
  });
});

describe('assertPolicyAppliesTo', () => {
  it('rejects a policy written for another edition', () => {
    const policy = parseClientPolicyDocument(validDocument, 'test');

    expect(() =>
      assertPolicyAppliesTo(policy, PACK_MANIFESTS.edu, 'test'),
    ).toThrow(/declares edition 'enterprise' but this deployment runs 'edu'/);
  });

  it('rejects removing a capability the edition never had', () => {
    const policy = parseClientPolicyDocument(
      { ...validDocument, disabledCapabilities: ['identity.lms-lti'] },
      'test',
    );

    expect(() =>
      assertPolicyAppliesTo(policy, PACK_MANIFESTS.enterprise, 'test'),
    ).toThrow(/does not contain/);
  });
});

describe('applyClientPolicy', () => {
  it('returns the same manifest when nothing is narrowed', () => {
    const empty = parseClientPolicyDocument(
      { ...validDocument, disabledCapabilities: [] },
      'test',
    );

    expect(applyClientPolicy(PACK_MANIFESTS.enterprise, null)).toBe(
      PACK_MANIFESTS.enterprise,
    );
    expect(applyClientPolicy(PACK_MANIFESTS.enterprise, empty)).toBe(
      PACK_MANIFESTS.enterprise,
    );
  });

  it('removes only the declared keys and keeps registry order', () => {
    const policy = parseClientPolicyDocument(
      {
        ...validDocument,
        disabledCapabilities: [
          'runtime.preview-deployments',
          'platform.data-residency',
        ],
      },
      'test',
    );
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
